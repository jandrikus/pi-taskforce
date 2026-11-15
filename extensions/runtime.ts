/**
 * The state one pi process holds while pi-taskforce is loaded in it.
 *
 * Every agent runs its own pi process with the extension loaded, so this object
 * exists in a root and in every child. A root reads its settings; a child is
 * told its identity and switches through its environment (§8).
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { type Catalog, loadCatalog } from "./agents/definitions.js";
import { type ChildIdentity, type FeatureSwitches, readChildIdentity } from "./agents/env.js";
import type { ModelLookup, ParentModel } from "./agents/models.js";
import { type AgentRecord, ChildRecords } from "./agents/records.js";
import { ownToolLimits, Supervisor, type SupervisorHooks, type ToolLimits } from "./agents/supervisor.js";
import { type Settings, loadSettings } from "./config/settings.js";
import { projectConfigTrusted } from "./config/trust.js";

export const CONFIG_DIR = ".pi";

/**
 * §8, §15. What a forked child reproduces of its parent's prompt. Its prompt is
 * its parent's, verbatim, so the parent hands over the exact text and the exact
 * registration decisions rather than the child deriving its own.
 */
export interface InheritedPrompt {
	appended: string;
	subagentText: boolean;
	registerRoster: boolean;
	snippetTypes: string[];
}

export const ENV_INHERITED_PROMPT = "PI_TASKFORCE_PROMPT";

function readInheritedPrompt(): InheritedPrompt | null {
	const raw = process.env[ENV_INHERITED_PROMPT];
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as InheritedPrompt;
		return typeof parsed?.appended === "string" ? parsed : null;
	} catch {
		return null;
	}
}

export class Taskforce {
	settings: Settings;
	identity: ChildIdentity | null;
	catalog: Catalog;
	supervisor: Supervisor | null = null;
	/** §6. Definitions whose pinned model will not be used, found at session start. */
	modelProblems: string[] = [];
	/** The agent this process is. A root's uuid is its session id. */
	self: AgentRecord;
	/** §9. The children this agent has spawned, from its own session. */
	readonly children: ChildRecords;
	/** §8, §15. For a forked child, the prompt its parent had. */
	readonly inheritedPrompt: InheritedPrompt | null;
	/** §3, §6. Whether this project's own settings and agent definitions were read. */
	readonly projectTrusted: boolean;
	/** §8. The tool limits this process started under, read once, here, at load. */
	readonly toolLimits: ToolLimits;

	constructor(
		readonly cwd: string,
		appendEntry: (record: AgentRecord) => void = () => {},
		options: { projectTrusted?: boolean } = {},
	) {
		this.identity = readChildIdentity();
		this.toolLimits = ownToolLimits();
		// A child follows the root's decision, which the root passes down (§8).
		this.projectTrusted =
			options.projectTrusted ?? (this.identity ? this.identity.projectTrusted : projectConfigTrusted(cwd));
		this.settings = loadSettings(cwd, CONFIG_DIR, this.projectTrusted);
		this.inheritedPrompt = readInheritedPrompt();
		this.catalog = loadCatalog(
			join(homedir(), CONFIG_DIR, "agents"),
			this.projectTrusted ? join(cwd, CONFIG_DIR, "agents") : null,
			this.settings.subagents.agentDirs,
		);
		this.children = new ChildRecords(appendEntry);
		this.self = this.identity
			? {
					uuid: this.identity.agentId,
					parentUuid: this.identity.parentId,
					type: this.identity.agentType,
					failed: false,
					sessionFile: null,
					spawnedAt: Date.now(),
					depth: this.identity.depth,
					forked: this.identity.forked,
				}
			: {
					uuid: "root",
					parentUuid: null,
					type: null,
					failed: false,
					sessionFile: null,
					spawnedAt: Date.now(),
					depth: 1,
					forked: false,
				};
	}

	get isRoot(): boolean {
		return this.identity === null;
	}

	/** §3. A child follows the switches of the session that spawned it. */
	get features(): FeatureSwitches {
		if (this.identity) return this.identity.features;
		return {
			todos: this.settings.todos.enabled,
			subagents: this.settings.subagents.enabled,
			ask: this.settings.ask.enabled,
		};
	}

	get maxDepth(): number {
		return this.identity?.maxDepth ?? this.settings.subagents.maxDepth;
	}

	/** §3, §7. A child follows its root's limit, like the depth. */
	get maxRunning(): number {
		return this.identity?.maxRunning ?? this.settings.subagents.maxRunning;
	}

	get depth(): number {
		return this.identity?.depth ?? 1;
	}

	get silenceTimeoutMs(): number {
		return this.identity?.silenceTimeoutMs ?? this.settings.subagents.silenceTimeoutMs;
	}

	/** §13. Every spawn from the root down to this agent used `fork: true`. */
	get asksUserDirectly(): boolean {
		return this.isRoot || (this.identity?.forkPath ?? false);
	}

	/** A root learns its uuid and session file once its session starts. */
	bindSession(sessionId: string | null, sessionFile: string | null): void {
		if (this.isRoot && sessionId) this.self = { ...this.self, uuid: sessionId };
		this.self = { ...this.self, sessionFile };
		this.supervisor?.updateContext({ self: this.self, sessionFile });
	}

	/** The supervisor is built once; a new session only rebinds it. */
	buildSupervisor(options: {
		extensionEntry: string;
		ownPrompt: InheritedPrompt;
		hooks: SupervisorHooks;
		parentModel: () => ParentModel;
		models: () => ModelLookup | null;
	}): Supervisor {
		this.supervisor ??= new Supervisor(
			{
				cwd: this.cwd,
				self: this.self,
				features: this.features,
				maxDepth: this.maxDepth,
				maxRunning: this.maxRunning,
				toolLimits: this.toolLimits,
				sharedExtensions: this.settings.subagents.sharedExtensions,
				sharedTools: this.settings.subagents.sharedTools,
				silenceTimeoutMs: this.silenceTimeoutMs,
				forkPath: this.asksUserDirectly,
				sessionFile: this.self.sessionFile,
				extensionEntry: options.extensionEntry,
				parentAppendSystemPrompt: null,
				spawnable: this.identity?.spawnable ?? null,
				projectTrusted: this.projectTrusted,
				inheritedPrompt: options.ownPrompt,
				parentModel: options.parentModel,
				models: options.models,
			},
			options.hooks,
		);
		return this.supervisor;
	}
}
