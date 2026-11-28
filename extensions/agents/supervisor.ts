/**
 * §7–§11. The supervisor: what this process knows about the children it fired,
 * how it fires them, and how it stops them.
 *
 * Nothing here is stored except what §9 records. Running, compacting and idle
 * are read from the run driving the child; a child of a process that is gone is
 * idle.
 */

import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

import { parsePiArgs } from "../config/trust.js";
import { assertBaselineTools, baselineExtensions, skillFlags } from "./baseline.js";

import type { AgentDefinition, ThinkingLevel } from "./definitions.js";
import { renderGoal, renderTask } from "./definitions.js";
import { buildChildEnv, ENV, type FeatureSwitches, readToolAllowlist, withoutTaskforceEnv } from "./env.js";
import { type ChildActivity, ChildRun, type PendingAsk, type RunOutcome, type UsageReading } from "./child.js";
import { chooseLaunchModel, type ModelChoice, type ModelLookup, type ParentModel } from "./models.js";
import type { AgentId, AgentRecord } from "./records.js";
import { describeLaunch } from "../prompts/index.js";

export type ChildStatus = "running" | "compacting" | "idle" | "failed";

/** §6. What a child was launched with: the model, and the thinking level on top. */
export interface LaunchChoice {
	model: ModelChoice | null;
	thinking: ThinkingLevel | null;
}

import { CONSULT_ENV } from "../tools/consult.js";

export interface SpawnControls {
	advisor?: string;
	fork: boolean;
	background: boolean;
	thinking: ThinkingLevel | null;
}

export interface SpawnRequest {
	definition: AgentDefinition;
	args: Record<string, unknown>;
	goal?: string;
	controls: SpawnControls;
}

export interface SupervisorContext {
	cwd: string;
	/** The agent this process is. */
	self: AgentRecord;
	features: FeatureSwitches;
	maxDepth: number;
	/** §3, §7. How many children this process may have running at once. */
	maxRunning: number;
	/**
	 * §8. The tool limits this process was started under, read once at load so
	 * nothing that runs later in the process can loosen them for its children.
	 */
	toolLimits?: ToolLimits;
	sharedExtensions?: string[];
	sharedTools?: string[];
	/** Exact eligible catalog captured from the parent's prompt, including explicit-only skills. */
	skillPaths?: string[];
	/** §3. The silence timeout for children whose definition sets none. */
	silenceTimeoutMs: number;
	/** §13. Every spawn from the root down to this process used `fork: true`. */
	forkPath: boolean;
	/** This process's own session file, which is where a child's folder hangs off. */
	sessionFile: string | null;
	/** The path of this extension's entry point, loaded explicitly into every child (§8). */
	extensionEntry: string;
	/** The parent's own appended system prompt, forwarded when the agent asks for it (§6). */
	parentAppendSystemPrompt: string | null;
	/** The agent types this process may spawn, or `null` for all of them (§6). */
	spawnable: string[] | null;
	/** §3, §6. Whether the project's own configuration was read, passed on to every child. */
	projectTrusted?: boolean;
	/** §8. This process's own taskforce prompt, handed to a forked child verbatim. */
	inheritedPrompt: unknown;
	/** §6. This process's model and thinking level right now, inherited by a child that pins none. */
	parentModel?: () => ParentModel;
	/** §6. pi's model registry, which a pinned model must match exactly. */
	models?: () => ModelLookup | null;
}

export interface SupervisorHooks {
	/** Records the child before its process starts (§7, §9). */
	registerChild(record: AgentRecord): void;
	/** The child reported where its transcript lives (§8). */
	recordSessionFile(agentId: AgentId, path: string): void;
	/** The outcome of the child's last run, the one recorded thing about it (§9). */
	recordFailed(agentId: AgentId, failed: boolean): void;
	/** A question arrived from a child and has to be routed (§13). */
	onAsk(agentId: AgentId, pending: PendingAsk): void;
	onConsult?(worker: AgentId, question: string): Promise<string>;
	/** The run ended. */
	onRunEnd(agentId: AgentId, outcome: RunOutcome): void;
	/** Something changed, so the widgets can redraw (§14). */
	onUpdate(): void;
	/** A read-only projection of a child's stream; no observer may alter the run. */
	onActivity?(agentId: AgentId, event: ChildActivity): void;
	/** Whether this process has any children, for the fork note (§8). */
	hasChildren(): boolean;
}

