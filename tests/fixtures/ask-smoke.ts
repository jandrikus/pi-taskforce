/**
 * A real-TUI smoke surface for the ask overlay, its journal and recovery.
 *
 * It loads no taskforce agent code and calls no model. The ask is opened by the
 * real `AskBroker`, so the overlay, the pending entry, the draft debounce and the
 * restore path are the production ones. Only the final `sendUserMessage` is
 * simulated: the text is recorded and treated as a user message on the branch,
 * so the broker's acceptance check completes without starting a turn.
 *
 *   /ask-smoke      open a three-question ask. Alt+H puts it away, Alt+Q brings
 *                   it back, Alt+Left/Right and Alt+1-3 move, Ctrl+Enter sends.
 *                   Quit while it is open to leave a recoverable question.
 *   /recover-show   after a restart, open the recovered question with its draft.
 *   /recover-list   what the restore path found on this branch.
 *
 * Run it through scripts/ask-smoke.sh: the config and session live in one
 * reusable workspace, so a restart sees the previous run's branch.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { AskBroker } from "../../extensions/ask/broker.js";
import type { Ask } from "../../extensions/ask/schema.js";
import { validateAsk } from "../../extensions/ask/schema.js";
import type { Taskforce } from "../../extensions/runtime.js";

function askOf(context: string, questions: unknown): Ask {
	const checked = validateAsk(context, questions);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

const smokeAsk = askOf("A smoke test for hiding, moving and submitting. No model is involved.", [
	{
		id: "target",
		label: "Target",
		prompt: "Which target should the smoke run use?",
		type: "select",
		options: [
			{ value: "local", label: "Local" },
			{ value: "staging", label: "Staging" },
		],
		allowOther: true,
	},
	{
		id: "checks",
		label: "Checks",
		prompt: "Which checks should it cover?",
		type: "multiselect",
		options: [
			{ value: "keys", label: "Keys" },
			{ value: "draft", label: "Draft" },
		],
	},
	{ id: "note", label: "Note", prompt: "Anything the smoke should say?", type: "text", optional: true },
]);

export default function (pi: ExtensionAPI) {
	let ctxRef: ExtensionContext | null = null;
	let broker: AskBroker | null = null;
	/** What `sendUserMessage` would have sent, shown as a user message on the branch. */
	const simulated: string[] = [];

	const contextFor = (ctx: ExtensionContext): ExtensionContext => {
		ctxRef = ctx;
		const manager = {
			getSessionId: () => ctx.sessionManager.getSessionId(),
			getBranch: () => [
				...ctx.sessionManager.getBranch(),
				...simulated.map((text) => ({
					type: "message" as const,
					message: { role: "user", content: [{ type: "text", text }] },
				})),
			],
		};
		return {
			hasUI: ctx.hasUI,
			mode: ctx.mode,
			ui: ctx.ui,
			sessionManager: manager,
			isIdle: () => false,
			// The delivery preflight reads the model and its credentials; the smoke
			// sends nothing to a provider, so a configured stand-in is enough.
			model: { provider: "smoke", id: "smoke" },
			modelRegistry: {
				hasConfiguredAuth: () => true,
				getProviderAuthStatus: () => ({ configured: true }),
			},
		} as unknown as ExtensionContext;
	};

	const brokerFor = (ctx: ExtensionContext): AskBroker => {
		if (broker) return broker;
		const tf = {
			self: { uuid: "ask-smoke", type: "root" },
			isRoot: true,
			asksUserDirectly: true,
			depth: 0,
			settings: { ask: { notify: false } },
			children: { get: () => null },
		} as unknown as Taskforce;
		const fakePi = {
			appendEntry: (type: string, data?: unknown) => pi.appendEntry(type, data),
			events: { emit: (channel: string, data: unknown) => pi.events?.emit?.(channel, data) },
			sendUserMessage: (content: string, _options?: unknown) => {
				simulated.push(content);
			},
		};
		broker = new AskBroker(fakePi as never, tf, {
			wake: () => {},
			onChange: () => {},
		});
		broker.useContext(contextFor(ctx));
		return broker;
	};

	pi.registerCommand("ask-smoke", {
		description: "Open the real ask overlay and its journal (Alt+H hide, Alt+Q reopen, Ctrl+Enter send)",
		handler: async (_args, ctx) => {
			const active = brokerFor(ctx);
			const result = await active.ask(smokeAsk, contextFor(ctx));
			ctx.ui.notify(`smoke: ${result.outcome}, ${describe(result)}`, "info");
		},
	});

	pi.registerCommand("recover-list", {
		description: "What the real restore path found on this branch",
		handler: async (_args, ctx) => {
			const active = brokerFor(ctx);
			// The restore hook already ran at session start; this reports its result.
			ctx.ui.notify(
				active.recoveredCount === 0
					? "smoke: nothing recoverable. Run /ask-smoke, quit while it is open, then restart."
					: `smoke: ${active.recoveredCount} recovered question(s). /recover-show opens the first.`,
				"info",
			);
		},
	});

	pi.registerCommand("recover-show", {
		description: "Open the first recovered question through the real broker, with its draft",
		handler: async (_args, ctx) => {
			const active = brokerFor(ctx);
			if (!(await active.showRecovered(contextFor(ctx)))) {
				ctx.ui.notify("smoke: nothing recoverable. Run /ask-smoke, quit while it is open, then restart.", "warning");
				return;
			}
			const sent = simulated.at(-1);
			if (sent) {
				ctx.ui.notify(`smoke: the broker accepted the delivery. The text sent was:\n\n${sent}`, "info");
			}
		},
	});

	pi.registerShortcut("alt+q", {
		description: "ask smoke: reopen a put-away ask",
		handler: async (_ctx) => {
			broker?.reopen();
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const active = brokerFor(ctx);
		const recovered = active.restore(contextFor(ctx));
		if (recovered > 0 && ctx.hasUI) {
			ctx.ui.notify(
				`smoke: ${recovered} unanswered question${recovered === 1 ? "" : "s"} recovered. /recover-show opens it.`,
				"info",
			);
		}
	});

	pi.on("session_shutdown", async () => {
		broker?.flushJournal();
	});
}

function describe(result: { answers: Array<{ id: string; omitted: boolean; labels: string[]; values: string[] }> }): string {
	return result.answers
		.map((answer) => `${answer.id}=${answer.omitted ? "skipped" : answer.labels.join("|") || answer.values.join("|")}`)
		.join(", ");
}
