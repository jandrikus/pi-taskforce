/**
 * A real-TUI smoke surface for the ask overlay, its journal and recovery.
 *
 * It loads no taskforce agent code. The ask is opened by the real `AskBroker`,
 * so the overlay, the pending entry, the draft debounce and the restore path are
 * the production ones. Sending writes the canonical answer and starts one local
 * synthetic turn; that turn uses no network, no key and no paid model.
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
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

import { AskBroker } from "../../extensions/ask/broker.js";
import type { Ask } from "../../extensions/ask/schema.js";
import { validateAsk } from "../../extensions/ask/schema.js";
import type { Taskforce } from "../../extensions/runtime.js";

function askOf(context: string, questions: unknown): Ask {
	const checked = validateAsk(context, questions);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

const smokeAsk = askOf("A smoke test for hiding, moving and submitting. No cloud model is involved.", [
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
	// The smoke's wake turn must complete locally, exactly like the acceptance
	// tests: a real but synthetic provider, no network call and no model cost.
	pi.registerProvider("synthetic", {
		name: "Ask smoke synthetic",
		apiKey: "smoke",
		api: "smoke-api",
		baseUrl: "http://127.0.0.1:9/unused",
		models: [
			{
				id: "fake-1",
				name: "Fake 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096,
			},
		],
		streamSimple(model: any) {
			const stream = createAssistantMessageEventStream();
			const final: any = {
				role: "assistant",
				content: [{ type: "text", text: "smoke continued" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: final });
			stream.push({ type: "text_start", contentIndex: 0, partial: final });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "smoke continued", partial: final });
			stream.push({ type: "text_end", contentIndex: 0, content: "smoke continued", partial: final });
			stream.end(final);
			return stream;
		},
	});

	let ctxRef: ExtensionContext | null = null;
	let broker: AskBroker | null = null;
	const contextFor = (ctx: ExtensionContext): ExtensionContext => {
		ctxRef = ctx;
		return {
			hasUI: ctx.hasUI,
			mode: ctx.mode,
			ui: ctx.ui,
			sessionManager: ctx.sessionManager,
			// The smoke is never inside a turn, so the one wake may go at once.
			isIdle: () => true,
			hasPendingMessages: () => false,
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
			sendMessage: (message: unknown, options?: unknown) =>
				pi.sendMessage(message as never, options as never),
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
			const origin = askOrigin(ctx);
			if (!origin) {
				ctx.ui.notify("smoke: the seeded ask tool call is missing; run scripts/ask-smoke.sh -c.", "warning");
				return;
			}
			const outcome = await active.ask(smokeAsk, contextFor(ctx), origin);
			const result = outcome.result;
			ctx.ui.notify(`smoke: ${outcome.suspended ? "suspended" : result.outcome}, ${describe(result)}`, "info");
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
			ctx.ui.notify("smoke: the recovered question is open. Send writes its canonical answer.", "info");
		},
	});

	pi.registerShortcut("alt+q", {
		description: "ask smoke: reopen a put-away ask",
		handler: async (_ctx) => {
			broker?.reopen();
		},
	});

	pi.registerMessageRenderer("pi-taskforce-ask-answer", (message, _options, theme) => {
		const body = typeof message.content === "string" ? message.content : "";
		return {
			render: () => [theme.fg("muted", body)],
			invalidate: () => {},
		} as never;
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

/** The real persisted assistant tool call the fixture asks on. */
function askOrigin(ctx: ExtensionContext): { toolCallId: string; assistantEntryId: string } | null {
	const branch = ctx.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i] as { id?: string; type?: string; message?: { role?: string; content?: unknown } };
		if (entry.type !== "message" || entry.message?.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
		for (const part of entry.message.content) {
			const block = part as { type?: string; id?: string; name?: string };
			if (block.type === "toolCall" && block.name === "ask" && typeof block.id === "string" && entry.id) {
				return { toolCallId: block.id, assistantEntryId: entry.id };
			}
		}
	}
	return null;
}

function describe(result: { answers: Array<{ id: string; omitted: boolean; labels: string[]; values: string[] }> }): string {
	return result.answers
		.map((answer) => `${answer.id}=${answer.omitted ? "skipped" : answer.labels.join("|") || answer.values.join("|")}`)
		.join(", ");
}