/** §14. How a run ended, so the panel can say which of the two stops happened. */
export interface EndedRun {
	agentId: AgentId;
	type: string;
	how: string;
	at: number;
}

export class Supervisor {
	private readonly runs = new Map<AgentId, ChildRun>();
	private readonly tempDirs: string[] = [];
	private readonly ended: EndedRun[] = [];

	constructor(
		private context: SupervisorContext,
		private readonly hooks: SupervisorHooks,
	) {}

	updateContext(patch: Partial<SupervisorContext>): void {
		this.context = { ...this.context, ...patch };
	}

	get maxDepth(): number {
		return this.context.maxDepth;
	}

	runFor(agentId: AgentId): ChildRun | undefined {
		return this.runs.get(agentId);
	}

	/** §14. The runs that have finished, most recent first. */
	get endedRuns(): readonly EndedRun[] {
		return [...this.ended].reverse();
	}

	private noteEnded(agentId: AgentId, type: string, outcome: RunOutcome): void {
		const how = outcome.failed ? `failed: ${outcome.reason ?? "unknown"}` : (outcome.reason ?? "finished");
		this.ended.push({ agentId, type, how, at: Date.now() });
		if (this.ended.length > 20) this.ended.shift();
	}

	get liveRuns(): Array<{ agentId: AgentId; run: ChildRun }> {
		return [...this.runs]
			.filter(([, run]) => run.isRunning)
			.map(([agentId, run]) => ({ agentId, run }));
	}

	/** §9. Status is read from the run; `failed` is the outcome of the last one. */
	statusOf(record: AgentRecord): ChildStatus {
		const run = this.runs.get(record.uuid);
		if (run?.isRunning) return run.status;
		return record.failed ? "failed" : "idle";
	}

	contextUsageOf(agentId: AgentId): UsageReading | null {
		const run = this.runs.get(agentId);
		return run ? run.contextUsage : null;
	}

	/** §13. The questions waiting on this process right now, in arrival order. */
	waitingAsks(): Array<{ agentId: AgentId; pending: PendingAsk }> {
		const out: Array<{ agentId: AgentId; pending: PendingAsk }> = [];
		for (const [agentId, run] of this.runs) {
			const pending = run.pendingAsk;
			if (pending) out.push({ agentId, pending });
		}
		return out.sort((a, b) => a.pending.arrivedAt - b.pending.arrivedAt);
	}

	// ------------------------------------------------------------- spawning

	/**
	 * §7. The spawn is refused before anything is started when it would exceed the
	 * depth limit or when the caller's `subagents` list does not include the type.
	 */
	checkSpawnable(typeName: string): string | null {
		const self = this.context.self;
		const childDepth = self.depth + 1;
		if (childDepth > this.context.maxDepth) {
			return (
				`You are at depth ${self.depth} of a maximum of ${this.context.maxDepth}, so a subagent ` +
				`you spawn would sit at depth ${childDepth}, past the ceiling. Do this work yourself.`
			);
		}
		const allowed = this.context.spawnable;
		if (allowed !== null && !allowed.includes(typeName)) {
			const list = allowed.length > 0 ? allowed.join(", ") : "none";
			const me = self.type ?? "this agent";
			return `\`${me}\` may not spawn \`${typeName}\`. The types it may spawn are: ${list}.`;
		}
		return this.checkRoom() ?? this.checkTranscriptDir();
	}

	/**
	 * §8. A saved session's child must write its transcript where it can be
	 * restarted from, so a folder that cannot be made safely refuses the start
	 * instead of letting pi fall back to its own default.
	 */
	private checkTranscriptDir(): string | null {
		if (!this.context.sessionFile || this.subagentSessionDir()) return null;
		const folder = join(dirname(this.context.sessionFile), "subagents");
		return (
			`The folder for this session's subagent transcripts under ${folder} could not be created, ` +
			"or is a symlink, so no subagent can start. Do this work yourself, and tell the user."
		);
	}

	/** §7. A start is refused while this process already has its maximum running. */
	private checkRoom(): string | null {
		const running = this.liveRuns.length;
		if (running < this.context.maxRunning) return null;
		return (
			`You already have ${running} subagents running, the most one agent may have at once. ` +
			"Wait for a report, or close one you no longer need, before starting another."
		);
	}

