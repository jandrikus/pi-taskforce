/**
 * pi-taskforce: TODO lists as plain Markdown files, subagents, and asking.
 *
 * This file is only wiring (§18). The layers underneath:
 *   todos/     the directory rule, the parser and the watcher
 *   agents/    definitions, the child processes, and what a parent does with them
 *   ask/       the question, where it goes, and the two surfaces that show it
 *   tools/     what the model can call
 *   prompts/   what the model reads
 *   ui/        what the user sees
 */

import { fileURLToPath } from "node:url";

import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type KeyId, Text } from "@earendil-works/pi-tui";

import { AskBroker } from "./ask/broker.js";
import { Orchestration, REPORT_MESSAGE } from "./agents/orchestration.js";
import { type ModelChoice, modelProblems, type ModelLookup } from "./agents/models.js";
import { projectConfigFiles } from "./config/trust.js";
import { CostFeature } from "./costs/feature.js";
import { StatsFeature } from "./stats/feature.js";
import { ObserveFeature } from "./observe/feature.js";
import { CHILD_ENTRY } from "./agents/records.js";
import { ENV_IDENTITY, ENV_NO_PI_DOCS } from "./agents/supervisor.js";
import * as prompts from "./prompts/index.js";
import { type InheritedPrompt, Taskforce } from "./runtime.js";
import { type SessionRef, todoDir } from "./todos/dir.js";
import { copyOpenLists, TodoWatcher } from "./todos/watcher.js";
import { registerAskTools } from "./tools/ask.js";
import { registerSpawnTools } from "./tools/spawn.js";
import { registerSubagentTools } from "./tools/subagents.js";
import { openPanel } from "./ui/panel.js";
import { listingText, TodoWidget } from "./ui/todos.js";

const EXTENSION_ENTRY = fileURLToPath(import.meta.url);
const QUESTION_MESSAGE = "pi-taskforce-question";