	/**
	 * §9. A transcript path read back from the session is only reopened when it
	 * sits in this session's own `subagents` folder. A session file is data anyone
	 * can edit or hand over, and a path outside that folder would point a restarted
	 * child at somebody else's transcript.
	 */
	transcriptProblem(sessionFile: string | null): string | null {
		if (!sessionFile || !existsSync(sessionFile)) return "its transcript is no longer on disk";
		const dir = this.subagentSessionDir();
		if (!dir) return "this session is not saved to disk, so it has no subagent transcripts";
		try {
			const real = realpathSync(sessionFile);
			if (real.startsWith(dir + sep) && real.endsWith(".jsonl")) return null;
		} catch {
			// Unreadable, so not usable.
		}
		return "its recorded transcript lies outside this session's subagents folder";
	}

	async spawn(request: SpawnRequest, child: AgentRecord): Promise<{ run: ChildRun; task: string }> {
		const definition = request.definition;
		const launch = this.launchChoice(definition, request.controls);
		const task = this.buildTask(definition, request, launch);
		const spec = this.buildLaunchSpec(definition, request, child, task, undefined, launch);

		this.hooks.registerChild(child);

		const run = new ChildRun(spec, {
			onSessionFile: (path) => this.hooks.recordSessionFile(child.uuid, path),
			onAsk: (pending) => this.hooks.onAsk(child.uuid, pending),
			onConsult: (q) => this.hooks.onConsult?.(child.uuid, q),
			onEnd: (outcome) => {
				this.noteEnded(child.uuid, definition.name, outcome);
				this.hooks.recordFailed(child.uuid, outcome.failed);
				this.hooks.onRunEnd(child.uuid, outcome);
			},
			onUpdate: () => this.hooks.onUpdate(),
			onActivity: (event) => this.hooks.onActivity?.(child.uuid, event),
		});
		this.runs.set(child.uuid, run);
		await run.begin();
		return { run, task };
	}

	/**
	 * §9. A message to a child whose process is gone restarts it from its own
	 * transcript first, and the parent is told that it was restarted.
	 */
	async messageChild(
		record: AgentRecord,
		definition: AgentDefinition | null,
		text: string,
		continueMessage: string | null,
	): Promise<{ delivered: boolean; restarted: boolean; error?: string }> {
		const existing = this.runs.get(record.uuid);
		// A child that has just settled is usually about to shut itself down, and a
		// message sent into it then is lost. Give it a moment: if it exits, it is
		// restarted below; if it stays, it is waiting on work of its own and reads
		// the message live.
		if (existing?.isRunning && existing.isIdle) {
			await Promise.race([existing.waitForEnd(), new Promise((resolve) => setTimeout(resolve, 2_000))]);
		}
		if (existing?.isRunning) {
			const ok = await existing.message(text);
			return { delivered: ok, restarted: false };
		}
		const transcript = this.transcriptProblem(record.sessionFile);
		if (transcript || !record.sessionFile) {
			return {
				delivered: false,
				restarted: false,
				error: `that subagent cannot be restarted: ${transcript}. Spawn a new subagent instead.`,
			};
		}
		const room = this.checkRoom();
		if (room) return { delivered: false, restarted: false, error: room };
		if (!definition) {
			return {
				delivered: false,
				restarted: false,
				error:
					`that subagent's type \`${record.type ?? "unknown"}\` is no longer in the catalog; its ` +
					"definition may have been removed or renamed.",
			};
		}

		// §9. A restarted child is launched exactly as it was the first time, with
		// its own session file reopened instead of a new one.
		const controls = { fork: record.forked, background: true, thinking: null };
		const launch = this.launchChoice(definition, controls);
		const spec = this.buildLaunchSpec(
			definition,
			{ definition, args: {}, controls },
			record,
			[continueMessage, text].filter((part): part is string => Boolean(part)).join("\n\n"),
			record.sessionFile,
			launch,
		);
		const run = new ChildRun(spec, {
			onSessionFile: (path) => this.hooks.recordSessionFile(record.uuid, path),
			onAsk: (pending) => this.hooks.onAsk(record.uuid, pending),
			onConsult: (q) => this.hooks.onConsult?.(record.uuid, q),
			onEnd: (outcome) => {
				this.noteEnded(record.uuid, record.type ?? definition.name, outcome);
				this.hooks.recordFailed(record.uuid, outcome.failed);
				this.hooks.onRunEnd(record.uuid, outcome);
			},
			onUpdate: () => this.hooks.onUpdate(),
			onActivity: (event) => this.hooks.onActivity?.(record.uuid, event),
		});
		this.runs.set(record.uuid, run);
		await run.begin();
		return { delivered: true, restarted: true };
	}