export default function (pi: ExtensionAPI) {
	const tf = new Taskforce(process.cwd(), (record) => pi.appendEntry(CHILD_ENTRY, record));
	const features = tf.features;

	let ctxRef: ExtensionContext | null = null;
	// §6. What a child that pins no model inherits, kept apart from ctxRef, which
	// is dropped whenever a surface cannot be drawn.
	let currentModel: ModelChoice | null = null;
	let modelRegistry: ModelLookup | null = null;

	// §4, §5. Only a root keeps TODO lists, so only a root watches them. Its
	// directory belongs to its session, which is known once the session starts.
	const todos = tf.isRoot && features.todos ? new TodoWatcher(() => onChange()) : null;
	const sessionTodoDir = (session: SessionRef): string =>
		todoDir(tf.cwd, getAgentDir(), tf.settings.todos.dir, session);
	const todoWidget = todos ? new TodoWidget(todos, tf.settings.todos.widget) : null;

	// §14. A root session's cost view includes every recorded descendant. It is
	// kept here, not in the footer, so pi-footer and the built-in footer can keep
	// doing their own root-only accounting.
	const costs = tf.isRoot
		? new CostFeature({ getLive: () => (tf.supervisor?.liveRuns.length ?? 0) > 0 })
		: null;
	// §14. The read-only snapshot and `/stats`; the cost totals it reports are the
	// same cached ones as `/cost`, not a second accounting.
	const stats = costs ? new StatsFeature({ tf, costs, todos }) : null;
	// §9. A read-only view of this process's subagents for Pilot. It reads the
	// same runs and records; it cannot start, stop, steer or answer anything.
	const observe = new ObserveFeature({ tf });

	// Every surface update goes through here. A context that has been replaced or
	// torn down is not drawn on: pi throws on a stale one, and a widget that cannot
	// be redrawn is not a reason to fail a turn.
	const onChange = (): void => {
		try {
			todoWidget?.refresh(ctxRef);
			refreshRunWidget(tf, ctxRef);
			refreshQuestionStatus(
				ctxRef,
				broker.waitingCount + broker.recoveredCount,
				broker.hiddenCount,
			);
			stats?.touch();
		} catch {
			ctxRef = null;
		}
	};

	const broker = new AskBroker(pi, tf, {
		// §13. A background child's question arrives like a report: after the
		// current run, starting a turn when the parent is idle.
		wake: (message) => {
			pi.sendMessage(
				{ customType: QUESTION_MESSAGE, content: message, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		},
		onChange: () => onChange(),
	});

	const orchestration = new Orchestration(pi, tf, broker, onChange);

	// ---------------------------------------------------------- registration

	// §7, §15. What this agent reads about spawning. A forked child reproduces its
	// parent's decisions rather than deriving its own, because its prompt is its
	// parent's, verbatim (§8).
	const inherited = tf.inheritedPrompt;
	const spawnable = tf.identity?.spawnable ?? null;
	const canSpawnSomething = features.subagents && tf.depth < tf.maxDepth && spawnable?.length !== 0;

	const promptPlan: InheritedPrompt = inherited ?? {
		appended: "",
		subagentText: canSpawnSomething,
		registerRoster: canSpawnSomething,
		snippetTypes: spawnable ?? [...tf.catalog.byName.keys()],
	};
	// The appended prompt is fixed for the life of the session, so the provider's
	// prompt cache holds (§5, §15). pi loads this extension afresh for every
	// session, and a root's TODO directory is known at session start, so its prompt
	// is built there.
	if (inherited) promptPlan.appended = inherited.appended;
	else if (!todos) promptPlan.appended = buildAppendedPrompt(tf, promptPlan, null);

	// §3. A switched-off feature registers no tools and adds no prompt text.
	if (features.subagents) {
		registerSubagentTools(pi, tf, orchestration, { withPromptText: promptPlan.subagentText });
		registerSpawnTools(pi, tf, orchestration, {
			allowed: (name) => promptPlan.snippetTypes.includes(name),
			registerRoster: promptPlan.registerRoster,
		});
	}
	registerAskTools(pi, broker, { ask: features.ask });
	costs?.register(pi);
	stats?.register(pi);
	// Before any session starts, so a request cannot race the listener's setup.
	stats?.start(pi);
	observe?.start(pi);

	// §13. The record of every exchange: an entry, not a message, so it never
	// enters the context the model reads.
	pi.registerEntryRenderer("pi-taskforce-ask", (entry, _options, theme) => {
		const data = entry.data as {
			from?: { agentType?: string; agentId?: string };
			questions?: Array<{ prompt?: string }>;
			howAnswered?: string;
			waitedMs?: number;
		};
		const origin = data.from?.agentType;
		const waited = data.waitedMs ? ` after ${Math.round(data.waitedMs / 1000)}s` : "";
		const lines = [
			theme.fg("accent", origin ? `question from ${origin}` : "question"),
			...(data.questions ?? []).map((question) => theme.fg("muted", `  ${question.prompt ?? ""}`)),
			theme.fg("dim", `  ${data.howAnswered ?? ""}${waited}`),
		];
		return new Text(lines.join("\n"), 0, 0);
	});

	// ------------------------------------------------------------- lifecycle

	pi.on("session_start", async (event, ctx) => {
		ctxRef = ctx;
		broker.useContext(ctx);
		if (!tf.isRoot) {
			const active = new Set(pi.getActiveTools());
			const missing = tf.settings.subagents.sharedTools.filter((name) => !active.has(name));
			if (missing.length > 0) {
				process.stderr.write(`pi-taskforce: required child tools unavailable: ${missing.join(", ")}\n`);
				ctx.shutdown();
				return;
			}
		}
		currentModel = ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null;
		modelRegistry = ctx.modelRegistry;
		// §6. A pinned model is checked once, here, against the exact `provider/id`.
		// One that does not resolve is named so it can be fixed, and its children run
		// on the parent's model meanwhile. A child does not repeat the warning.
		tf.modelProblems = modelProblems(tf.catalog.byName.values(), ctx.modelRegistry);
		// §3, §6. A project's own agents and settings are code and are skipped
		// unless the project was trusted on purpose; the user is told how to allow them.
		const skipped = tf.isRoot && !tf.projectTrusted ? projectConfigFiles(tf.cwd) : [];
		if (skipped.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				[
					"pi-taskforce: this project is not trusted, so its own configuration was not read:",
					...skipped.map((path) => `  ${path}`),
					"Save a trust decision with /trust and restart pi, or start pi with --approve.",
				].join("\n"),
				"warning",
			);
		}
		if (tf.isRoot && tf.modelProblems.length > 0 && ctx.hasUI) {
			ctx.ui.notify(
				[
					"pi-taskforce: these agent types will run on the parent's model until their `model` is fixed:",
					...tf.modelProblems.map((line) => `  ${line}`),
				].join("\n"),
				"warning",
			);
		}
		tf.bindSession(ctx.sessionManager.getSessionId() ?? null, ctx.sessionManager.getSessionFile() ?? null);
		// §9. The children this agent can address are read from its own branch.
		tf.children.load(ctx.sessionManager.getBranch());
		// §12. A question an earlier process asked and never finished is offered
		// again, with the draft it had. The widget and the phone bridge are the same
		// ones a live ask uses; only the delivery differs.
		const recovered = broker.restore(ctx);
		if (recovered > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`pi-taskforce: ${recovered} unanswered question${recovered === 1 ? " was" : "s were"} recovered from the previous run. /questions opens ${recovered === 1 ? "it" : "them"}.`,
				"info",
			);
		}
		costs?.bind(ctx);
		stats?.bind(ctx);
		observe?.bind(ctx);

		tf.buildSupervisor({
			extensionEntry: EXTENSION_ENTRY,
			ownPrompt: promptPlan,
			hooks: {
				registerChild: (record) => tf.children.add(record),
				recordSessionFile: (agentId, path) => tf.children.update(agentId, { sessionFile: path }),
				recordFailed: (agentId, failed) => tf.children.update(agentId, { failed }),
				onAsk: (agentId, pending) => broker.onChildAsk(agentId, pending),
				onRunEnd: () => {
					onChange();
					// A finished child is a lifecycle boundary, unlike its stream updates.
					costs?.refresh();
				},
				onUpdate: onChange,
				onActivity: (agentId, event) => observe?.activity(agentId, event),
				hasChildren: () => tf.children.all().length > 0,
			},
			parentModel: () => ({ model: currentModel, thinking: pi.getThinkingLevel() }),
			models: () => modelRegistry,
		});

		if (todos) {
			const dir = sessionTodoDir({ file: ctx.sessionManager.getSessionFile(), id: ctx.sessionManager.getSessionId() });
			// §4. A fork or clone copies the conversation, so it copies the open lists
			// that conversation was working on.
			if (event.reason === "fork" && event.previousSessionFile) {
				copyOpenLists(sessionTodoDir({ file: event.previousSessionFile, id: "" }), dir);
			}
			if (!inherited) promptPlan.appended = buildAppendedPrompt(tf, promptPlan, dir);
			todos.start(dir);
		}
		onChange();
	});

	// §8. A forked child keeps its parent's tool roster, so its prompt and the
	// provider's cache survive, and the allowlist it was given is enforced here on
	// every call instead.
	const forkAllowlist = tf.identity?.forked ? tf.toolLimits.enforced : null;
	if (forkAllowlist) {
		const allowed = new Set(forkAllowlist);
		pi.on("tool_call", async (event) => {
			if (allowed.has(event.toolName)) return undefined;
			return {
				block: true,
				reason:
					`\`${event.toolName}\` is not one of the tools this subagent may call: ` +
					`${forkAllowlist.join(", ")}. Do it with those, or say in your report what is left.`,
			};
		});
	}

	pi.on("model_select", async (event) => {
		currentModel = { provider: event.model.provider, id: event.model.id };
	});

	pi.on("session_shutdown", async () => {
		ctxRef = null;
		todos?.stop();
		costs?.dispose();
		stats?.dispose();
		observe?.dispose();
		// §12. The last draft reaches the session before it can no longer be
		// written. A graceful close loses no typing; an abrupt kill loses at most
		// the last second of it.
		broker.flushJournal();
		// §13. A question whose session is shutting down is answered as cancelled.
		broker.cancelAll("the session it belonged to is gone");
		// §8. A session shutdown stops this agent's children, and theirs in turn.
		await tf.supervisor?.stopAll("the session it belongs to is shutting down");
		tf.supervisor?.cleanUp();
	});

	// -------------------------------------------------------- system prompt

	pi.on("before_agent_start", async (event, ctx) => {
		ctxRef = ctx;
		broker.useContext(ctx);

		// Capture the effective catalog after Pi discovery and earlier resource filtering.
		// Passing individual files retains explicit-only skills without activating them.
		if (event.systemPromptOptions) {
			tf.supervisor?.updateContext({ skillPaths: (event.systemPromptOptions.skills ?? []).map((skill) => skill.filePath) });
		}

		let systemPrompt = event.systemPrompt;
		// §6. `identity` replaces pi's opening identity paragraph in the child, and
		// leaves the tool roster and guidelines pi derives intact.
		const identity = process.env[ENV_IDENTITY];
		if (identity) systemPrompt = `${identity}\n\n${stripLeadingParagraph(systemPrompt)}`;
		if (process.env[ENV_NO_PI_DOCS] === "1") systemPrompt = stripPiDocs(systemPrompt);

		return promptPlan.appended ? { systemPrompt: `${systemPrompt}\n\n${promptPlan.appended}` } : { systemPrompt };
	});

	// ------------------------------------------------------ when an agent stops

	// §10. A report has reached this agent once its message is in the transcript.
	pi.on("message_end", async (event) => {
		const message = event.message;
		if (message.role !== "custom" || message.customType !== REPORT_MESSAGE) return;
		const agentId = (message.details as { agentId?: unknown } | undefined)?.agentId;
		if (typeof agentId === "string") orchestration.reportDelivered(agentId);
	});

	// §12. `/tree` moves the branch. A recovered question is bound to the branch
	// that asked it: leave that branch and it is taken back, not answered into
	// the wrong conversation; come back and it is offered again.
	pi.on("session_tree", async (_event, ctx) => {
		ctxRef = ctx;
		broker.useContext(ctx);
		broker.restore(ctx);
		onChange();
	});

	// §12. A recovered answer that was dispatched by this process may still be
	// queued: pi empties its queue only when the session is replaced, and never
	// reports it. Moving the branch would let it land somewhere it does not
	// belong, so navigation waits until the message is visible in the session.
	const holdForDelivery = async (ctx: ExtensionContext): Promise<{ cancel?: boolean } | undefined> => {
		broker.useContext(ctx);
		if (!broker.hasUnresolvedDispatch()) return undefined;
		try {
			ctx.ui.notify(
				"pi-taskforce: answers saved earlier are still being delivered. " +
					"Restart pi to retry safely if this does not finish.",
				"warning",
			);
		} catch {
			// A vanishing context cannot be notified.
		}
		return { cancel: true };
	};
	pi.on("session_before_tree", async (_event, ctx) => holdForDelivery(ctx));
	pi.on("session_before_switch", async (_event, ctx) => holdForDelivery(ctx));
	pi.on("session_before_fork", async (_event, ctx) => holdForDelivery(ctx));

	// §12. A user message is the acceptance signal for recovered answers. The
	// session entry may be appended just after this event, so the broker confirms
	// it on the branch instead of trusting the event alone.
	pi.on("message_start", async (event, ctx) => {
		broker.onMessageStart(ctx, event.message);
	});

	pi.on("turn_end", async (_event, ctx) => {
		ctxRef = ctx;
		broker.pokeAcceptance();
		onChange();
		costs?.refresh();
	});

	pi.on("agent_settled", async (event, ctx) => {
		ctxRef = ctx;
		broker.useContext(ctx);
		broker.pokeAcceptance();
		// §10. A run that settles normally has drained its follow-ups. After an abort
		// they stay queued for the next run, so the marks stay too.
		if (!event.aborted) orchestration.forgetQueuedReports();
		onChange();
		costs?.refresh();

		// §13. A root that stops leaves its children's questions waiting, and the
		// turn is the user's.
		if (tf.isRoot) return;

		// §13. A subagent that stops with its own child's question open answers it
		// as unattended; nobody else can reach that question.
		broker.releaseAsUnattended();

		// §8. A child with background children stays up, and their reports wake it.
		// Otherwise it has finished, and its last message is its report.
		if ((tf.supervisor?.liveRuns.length ?? 0) > 0) return;
		ctx.shutdown();
	});

	// ----------------------------------------------------------- commands

	if (todos) {
		pi.registerCommand("todos", {
			description: "Print this session's TODO lists",
			handler: async (_args, ctx) => {
				ctxRef = ctx;
				// §5. To the terminal only, never into the messages the model reads.
				ctx.ui.notify(listingText(todos.dir ?? "", todos.refresh()), "info");
				onChange();
			},
		});

		// §4. `/new` starts with no lists. `/new-keep` starts a new session with a
		// copy of this session's open lists. Only plain strings cross the switch: this
		// instance is shut down before `withSession` runs.
		pi.registerCommand("new-keep", {
			description: "Start a new session with a copy of this session's open TODO lists",
			handler: async (_args, ctx) => {
				const from = todos.dir;
				const parentSession = ctx.sessionManager.getSessionFile();
				await ctx.newSession({
					...(parentSession ? { parentSession } : {}),
					withSession: async (next) => {
						if (!from) return;
						const to = sessionTodoDir({
							file: next.sessionManager.getSessionFile(),
							id: next.sessionManager.getSessionId(),
						});
						const copied = copyOpenLists(from, to);
						if (next.hasUI) {
							next.ui.notify(
								copied.length > 0
									? `pi-taskforce: kept ${copied.length} open TODO list(s)`
									: "pi-taskforce: no open TODO lists to keep",
								"info",
							);
						}
					},
				});
			},
		});

		pi.registerShortcut("ctrl+shift+t", {
			description: "pi-taskforce: hide or show the TODO widget",
			handler: async (ctx) => {
				ctxRef = ctx;
				todoWidget?.toggle(ctx);
			},
		});
	}

	if (features.subagents && tf.isRoot) {
		pi.registerCommand("subagents", {
			description: "Open the subagent panel, or stop every subagent",
			getArgumentCompletions: (prefix) =>
				["stop"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				ctxRef = ctx;
				if (args.trim().toLowerCase() === "stop") {
					const stopped = await tf.supervisor?.stopAll("stopped by the user");
					ctx.ui.notify(`pi-taskforce: stopped ${stopped ?? 0} subagent run(s).`, "info");
					onChange();
					return;
				}
				await openPanel(tf, broker, ctx, panelActions(tf, broker, ctx, onChange));
			},
		});

		pi.registerShortcut("alt+s", {
			description: "pi-taskforce: stop every subagent",
			handler: async (ctx) => {
				ctxRef = ctx;
				const stopped = await tf.supervisor?.stopAll("stopped by the user");
				ctx.ui.notify(`pi-taskforce: stopped ${stopped ?? 0} subagent run(s).`, "info");
				onChange();
			},
		});

		pi.registerShortcut(`alt+${tf.settings.subagents.panelKey}` as KeyId, {
			description: "pi-taskforce: open the subagent panel",
			handler: async (ctx) => {
				ctxRef = ctx;
				await openPanel(tf, broker, ctx, panelActions(tf, broker, ctx, onChange));
			},
		});
	}

	// §12. A question can be put away to read the transcript behind it. This
	// brings it back with every answer and its position intact.
	pi.registerShortcut("alt+q", {
		description: "pi-taskforce: show the question that was put away",
		handler: async (ctx) => {
			ctxRef = ctx;
			broker.useContext(ctx);
			if (broker.reopen()) return;
			if (await broker.showRecovered(ctx)) return;
			ctx.ui.notify("pi-taskforce: no question is waiting.", "info");
		},
	});

	if (features.ask) {
		pi.registerCommand("questions", {
			description: "Show the question waiting for an answer, including a recovered or put-away one",
			handler: async (_args, ctx) => {
				ctxRef = ctx;
				broker.useContext(ctx);
				if (broker.reopen()) return;
				if (await broker.showRecovered(ctx)) return;
				ctx.ui.notify("pi-taskforce: no question is waiting.", "info");
			},
		});
	}

	// Reports and questions are shown in the transcript under their own label.
	for (const customType of [REPORT_MESSAGE, QUESTION_MESSAGE]) {
		pi.registerMessageRenderer(customType, (message, _options, theme) => {
			const body = typeof message.content === "string" ? message.content : "";
			return new Text(theme.fg("muted", body), 0, 0);
		});
	}
}