	/** §9. Closing stops the child's process; its own shutdown stops its children (§8). */
	async close(agent: AgentRecord, reason: string): Promise<boolean> {
		const run = this.runs.get(agent.uuid);
		if (!run?.isRunning) return false;
		await run.stop(reason.trim() ? `closed by its parent: ${reason.trim()}` : "closed by its parent");
		return true;
	}

	/** §11. A slash command and a keyboard shortcut stop every child. */
	async stopAll(reason: string): Promise<number> {
		let stopped = 0;
		for (const [, run] of this.runs) {
			if (!run.isRunning) continue;
			await run.stop(reason);
			stopped++;
		}
		return stopped;
	}

	/** The instruction files handed to children live only as long as this process. */
	cleanUp(): void {
		for (const dir of this.tempDirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A temp directory that will not go is not worth failing a shutdown for.
			}
		}
	}

	// ------------------------------------------------------------- launching

	private buildTask(
		definition: AgentDefinition,
		request: SpawnRequest,
		launch: LaunchChoice | null,
	): string {
		const body = request.goal === undefined
			? renderTask(definition, request.args)
			: renderGoal(definition, request.goal);
		// §6. A non-forked child is told what it runs on, so its model is a fact in
		// its context rather than something it has to go and look up.
		if (!request.controls.fork) {
			const named = launch?.model ? describeLaunch(launch.model, launch.thinking) : null;
			return named ? `You are running on ${named}.\n\n${body}` : body;
		}

		// §8. A forked child's leading user message carries the specialization the
		// omitted prompt flags would otherwise have carried.
		const blocks: string[] = [];
		const instructions = [definition.identity, definition.appendSystemPrompt]
			.filter((part): part is string => Boolean(part))
			.join("\n\n");
		if (instructions) blocks.push(instructions);
		blocks.push(
			[
				`You are a forked subagent of type \`${definition.name}\`. The conversation above is context you ` +
					"were handed: it is a copy of your parent's conversation, not your own history.",
				`You sit at depth ${this.context.self.depth + 1} of a maximum of ${this.context.maxDepth}.`,
			].join(" "),
		);
		if (this.context.self.depth + 1 >= this.context.maxDepth) {
			blocks.push(
				"You are at the maximum depth, so you cannot spawn subagents of your own, whatever the " +
					"conversation above says about spawning.",
			);
		}
		if (definition.tools.length > 0) {
			blocks.push(`The pi tools you may call are: ${this.toolAllowlist(definition)!.join(", ")}.`);
		}
		blocks.push(
			"Any TODO lists in the conversation above are your parent's. Do not edit them; put your progress in your final message.",
		);
		if (this.hooks.hasChildren()) {
			blocks.push(
				"The subagents named in the conversation above are your parent's, not yours. Do not address them.",
			);
		}
		blocks.push(
			"When you stop, your final message is your report to your parent, so put the whole result in it: " +
				"what you found or changed, how you checked it, and anything left open.",
		);
		blocks.push(`Your task:\n${body}`);
		return blocks.join("\n\n");
	}

	private buildLaunchSpec(
		definition: AgentDefinition,
		request: SpawnRequest,
		child: AgentRecord,
		task: string,
		resumeSessionFile?: string,
		launch?: LaunchChoice | null,
	): {
		command: string;
		args: string[];
		cwd: string;
		env: NodeJS.ProcessEnv;
		task: string;
		silenceTimeoutMs: number;
		timeoutMs: number;
		model: ModelChoice | null;
		thinking: ThinkingLevel | null;
	} {
		const args = ["--mode", "rpc"];
		const sessionDir = this.subagentSessionDir();
		if (sessionDir) args.push("--session-dir", sessionDir);
		else if (this.context.sessionFile) throw new Error(this.checkTranscriptDir() ?? "no transcript folder");

		if (resumeSessionFile) {
			args.push("--session", resumeSessionFile);
		} else if (request.controls.fork) {
			// §8. A forked child is started from the parent's session file, with no
			// prompt flags at all: every flag omitted is a flag that would change the
			// child's system prompt and cost the provider's prompt cache.
			const parentSession = this.context.sessionFile;
			if (parentSession) args.push("--fork", parentSession);
		}

		// §8. The tool limits this process runs under bind every child it starts.
		const own = this.context.toolLimits ?? NO_TOOL_LIMITS;
		assertBaselineTools(this.context.sharedTools ?? [], own);
		const shared = baselineExtensions(this.context.sharedExtensions ?? []);
		args.push(...skillFlags(this.context.skillPaths));
		let forkAllowlist: string[] | null = null;

		if (request.controls.fork) {
			// §8. A forked child is started with no prompt flags at all, because
			// every flag omitted is a flag that would change its system prompt and
			// cost the provider's prompt cache. Which extensions load is not a prompt
			// flag but it does decide the tool roster, and the roster is exactly what
			// has to stay identical, so the child is given this process's own
			// extension and tool flags rather than a set of its own.
			args.push(...ownExtensionFlags(), ...own.flags);
			// The agent's own allowlist cannot become a flag without changing the
			// prompt, so the child enforces it on every call instead.
			forkAllowlist = intersectAllowlists(own.enforced, this.toolAllowlist(definition));
		} else {
			// §8. Automatic extension discovery is off, and the harness loads
			// pi-taskforce plus the extensions the agent's own field selects.
			args.push("--no-extensions", "-e", this.context.extensionEntry);
			for (const path of this.resolveExtensions(definition.extensions)) {
				args.push("-e", path);
			}
			const instructions = this.instructionsFile(definition);
			if (instructions) args.push("--append-system-prompt", instructions);
			let tools = intersectAllowlists(
				intersectAllowlists(own.allow, own.enforced),
				this.toolAllowlist(definition, !!child.advisor),
			);
			// pi lets an explicit `--tools` list override `--no-builtin-tools`, so a
			// parent without pi's own tools must not hand them to a child by name.
			if (tools && own.noBuiltinTools) tools = tools.filter((name) => !BUILTIN_TOOLS.has(name));
			if (tools) args.push("--tools", tools.join(","));
			args.push(...own.restrictions);
			// §6. The model is always named exactly, with its provider, so pi never
			// matches it fuzzily and never falls back to its own default model. A pinned
			// model that does not resolve was reported at session start, and the child
			// runs on its parent's model and thinking level instead.
			const resolved = launch ?? this.launchChoice(definition, request.controls);
			if (resolved) {
				if (resolved.model) args.push("--provider", resolved.model.provider, "--model", resolved.model.id);
				if (resolved.thinking) args.push("--thinking", resolved.thinking);
			}
		}

		// Required infrastructure is independent of fork and applies on resume too.
		const explicit = new Set<string>();
		for (let i = 0; i < args.length - 1; i++) {
			if (args[i] !== "-e") continue;
			try { explicit.add(realpathSync(args[i + 1]!)); } catch { explicit.add(args[i + 1]!); }
		}
		for (const path of shared) {
			if (!explicit.has(path)) { args.push("-e", path); explicit.add(path); }
		}

		// §8. Nothing this process was told about itself is passed on: the child is
		// told only what its own launch sets.
		const env: NodeJS.ProcessEnv = {
			...withoutTaskforceEnv(process.env),
			...buildChildEnv({
				agentId: child.uuid,
				parentId: this.context.self.uuid,
				agentType: definition.name,
				depth: child.depth,
				maxDepth: this.context.maxDepth,
				maxRunning: this.context.maxRunning,
				silenceTimeoutMs: this.context.silenceTimeoutMs,
				features: this.context.features,
				forked: request.controls.fork,
				forkPath: request.controls.fork && this.context.forkPath,
				spawnable: definition.subagents,
				projectTrusted: this.context.projectTrusted ?? false,
				tools: forkAllowlist,
			}),
		};
		if (child.advisor) env[CONSULT_ENV] = "1";
		if (definition.identity) env[ENV_IDENTITY] = definition.identity;
		if (!definition.piDocs) env[ENV_NO_PI_DOCS] = "1";
		// §16, §8. A forked child's prompt is its parent's, verbatim, so the parent
		// hands over the exact text and the exact registration decisions rather than
		// letting the child derive its own and cost the provider's prompt cache.
		if (request.controls.fork && this.context.inheritedPrompt) {
			env.PI_TASKFORCE_PROMPT = JSON.stringify(this.context.inheritedPrompt);
		}

		const resolved = launch ?? this.launchChoice(definition, request.controls);

		return {
			// The same pi this process is running, so a child cannot pick up a
			// different version or a shell alias.
			command: process.execPath,
			args: [piEntryPoint(), ...args],
			cwd: this.context.cwd,
			env,
			task,
			silenceTimeoutMs: definition.silenceTimeoutMs ?? this.context.silenceTimeoutMs,
			timeoutMs: definition.timeoutMs,
			model: resolved?.model ?? null,
			thinking: resolved?.thinking ?? null,
		};
	}

	/**
	 * §6. The model a non-forked child is launched with, resolved once here so the
	 * flags, the child's own prompt and the parent's report all name the same
	 * thing. A forked child carries its parent's prompt and model, so it has none.
	 */
	private launchChoice(definition: AgentDefinition, controls: SpawnControls): LaunchChoice | null {
		if (controls.fork) return null;
		return chooseLaunchModel(
			definition.model,
			controls.thinking ?? definition.thinking,
			this.context.parentModel?.() ?? { model: null, thinking: null },
			this.context.models?.() ?? null,
		);
	}

	/**
	 * §8. When an agent declares a `tools` allowlist, the extension's own tools
	 * are added back to it: leaving them out strips a child of `ask` and `delegate`.
	 */
	private toolAllowlist(definition: AgentDefinition, consult = false): string[] | null {
		if (definition.tools.length === 0) return null;
		const ours = [
			...(consult ? ["consultAdvisor"] : []),
			"listSubagents",
			"messageSubagent",
			"closeSubagent",
			"delegate",
			"ask",
			"answer_subagent",
		];
		return [...new Set([...definition.tools, ...ours, ...(this.context.sharedTools ?? [])])];
	}

	private instructionsFile(definition: AgentDefinition): string | null {
		const parts: string[] = [];
		if (definition.promptGuidelines.length > 0) {
			parts.push(definition.promptGuidelines.map((line) => `- ${line}`).join("\n"));
		}
		if (definition.appendSystemPrompt) parts.push(definition.appendSystemPrompt);
		if (definition.includeParentAppendSystemPrompt && this.context.parentAppendSystemPrompt) {
			parts.push(this.context.parentAppendSystemPrompt);
		}
		if (parts.length === 0) return null;
		const dir = mkdtempSync(join(tmpdir(), "pi-taskforce-"));
		this.tempDirs.push(dir);
		const path = join(dir, `${definition.name}.md`);
		writeFileSync(path, `${parts.join("\n\n")}\n`, "utf8");
		return path;
	}

	/**
	 * §6. `extensions` selects the extensions to load in the child by a file
	 * path or by a bare name pi keeps in the agent's extension folders. A leading
	 * `~` means the user's home. A reference that cannot be resolved to a file is
	 * reported rather than silently dropped.
	 */
	private resolveExtensions(references: string[]): string[] {
		const out: string[] = [];
		for (const reference of references) {
			const path = resolveExtensionReference(reference, this.context.cwd, this.context.projectTrusted ?? false);
			if (path) out.push(path);
			else this.unresolved.push(reference);
		}
		return out;
	}

	readonly unresolved: string[] = [];

	/**
	 * §8. A child writes its transcript into `subagents/<parent session>/` beside
	 * the parent's own transcript, one folder per parent session. The path is
	 * returned resolved, and refused when any part below the parent's own folder is
	 * a symlink, so a transcript is only ever this session's.
	 */
	private subagentSessionDir(): string | null {
		const own = this.context.sessionFile;
		if (!own) return null;
		const dir = join(dirname(own), "subagents", basename(own, ".jsonl"));
		try {
			mkdirSync(dir, { recursive: true });
			const expected = join(realpathSync(dirname(own)), "subagents", basename(own, ".jsonl"));
			return realpathSync(dir) === expected ? expected : null;
		} catch {
			return null;
		}
	}
}

const ENV_IDENTITY = "PI_TASKFORCE_IDENTITY";
const ENV_NO_PI_DOCS = "PI_TASKFORCE_NO_PI_DOCS";

export { ENV_IDENTITY, ENV_NO_PI_DOCS };

/**
 * The extension flags this process was itself started with, so a forked child
 * loads the same set and ends up with the same tool roster (§8). Anything else
 * would give it a different prompt from the conversation it was handed.
 */
export function ownExtensionFlags(argv: readonly string[] = process.argv): string[] {
	const parsed = parsePiArgs(argv);
	const out: string[] = [];
	if (parsed.noExtensions) out.push("--no-extensions");
	for (const path of parsed.extensions ?? []) out.push("-e", path);
	return out;
}

/** pi's own tools, which `--no-builtin-tools` switches off. */
const BUILTIN_TOOLS = new Set(["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]);

export interface ToolLimits {
	/** This process's own `--tools` list as pi reads it, or `null` for none. */
	allow: string[] | null;
	/** Started with `--no-builtin-tools` and no `--tools` list to override it. */
	noBuiltinTools: boolean;
	/** The allowlist this process enforces on itself as a forked child, or `null`. */
	enforced: string[] | null;
	/** The flags that narrow tools other than `--tools`, passed on as they are. */
	restrictions: string[];
	/** Every tool flag this process was started with, for a fork's identical roster. */
	flags: string[];
}

/**
 * §8. The tool limits this process runs under, read the way pi reads them. A
 * child never gets a tool its parent was denied: a fork inherits the flags as
 * they are, and any other child gets the intersection.
 */
export function ownToolLimits(
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): ToolLimits {
	const parsed = parsePiArgs(argv);
	const restrictions: string[] = [];
	if (parsed.noTools) restrictions.push("--no-tools");
	if (parsed.noBuiltinTools) restrictions.push("--no-builtin-tools");
	if (parsed.excludeTools?.length) restrictions.push("--exclude-tools", parsed.excludeTools.join(","));
	// pi gives `--tools` precedence over `--no-tools`; without it, `--no-tools` allows nothing.
	const allow = parsed.tools ?? (parsed.noTools ? [] : null);
	const flags = parsed.tools ? ["--tools", parsed.tools.join(","), ...restrictions] : restrictions;
	return Object.freeze({
		allow: freezeList(allow),
		noBuiltinTools: Boolean(parsed.noBuiltinTools) && !parsed.tools,
		enforced: freezeList(readToolAllowlist(env)),
		restrictions: freezeList(restrictions),
		flags: freezeList(flags),
	}) as ToolLimits;
}

function freezeList<T extends string[] | null>(list: T): T {
	return (list ? Object.freeze([...list]) : list) as T;
}

const NO_TOOL_LIMITS: ToolLimits = Object.freeze({
	allow: null,
	noBuiltinTools: false,
	enforced: null,
	restrictions: [],
	flags: [],
}) as ToolLimits;

/** Two allowlists combined; `null` means unrestricted. */
export function intersectAllowlists(a: string[] | null, b: string[] | null): string[] | null {
	if (a === null) return b;
	if (b === null) return a;
	return a.filter((name) => b.includes(name));
}

/** The pi CLI this process was started from, so a child runs the same build. */
export function piEntryPoint(): string {
	const entry = process.argv[1];
	return entry ?? "pi";
}

/**
 * §6. A path relative to the project, and a bare name looked up in the
 * project's `.pi/extensions`, name files the project supplies. Those are code, so
 * they are only resolved in a trusted project (`config/trust.ts`). An absolute
 * path, a `~/` path and the user's own extension folders always resolve.
 */
export function resolveExtensionReference(reference: string, cwd: string, projectTrusted: boolean): string | null {
	const home = process.env.HOME ?? "";
	const path = reference.startsWith("~/") ? join(home, reference.slice(2)) : reference;
	const candidates: string[] = [];
	if (isAbsolute(path)) candidates.push(path);
	else if (projectTrusted) {
		candidates.push(
			join(cwd, path),
			join(cwd, ".pi", "extensions", `${reference}.ts`),
			join(cwd, ".pi", "extensions", reference, "index.ts"),
		);
	}
	if (home) {
		candidates.push(
			join(home, ".pi", "agent", "extensions", `${reference}.ts`),
			join(home, ".pi", "agent", "extensions", reference, "index.ts"),
			join(home, ".pi", "packages", reference, "extensions", "index.ts"),
		);
	}
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}

export type { PendingAsk, RunOutcome, UsageReading };
export { ENV };