// --------------------------------------------------------------- helpers

/** §14. The status line counts the questions waiting on this agent. */
function refreshQuestionStatus(ctx: ExtensionContext | null, count: number, hidden: number): void {
	if (!ctx?.hasUI) return;
	const parts: string[] = [];
	if (hidden > 0) parts.push(`${hidden} question${hidden === 1 ? "" : "s"} put away · Alt+Q to open`);
	if (count > 0) parts.push(`${count} question${count === 1 ? "" : "s"} waiting`);
	ctx.ui.setStatus("pi-taskforce-questions", parts.length > 0 ? parts.join(" · ") : undefined);
}

const RUN_WIDGET_KEY = "pi-taskforce-runs";
let lastRunWidget: string | null = null;

/**
 * §14. While children run, a widget says what each one is doing: silence
 * otherwise reads as stuck. It is a view over the runs and holds no state.
 */
function refreshRunWidget(tf: Taskforce, ctx: ExtensionContext | null): void {
	if (!ctx?.hasUI) return;
	const runs = tf.supervisor?.liveRuns ?? [];
	if (runs.length === 0) {
		if (lastRunWidget === null) return;
		lastRunWidget = null;
		ctx.ui.setWidget(RUN_WIDGET_KEY, undefined);
		return;
	}
	const theme = ctx.ui.theme;
	const lines = [theme.fg("dim", "── subagents ──")];
	for (const { agentId, run } of runs) {
		const usage = run.contextUsage;
		const bits = [
			run.activity,
			`${Math.round(run.durationMs / 1000)}s`,
			`${run.toolCallCount} tool call(s)`,
			usage.percent !== null ? `${usage.percent}% context` : null,
		].filter(Boolean);
		lines.push(`${theme.fg("accent", agentId.slice(0, 8))} ${theme.fg("muted", bits.join(" • "))}`);
		const recent = run.recentToolCalls;
		if (recent.length > 0) lines.push(`  ${theme.fg("dim", recent.join(" → "))}`);
	}
	const drawn = lines.join("\n");
	if (drawn === lastRunWidget) return;
	lastRunWidget = drawn;
	ctx.ui.setWidget(RUN_WIDGET_KEY, lines);
}

function panelActions(tf: Taskforce, broker: AskBroker, ctx: ExtensionContext, onChange: () => void) {
	return {
		stopAll: () => {
			void tf.supervisor?.stopAll("stopped by the user").then(onChange).catch(() => {});
		},
		stopOne: (agentId: string) => {
			const run = tf.supervisor?.runFor(agentId);
			void run?.stop("stopped by the user").then(onChange).catch(() => {});
		},
		openQuestion: (reference: string) => {
			void broker.openWaiting(reference, ctx).catch(() => {});
		},
	};
}

/**
 * §15. The blocks this extension appends, with the placement block last: it is
 * the block most likely to differ between two runs of the same agent, and
 * keeping it last leaves the longest identical prefix for the provider's cache.
 */
function buildAppendedPrompt(tf: Taskforce, plan: InheritedPrompt, todoDirectory: string | null): string {
	const blocks: string[] = [];
	if (todoDirectory) blocks.push(prompts.todoBlock(todoDirectory));
	if (plan.subagentText) blocks.push(prompts.ORCHESTRATION_BLOCK);
	if (tf.features.subagents || !tf.isRoot) {
		blocks.push(
			prompts.placementBlock({
				depth: tf.depth,
				maxDepth: tf.maxDepth,
				parentUuid: tf.identity?.parentId ?? null,
				canSpawn: plan.registerRoster,
			}),
		);
	}
	return blocks.filter((block) => block.length > 0).join("\n\n");
}

/** §6. `identity` replaces pi's opening identity paragraph and nothing else. */
function stripLeadingParagraph(systemPrompt: string): string {
	const index = systemPrompt.indexOf("\n\n");
	return index === -1 ? systemPrompt : systemPrompt.slice(index + 2);
}

/** §6. `piDocs` keeps pi's own documentation block, and defaults to false. */
function stripPiDocs(systemPrompt: string): string {
	return systemPrompt.replace(/\n#+ *(About pi|Pi documentation)[\s\S]*?(?=\n#{1,3} |\s*$)/i, "\n");
}
