import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { AskBroker } from "../extensions/ask/broker.js";
import {
	ANSWER_ENTRY,
	DONE_ENTRY,
	DRAFT_ENTRY,
	PENDING_ENTRY,
	SEND_ATTEMPT_ENTRY,
	SUBMIT_ENTRY,
	VISIBLE_ENTRY,
	WAKE_ATTEMPT_ENTRY,
	WAKE_ENTRY,
} from "../extensions/ask/journal.js";
import { processId } from "../extensions/ask/process.js";
import { projectAskAnswers, type ContextMessage } from "../extensions/ask/recovery.js";
import { encodeAskResult } from "../extensions/ask/protocol.js";
import { ASK_CLOSE, ASK_OPEN, type RemoteAsk } from "../extensions/ask/remote.js";

/** The test harness reads the pending status directly; the real type is a union. */
type TestAsk = Omit<RemoteAsk, "answer"> & { answer(input: unknown): any };
import type { AskResult } from "../extensions/ask/schema.js";
import { validateAsk } from "../extensions/ask/schema.js";
import type { Taskforce } from "../extensions/runtime.js";

function askOf(questions: unknown) {
	const checked = validateAsk(null, questions);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

const two = askOf([
	{
		id: "db",
		prompt: "Which database?",
		options: [
			{ value: "pg", label: "PostgreSQL" },
			{ value: "lite", label: "SQLite" },
		],
	},
	{ id: "name", prompt: "Name?", optional: true },
]);

const one = askOf([{ id: "name", prompt: "Name?" }]);

const assistantCall = (id = "call-1") => ({
	type: "message",
	id: "a1",
	message: {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "ask", arguments: {} }],
	},
});

const pendingEntry = (id: string, sessionId: string, ask = two, toolCallId: string | null = "call-1") => ({
	type: "custom",
	customType: PENDING_ENTRY,
	data: {
		v: toolCallId ? 2 : 1,
		id,
		sessionId,
		createdAt: 1,
		ask,
		from: { agentId: "3f2a7c11", agentType: "reviewer", depth: 1 },
		via: [],
		attribution: "reviewer (3f2a7c11)",
		toolCallId,
		assistantEntryId: toolCallId ? "a1" : null,
	},
});

/** One turn of the event loop, enough for the first acceptance check. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Answers a previous run sent and journalled before the send. */
const submitEntry = (id: string, at: number, result: AskResult, by: "terminal" | "remote" = "remote") => ({
	type: "custom",
	customType: SUBMIT_ENTRY,
	data: { v: 1, id, at, by, result },
});

const draftEntry = (id: string, at: number, index: number, answers: Record<string, unknown>) => ({
	type: "custom",
	customType: DRAFT_ENTRY,
	data: { v: 1, id, at, index, answers },
});

const sendAttemptEntry = (id: string, at: number, submitId: string, process = processId()) => ({
	type: "custom",
	customType: SEND_ATTEMPT_ENTRY,
	data: { v: 1, id, at, toolCallId: "call-1", sessionId: "S1", process, submitId },
});

const wakeAttemptEntry = (id: string, at: number, canonicalEntryId: string | null, process?: string) => ({
	type: "custom",
	customType: WAKE_ATTEMPT_ENTRY,
	data: { v: process ? 2 : 1, id, at, toolCallId: "call-1", sessionId: "S1", process, canonicalEntryId },
});

const visibleEntry = (id: string, at: number, request?: string, toolCallId = "call-1") => ({
	type: "custom",
	customType: VISIBLE_ENTRY,
	data: { v: request ? 2 : 1, id, at, toolCallId, ...(request ? { request } : {}) },
});

const canonicalEntry = (
	id: string,
	at: number,
	outcome: "answered" | "cancelled" | "unattended" = "answered",
	askId = "ask-1",
	toolCallId = "call-1",
) => ({
	type: "custom_message",
	id,
	customType: ANSWER_ENTRY,
	content: outcome === "answered" ? "android" : `The ask was ${outcome}.`,
	details: { v: 2, askId, outcome, toolCallId, assistantEntryId: "a1" },
});

function setup(
	options: {
		sessionId?: string;
		idle?: boolean;
		branch?: unknown[];
		/** Accept a send by putting the marker on the branch; "manual" waits for deliver(). */
		accept?: boolean | "manual";
		sendThrows?: boolean;
		failDraftOnce?: boolean;
		failDoneOnce?: boolean;
		failSubmitOnce?: boolean;
		failMessageOnce?: boolean;
		failWakeAttemptOnce?: boolean;
		deferMessages?: boolean;
		wakeThrows?: boolean;
		root?: boolean;
		credentials?: boolean;
		hasModel?: boolean;
		/** True while pi still has queued input of its own. */
		pending?: boolean;
	} = {},
) {
	const sessionId = options.sessionId ?? "S1";
	let branch: any[] = options.branch ?? [];
	const entries: Array<{ type: string; data: any }> = [];
	const bus: Array<{ channel: string; data: any }> = [];
	const sent: Array<{ text: string; options: any }> = [];
	const messages: Array<{ customType: string; content: unknown; details: any; display?: boolean; options?: any }> = [];
	const userMessages: string[] = [];
	const inputs: string[] = [];
	const inputQueue: Array<string | undefined> = [];
	const notices: string[] = [];
	let editorText = "";
	let failSend = false;
	let component: any = null;
	let terminal: ((result: AskResult) => void) | null = null;
	let resolved = 0;

	// A canonical answer or a wake is a custom message. It is appended to the
	// branch the way pi's session would, so a second scan sees it.
	const appendCustom = (message: { customType: string; content: unknown; details?: unknown; display?: boolean }) =>
		branch.push({ type: "custom_message", customType: message.customType, content: message.content, details: message.details, display: message.display });
	let failDraft = options.failDraftOnce ?? false;
	let failDone = options.failDoneOnce ?? false;
	let failSubmit = options.failSubmitOnce ?? false;
	let failMessage = options.failMessageOnce ?? false;
	let failWakeAttempt = options.failWakeAttemptOnce ?? false;
	let deferMessages = options.deferMessages ?? false;
	const deferredMessages: any[] = [];
	// A restarted pi that offers recovered questions is normally idle; tests that
	// want a running turn or a queued message say so.
	let idle = options.idle ?? true;
	let pending = options.pending === true;
	let credentials = options.credentials !== false;
	const pi = {
		appendEntry: (type: string, data: unknown) => {
			if (type === DRAFT_ENTRY && failDraft) {
				failDraft = false;
				throw new Error("the session file is not writable");
			}
			if (type === DONE_ENTRY && failDone) {
				failDone = false;
				throw new Error("the session file is not writable");
			}
			if (type === SUBMIT_ENTRY && failSubmit) {
				failSubmit = false;
				throw new Error("the session file is not writable");
			}
			if (type === WAKE_ATTEMPT_ENTRY && failWakeAttempt) {
				failWakeAttempt = false;
				throw new Error("the session file is not writable");
			}
			entries.push({ type, data: data as never });
			branch.push({ type: "custom", customType: type, data });
		},
		events: { emit: (channel: string, data: unknown) => bus.push({ channel, data }) },
		sendUserMessage: (text: string, sendOptions?: unknown) => {
			if (failSend || options.sendThrows) throw new Error("the session is not accepting input");
			sent.push({ text, options: sendOptions });
			userMessages.push(text);
		},
		sendMessage: (message: any, sendOptions?: unknown) => {
			if (failMessage) {
				failMessage = false;
				throw new Error("the session is not accepting messages");
			}
			if (options.wakeThrows && message.customType === WAKE_ENTRY) throw new Error("no turn possible");
			messages.push({ ...message, options: sendOptions });
			if (deferMessages) deferredMessages.push(message);
			else appendCustom(message);
		},
	};
	const tf = {
		self: { uuid: "root" },
		isRoot: options.root !== false,
		asksUserDirectly: true,
		depth: 0,
		settings: { ask: { notify: false } },
	} as unknown as Taskforce;
	const broker = new AskBroker(pi as never, tf, { wake: () => {}, onChange: () => {} });
	const handle = {
		hidden: false,
		focused: false,
		setHidden(value: boolean) {
			this.hidden = value;
		},
		focus() {
			this.focused = true;
		},
	};
	const ctx = {
		hasUI: true,
		mode: "tui",
		sessionManager: { getSessionId: () => sessionId, getBranch: () => branch },
		isIdle: () => idle,
		hasPendingMessages: () => pending,
		model: options.hasModel === false ? undefined : { provider: "test", id: "test-model" },
		modelRegistry: {
			hasConfiguredAuth: () => credentials,
			getProviderAuthStatus: () => ({ configured: credentials }),
		},
		ui: {
			custom: (factory: any, customOptions: any) =>
				new Promise<AskResult>((resolve) => {
					terminal = resolve;
					component = factory(
						{ terminal: { write: () => {}, rows: 40 }, requestRender: () => {} },
						{ fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text },
						{},
						(value: AskResult) => {
							resolved++;
							resolve(value);
						},
					);
					customOptions?.onHandle?.(handle);
				}),
			notify: (message: string) => notices.push(message),
			setEditorText: (text: string) => {
				editorText = text;
			},
			input: async (title: string) => {
				inputs.push(title);
				return inputQueue.shift();
			},
		},
	};
	return {
		branch,
		setBranch: (next: unknown[]) => {
			branch = next;
		},
		setIdle: (next: boolean) => {
			idle = next;
		},
		setPending: (next: boolean) => {
			pending = next;
		},
		setCredentials: (next: boolean) => {
			credentials = next;
		},
		failNextSend: () => {
			failSend = true;
		},
		allowSend: () => {
			failSend = false;
		},
		bus,
		entries,
		sent,
		messages,
		userMessages,
		inputs,
		queueInput: (value: string | undefined) => inputQueue.push(value),
		deliverMessages: () => {
			for (const message of deferredMessages.splice(0)) appendCustom(message);
		},
		notices,
		editorText: () => editorText,
		broker,
		ctx,
		handle,
		component: () => component,
		resolved: () => resolved,
		terminal: () => terminal!,
		setFailSend: (value: boolean) => {
			failSend = value;
		},
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("§12 a recovered question", () => {
	const recoveredBranch = () => [assistantCall(), pendingEntry("ask-1", "S1")];

	it("answers from the phone with a canonical result for the original call, never a user message", () => {
		const branch = [
			...recoveredBranch(),
			draftEntry("ask-1", 2, 1, { db: { picked: ["pg"] }, name: { typed: "acme" } }),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);

		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.id).toBe("ask-1");
		expect(open.from).toBe("an earlier run");
		const reply = open.answer({ answers: [{ id: "db", values: ["lite"] }, { id: "name", values: ["acme"] }] });
		expect(reply.pending.state).toBe("dispatched");
		expect(ui.entries.find((entry) => entry.type === SUBMIT_ENTRY)).toMatchObject({
			data: { id: "ask-1", by: "remote", result: { outcome: "answered" } },
		});
		const canonical = ui.messages.find((message) => message.customType === ANSWER_ENTRY)!;
		expect(canonical.details).toMatchObject({ askId: "ask-1", toolCallId: "call-1", assistantEntryId: "a1" });
		expect(String(canonical.content)).toMatch(/SQLite/);
		expect(ui.sent).toHaveLength(0);
		expect(ui.userMessages).toHaveLength(0);
		// A wake is a separate trigger with no answer in it.
		const wake = ui.messages.find((message) => message.customType === WAKE_ENTRY)!;
		expect(wake.options).toEqual({ triggerTurn: true });
		expect(wake.display).toBe(false);
		expect(ui.entries.some((entry) => entry.type === WAKE_ATTEMPT_ENTRY)).toBe(true);
	});

	it("names a recovered question with the dedicated saved heading", async () => {
		const ui = setup({ branch: recoveredBranch() });
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await tick();
		const rendered = ui.component().render(100).join("\n");
		expect(rendered).toMatch(/Question saved from the previous run/);
		expect(rendered).not.toMatch(/Question from recovered/);
		void showing;
	});

	it("projects the canonical answer as the tool result adjacent to the original call", () => {
		const branch = recoveredBranch();
		const ui = setup({ branch });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["lite"] }, { id: "name", values: ["acme"] }] });

		const projected = projectAskAnswers(
			ui.branch.flatMap((entry: any) => {
				if (entry.message) return [entry.message];
				if (entry.customType === ANSWER_ENTRY || entry.customType === WAKE_ENTRY) {
					return [{
						role: "custom",
						customType: entry.customType,
						content: entry.content,
						details: entry.details,
					}];
				}
				return [];
			}) as ContextMessage[],
		);
		const roles = projected.map((message) => message.role ?? message.customType);
		expect(roles).toEqual(["assistant", "toolResult"]);
		expect(projected[1]).toMatchObject({ toolCallId: "call-1", toolName: "ask", isError: false });
		expect(JSON.stringify(projected[1])).toMatch(/SQLite/);
	});

	it("does not offer a question whose canonical answer is already on the branch", () => {
		const branch = [
			...recoveredBranch(),
			{ type: "custom_message", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1", toolCallId: "call-1" } },
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.bus.some((event) => event.channel === ASK_OPEN)).toBe(false);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(true);
	});

	it("materialises a submitted answer after a restart without asking again", () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false },
				{ id: "name", values: ["acme"], labels: ["acme"], typed: true, note: null, omitted: false },
			],
		};
		const branch = [assistantCall(), pendingEntry("ask-1", "S1"), submitEntry("ask-1", 5, result)];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		const canonical = ui.messages.find((message) => message.customType === ANSWER_ENTRY)!;
		expect(canonical.details).toMatchObject({ askId: "ask-1", toolCallId: "call-1" });
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(true);
	});

	it("treats cancel as an explicit decision and projects a cancellation result", () => {
		const ui = setup({ branch: recoveredBranch() });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ outcome: "cancelled" }).pending.state).toBe("dispatched");
		const answer = ui.messages.find((message) => message.customType === ANSWER_ENTRY)!;
		expect(answer.details).toMatchObject({ askId: "ask-1", toolCallId: "call-1", outcome: "cancelled" });
		expect(String(answer.content)).toMatch(/cancelled/);
		expect(ui.entries.find((entry) => entry.type === DONE_ENTRY)).toMatchObject({ data: { how: "cancelled" } });
	});

	it("keeps the question pending when the answer cannot be journalled", () => {
		const ui = setup({ branch: recoveredBranch(), failSubmitOnce: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		const reply = open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		expect(reply).toMatch(/could not be saved/);
		expect(ui.messages).toHaveLength(0);
		expect(ui.broker.recoveredCount).toBe(1);
		// The next Try again can still save and materialise it.
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] }).pending.state).toBe(
			"dispatched",
		);
	});

	it("opens where the draft left off, and submits from the terminal", async () => {
		const branch = [
			...recoveredBranch(),
			draftEntry("ask-1", 2, 1, { db: { picked: ["pg"] }, name: { typed: "acme" } }),
		];
		const ui = setup({ branch });
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await tick();
		expect(ui.component()).toBeTruthy();
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\x1b[13;5u");
		await showing;
		await tick();
		expect(ui.messages.find((message) => message.customType === ANSWER_ENTRY)?.details.toolCallId).toBe("call-1");
		expect(ui.sent).toHaveLength(0);
	});

	it("closes the terminal copy when the phone answers first", async () => {
		const ui = setup({ branch: recoveredBranch() });
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await tick();
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		await showing;
		expect(ui.resolved()).toBe(1);
		expect(ui.bus.find((event) => event.channel === ASK_CLOSE)?.data).toMatchObject({ outcome: "answered", by: "remote" });
	});

	it("takes the question back when the branch moves away", () => {
		const ui = setup({ branch: recoveredBranch() });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		ui.setBranch([assistantCall()]);
		ui.broker.restore(ui.ctx as never);
		expect(ui.broker.recoveredCount).toBe(0);
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] })).toMatch(/no longer waiting/);
	});

	it("hides the real overlay and comes back", async () => {
		const ui = setup({ branch: recoveredBranch() });
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\x1bh");
		await tick();
		expect(ui.handle.hidden).toBe(true);
		expect(await ui.broker.showRecovered(ui.ctx as never)).toBe(true);
		expect(ui.handle.hidden).toBe(false);
		void showing;
	});

	it("keeps a legacy journal accessible without guessing a call or sending a message", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1", two, null), draftEntry("ask-1", 2, 0, { db: { picked: ["pg"] }, name: { typed: "acme" } })] });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.broker.legacyCount).toBe(1);
		expect(ui.messages).toHaveLength(0);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await tick();
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\x1b[13;5u");
		await tick();
		expect(ui.messages).toHaveLength(0);
		expect(ui.entries.find((entry) => entry.type === SUBMIT_ENTRY)).toBeTruthy();
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.editorText()).toMatch(/PostgreSQL/);
		void showing;
	});

	it("defers the one automatic wake until the session is idle, and never repeats it", async () => {
		const ui = setup({ branch: [assistantCall(), pendingEntry("ask-1", "S1")], idle: false });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		ui.setIdle(true);
		ui.broker.flushWake(ui.ctx as never);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
		ui.broker.flushWake(ui.ctx as never);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("keeps the answer available when the wake cannot start a turn", () => {
		const ui = setup({ branch: recoveredBranch(), wakeThrows: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		const reply = open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		expect(reply.pending.state).toBe("dispatched");
		expect(ui.messages.some((message) => message.customType === ANSWER_ENTRY)).toBe(true);
		expect(ui.notices.some((notice) => /did not continue/.test(notice))).toBe(true);
	});
});


	it("returns our own suspended placeholder on abort and keeps the question pending", async () => {
		const ui = setup({ branch: [] });
		const controller = new AbortController();
		const running = ui.broker.ask(one, ui.ctx as never, {
			toolCallId: "call-abort",
			assistantEntryId: "a-abort",
			signal: controller.signal,
		});
		await tick();
		controller.abort();
		const outcome = await running;
		expect(outcome.suspended).toBe(true);
		expect(outcome.askId).toMatch(/^ask-/);
		expect(ui.entries.find((entry) => entry.type === PENDING_ENTRY)?.data).toMatchObject({
			toolCallId: "call-abort",
			assistantEntryId: "a-abort",
		});
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.messages.some((message) => message.customType === ANSWER_ENTRY)).toBe(false);
	});


	it("writes a child's question before relaying it, then saves the answer in the child's session", async () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [{ id: "name", values: ["acme"], labels: ["acme"], typed: true, note: null, omitted: false }],
		};
		const ui = setup({ root: false, branch: [] });
		ui.queueInput(encodeAskResult(result));
		const outcome = await ui.broker.ask(one, ui.ctx as never, {
			toolCallId: "call-child",
			assistantEntryId: "a-child",
		});
		expect(outcome.result.answers[0]!.values).toEqual(["acme"]);
		expect(ui.entries.find((entry) => entry.type === PENDING_ENTRY)?.data).toMatchObject({
			toolCallId: "call-child",
			assistantEntryId: "a-child",
		});
		const submitAt = ui.entries.findIndex((entry) => entry.type === SUBMIT_ENTRY);
		expect(submitAt).toBeGreaterThanOrEqual(0);
		const canonical = ui.messages.find((message) => message.customType === ANSWER_ENTRY)!;
		expect(canonical.details).toMatchObject({ toolCallId: "call-child" });
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(true);
	});

	it("re-sends a child's unanswered question upward after a restart", async () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [{ id: "name", values: ["restored"], labels: ["restored"], typed: true, note: null, omitted: false }],
		};
		const ui = setup({ root: false, branch: [pendingEntry("ask-1", "S1", one)] });
		ui.queueInput(encodeAskResult(result));
		ui.broker.restore(ui.ctx as never);
		await tick();
		expect(ui.inputs).toHaveLength(1);
		expect(ui.messages.find((message) => message.customType === ANSWER_ENTRY)?.details).toMatchObject({
			askId: "ask-1",
			toolCallId: "call-1",
		});
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY && entry.data.id === "ask-1")).toBe(true);
	});

	it("persists a cancelled child reissue as the original call's cancellation", async () => {
		const ui = setup({ root: false, branch: [pendingEntry("ask-1", "S1", one)] });
		ui.queueInput(encodeAskResult({ outcome: "cancelled", answers: [] }));
		ui.broker.restore(ui.ctx as never);
		await tick();
		const canonical = ui.messages.find((message) => message.customType === ANSWER_ENTRY)!;
		expect(canonical.details).toMatchObject({ askId: "ask-1", outcome: "cancelled", toolCallId: "call-1" });
		expect(String(canonical.content)).toMatch(/cancelled/);
		expect(ui.entries.find((entry) => entry.type === DONE_ENTRY)).toMatchObject({ data: { how: "cancelled" } });
	});


	it("keeps a parallel batch's own result and appends the recovered sibling after it", () => {
		const batch = {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "ask", arguments: {} },
				{ type: "toolCall", id: "call-2", name: "read", arguments: {} },
			],
		};
		const sibling = {
			role: "toolResult",
			toolCallId: "call-2",
			toolName: "read",
			content: [{ type: "text", text: "file" }],
		};
		const out = projectAskAnswers([
			batch,
			sibling,
			{ role: "custom", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1", toolCallId: "call-1" } },
		] as ContextMessage[]);
		expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult", "toolResult"]);
		expect(out[1]!.toolCallId).toBe("call-2");
		expect(out[2]!.toolCallId).toBe("call-1");
	});


	it("does not resend a same-process canonical write that failed, and says to restart", () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false },
				{ id: "name", values: [], labels: [], typed: false, note: null, omitted: true },
			],
		};
		const branch = [assistantCall(), pendingEntry("ask-1", "S1"), submitEntry("ask-1", 5, result)];
		const ui = setup({ branch, failMessageOnce: true });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.status).toMatchObject({ state: "saved", retry: false });
		const reply = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(reply.pending).toMatchObject({ state: "saved", retry: false });
		expect(reply.pending.message).toMatch(/restart Pi/i);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(0);
	});

	it("does not mark a deferred canonical send done, and settles only when it lands", () => {
		const ui = setup({ branch: [assistantCall(), pendingEntry("ask-1", "S1")], deferMessages: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		const reply = open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		expect(reply.pending).toMatchObject({ state: "saved", retry: false });
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(1);

		ui.deliverMessages();
		ui.broker.flushWake(ui.ctx as never);
		expect(ui.entries.find((entry) => entry.type === DONE_ENTRY)).toMatchObject({ data: { how: "answered" } });
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(1);
	});

	it("replays a submit journal even when a premature done marker came first", () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false }],
		};
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, result),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 6, how: "answered" } },
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(0);
	});

	/** A real persisted assistant response after the answer's visibility proof. */
	function persistedResponse(
		stopReason: "stop" | "error" | "aborted",
		between: "none" | "user" = "none",
	): unknown[] {
		const sm = SessionManager.inMemory("/tmp/taskforce-persisted", { id: "S1" } as never);
		sm.appendMessage({ role: "user", content: "Start.", timestamp: Date.now() } as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: {} }],
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = sm.getBranch().at(-1)?.id ?? null;
		sm.appendCustomEntry(PENDING_ENTRY, pendingEntry("ask-1", "S1").data);
		const canonicalEntryId = sm.appendCustomMessageEntry(ANSWER_ENTRY, "android", true, {
			askId: "ask-1",
			outcome: "answered",
			toolCallId: "call-1",
			assistantEntryId,
		});
		sm.appendCustomEntry(WAKE_ATTEMPT_ENTRY, wakeAttemptEntry("ask-1", 6, canonicalEntryId, processId()).data);
		sm.appendCustomEntry(VISIBLE_ENTRY, visibleEntry("ask-1", 7).data);
		if (between === "user") sm.appendMessage({ role: "user", content: "Unrelated request.", timestamp: Date.now() } as never);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			stopReason,
			timestamp: Date.now(),
		} as never);
		return sm.getBranch() as unknown as unknown[];
	}

	it("lets explicit continue retry a persisted error response in the same process", () => {
		const ui = setup({ branch: persistedResponse("error") });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("lets explicit continue retry a persisted aborted response in the same process", () => {
		const ui = setup({ branch: persistedResponse("aborted") });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("keeps a later attempt with no response guarded even after an earlier error", () => {
		const branch = persistedResponse("error");
		const canonicalId = (branch as any[]).find((entry) => entry.type === "custom_message")?.id;
		branch.push(wakeAttemptEntry("ask-1", 9, canonicalId, processId()));
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("lets a successful retry after an error consume the answer for the next process", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 6, how: "recovered" } },
			wakeAttemptEntry("ask-1", 7, "ans-1", "previous-process"),
			visibleEntry("ask-1", 8, "request-1"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "failed" }], stopReason: "error" } },
			wakeAttemptEntry("ask-1", 10, "ans-1", "previous-process"),
		];
		const ui = setup({ branch });
		// The explicit retry actually sent the answer to the provider.
		ui.broker.noteVisibleAnswers(
			[{ role: "toolResult", details: { taskforceRecovered: true, askId: "ask-1" } }],
			ui.ctx as never,
		);
		ui.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "succeeded" }], stopReason: "stop" },
		});
		const nextProcess = setup({ branch });
		expect(nextProcess.broker.restore(nextProcess.ctx as never)).toBe(0);
		expect(nextProcess.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("consumes two recovered answers proven visible in the same request", () => {
		const branch = [
			assistantCall("call-1"),
			pendingEntry("ask-1", "S1", two, "call-1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1", "previous-process"),
			assistantCall("call-2"),
			pendingEntry("ask-2", "S1", one, "call-2"),
			canonicalEntry("ans-2", 6, "answered", "ask-2", "call-2"),
			wakeAttemptEntry("ask-2", 7, "ans-2", "previous-process"),
		];
		const ui = setup({ branch });
		ui.broker.noteVisibleAnswers(
			[
				{ role: "toolResult", details: { taskforceRecovered: true, askId: "ask-1" } },
				{ role: "toolResult", details: { taskforceRecovered: true, askId: "ask-2" } },
			],
			ui.ctx as never,
		);
		ui.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "both" }], stopReason: "stop" },
		});
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("updates visibility when an intervening user turn later includes the answer", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 6, how: "recovered" } },
			wakeAttemptEntry("ask-1", 7, "ans-1", "previous-process"),
			visibleEntry("ask-1", 8, "request-1"),
			{ type: "message", message: { role: "user", content: "Unrelated request.", timestamp: 9 } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "unrelated" }], stopReason: "stop" } },
		];
		const ui = setup({ branch });
		ui.broker.noteVisibleAnswers(
			[{ role: "toolResult", details: { taskforceRecovered: true, askId: "ask-1" } }],
			ui.ctx as never,
		);
		ui.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "answered later" }], stopReason: "stop" },
		});
		const nextProcess = setup({ branch });
		expect(nextProcess.broker.restore(nextProcess.ctx as never)).toBe(0);
		expect(nextProcess.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("keeps a successful consumption after a later failed request", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1", "previous-process"),
			visibleEntry("ask-1", 7, "request-1"),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "succeeded" }], stopReason: "stop" } },
			{ type: "message", message: { role: "user", content: "Later request.", timestamp: 8 } },
		];
		const ui = setup({ branch });
		ui.broker.noteVisibleAnswers(
			[{ role: "toolResult", details: { taskforceRecovered: true, askId: "ask-1" } }],
			ui.ctx as never,
		);
		ui.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "failed later" }], stopReason: "error" },
		});
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("does not duplicate a successful persisted response", () => {
		const ui = setup({ branch: persistedResponse("stop") });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("does not treat an assistant response after an unrelated user turn as this answer's response", () => {
		const ui = setup({ branch: persistedResponse("stop", "user") });
		// The current attempt is still unresolved; an unrelated turn neither
		// consumes the answer nor proves the continuation settled.
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("keeps an idle or missing response guarded", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1", processId()),
			visibleEntry("ask-1", 7),
		];
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("continues a completed canonical answer at startup, after the normal DONE", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 6, how: "recovered" } },
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("does not automatically retry a completed answer after a persisted error response", () => {
		const branch = persistedResponse("error");
		branch.push({ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 8, how: "recovered" } });
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		expect(ui.notices.join("\n")).toMatch(/questions continue/i);
	});

	it("continues a suspended placeholder, then refuses a repeated or consumed trigger", () => {
		const canonical = {
			type: "custom_message",
			customType: ANSWER_ENTRY,
			content: "android",
			details: { askId: "ask-1", outcome: "answered", toolCallId: "call-1" },
		};
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			{ type: "message", message: { role: "toolResult", toolCallId: "call-1", details: { taskforceSuspended: true }, content: [] } },
			canonical,
		];
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		ui.branch.push({
			type: "message",
			message: { role: "assistant", content: [{ type: "text", text: "continued" }] },
		});
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("drops a deferred wake when the answer left the current branch", () => {
		const ui = setup({ branch: [assistantCall(), pendingEntry("ask-1", "S1")], idle: false });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }, { id: "name", values: ["acme"] }] });
		ui.setBranch([assistantCall(), pendingEntry("ask-1", "S1")]);
		ui.setIdle(true);
		ui.broker.flushWake(ui.ctx as never);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("refuses a differing second submission without appending another WAL", () => {
		const first: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false },
				{ id: "name", values: [], labels: [], typed: false, note: null, omitted: true },
			],
		};
		const branch = [assistantCall(), pendingEntry("ask-1", "S1"), submitEntry("ask-1", 5, first)];
		const ui = setup({ branch, deferMessages: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		const reply = open.answer({ answers: [{ id: "db", values: ["lite"] }, { id: "name", values: ["changed"] }] });
		expect(reply.pending).toMatchObject({ state: "saved", retry: false });
		expect(reply.pending.message).toMatch(/already saved/i);
		expect(ui.branch.filter((entry: any) => entry.type === "custom" && entry.customType === SUBMIT_ENTRY)).toHaveLength(1);
		// The restore's first canonical attempt may be deferred; the second answer
		// must not add another one.
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(1);
	});

	it("keeps a same-process canonical attempt guarded across a reload", () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false },
				{ id: "name", values: [], labels: [], typed: false, note: null, omitted: true },
			],
		};
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, result),
			sendAttemptEntry("ask-1", 6, `at:5`, processId()),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.status).toMatchObject({ state: "saved", retry: false });
		expect(open.status!.message).toMatch(/restart Pi/i);
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(0);
		expect(ui.branch.filter((entry: any) => entry.type === "custom" && entry.customType === SEND_ATTEMPT_ENTRY)).toHaveLength(1);
	});

	it("reapplies the immutable payload after a prior process's canonical attempt", () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, note: null, omitted: false },
				{ id: "name", values: [], labels: [], typed: false, note: null, omitted: true },
			],
		};
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, result),
			sendAttemptEntry("ask-1", 6, "old-submit", "previous-process"),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === ANSWER_ENTRY)).toHaveLength(1);
		expect(ui.branch.filter((entry: any) => entry.type === "custom" && entry.customType === SEND_ATTEMPT_ENTRY)).toHaveLength(2);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(true);
	});

	it("does not repeat a wake attempted by this process", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1", processId()),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("continues an answer whose wake was attempted by a previous process", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1", "previous-process"),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
		expect(ui.branch.filter((entry: any) => entry.type === "custom" && entry.customType === WAKE_ATTEMPT_ENTRY)).toHaveLength(2);
	});

	it("adopts an untokened old wake as this process's guard and does not send it", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1"),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		expect(ui.branch.filter((entry: any) => entry.type === "custom" && entry.customType === WAKE_ATTEMPT_ENTRY)).toHaveLength(2);
	});

	it("continues after a full restart once the old untokened wake was adopted", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1"),
			wakeAttemptEntry("ask-1", 7, "ans-1", "previous-process"),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("continues a canonical unattended result like any other answer", () => {
		const branch = [assistantCall(), pendingEntry("ask-1", "S1"), canonicalEntry("ans-1", 5, "unattended")];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("does not send a legacy wake when adopting its guard cannot be persisted", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			wakeAttemptEntry("ask-1", 6, "ans-1"),
		];
		const ui = setup({ branch, failWakeAttemptOnce: true });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("does not treat an unrelated assistant turn as consumption", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "unrelated" }] } },
		];
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("does not consume an answer from a request that produced no response", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			visibleEntry("ask-1", 6),
		];
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("does not consume an answer after a branch edit that removed the proof", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			visibleEntry("ask-1", 6),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "consumed" }] } },
		];
		const ui = setup({ branch });
		ui.setBranch([assistantCall(), pendingEntry("ask-1", "S1"), canonicalEntry("ans-1", 5)]);
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(1);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
	});

	it("treats a request that projected the answer, then an assistant response, as consumption", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			canonicalEntry("ans-1", 5),
			visibleEntry("ask-1", 6),
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "consumed it" }] } },
		];
		const ui = setup({ branch });
		expect(ui.broker.continueAnswered(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(0);
	});

	it("continues a canonical cancellation as the original call's result", () => {
		const branch = [assistantCall(), pendingEntry("ask-1", "S1"), canonicalEntry("ans-1", 5, "cancelled")];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.messages.filter((message) => message.customType === WAKE_ENTRY)).toHaveLength(1);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY && entry.data.how === "cancelled")).toBe(true);
	});

describe("§12 canonical projection", () => {
	const assistant = () => ({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: {} }] });
	const answer = (text = "android") => ({
		role: "custom",
		customType: ANSWER_ENTRY,
		content: text,
		details: { askId: "ask-1", toolCallId: "call-1" },
	});

	it("drops a wake and inserts the answer as the call's result", () => {
		const out = projectAskAnswers([assistant(), answer(), { role: "custom", customType: WAKE_ENTRY, content: "wake" }] as ContextMessage[]);
		expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect(out[1]!.toolCallId).toBe("call-1");
	});

	it("lets a real result win", () => {
		const real = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "ask",
			content: [{ type: "text", text: "ios (real)" }],
		};
		const out = projectAskAnswers([assistant(), real, answer()] as ContextMessage[]);
		expect(out).toHaveLength(2);
		expect(JSON.stringify(out[1])).toMatch(/ios \(real\)/);
	});

	it("replaces only our own suspended placeholder", () => {
		const placeholder = {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "ask",
			content: [{ type: "text", text: "Interrupted" }],
			details: { taskforceSuspended: true },
		};
		const out = projectAskAnswers([assistant(), placeholder, answer()] as ContextMessage[]);
		expect(JSON.stringify(out[1])).toMatch(/android/);
		expect(out[1]!.details).toMatchObject({ recoveredFrom: "ask-1" });
	});

	it("keeps the answer as ordinary context when compaction removed the call", () => {
		const out = projectAskAnswers([answer()] as ContextMessage[]);
		expect(out).toHaveLength(1);
		expect(out[0]!.customType).toBe(ANSWER_ENTRY);
	});

	it("guards a completed canonical answer even after DONE", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, { outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }] }),
			canonicalEntry("answer-1", 6),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 7, how: "recovered" } },
		];
		const ui = setup({ root: false, branch });
		// The context edit removed the canonical message from the request. The
		// assistant call is still there, so its result cannot be skipped just
		// because the journal also has a done marker.
		const projected = projectAskAnswers([assistantCall().message] as ContextMessage[]);
		expect(ui.broker.requestProblem(projected, ui.ctx as never)).toMatch(/not the result/);
	});

	it("accepts an explicit cancellation at the request boundary", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, { outcome: "cancelled", answers: [] }),
			canonicalEntry("cancelled-1", 6, "cancelled"),
		];
		const ui = setup({ root: false, branch });
		const projected = projectAskAnswers([
			assistantCall().message,
			{ role: "custom", customType: ANSWER_ENTRY, content: "The ask was cancelled.", details: { askId: "ask-1", outcome: "cancelled", toolCallId: "call-1" } },
		] as ContextMessage[]);
		expect(ui.broker.requestProblem(projected, ui.ctx as never)).toBeNull();
	});

	it("does not block a compacted-away call whose answer is ordinary context", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, { outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }] }),
			canonicalEntry("answer-1", 6),
		];
		const ui = setup({ root: false, branch });
		const projected = projectAskAnswers([{ role: "custom", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1", toolCallId: "call-1" } } as ContextMessage]);
		expect(ui.broker.requestProblem(projected, ui.ctx as never)).toBeNull();
	});

	it("blocks a call whose recovered answer is not its projected result", () => {
		const branch = [
			assistantCall(),
			pendingEntry("ask-1", "S1"),
			submitEntry("ask-1", 5, { outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }] }),
			{ type: "custom_message", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1", outcome: "answered", toolCallId: "call-other" } },
		];
		const ui = setup({ root: false, branch });
		const projected = projectAskAnswers([assistantCall().message, { role: "custom", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1", toolCallId: "call-other" } }] as ContextMessage[]);
		expect(ui.broker.requestProblem(projected, ui.ctx as never)).toMatch(/not the result/);
	});

	it("projects an explicit cancellation as the original call's result", () => {
		const cancelled = {
			role: "custom",
			customType: ANSWER_ENTRY,
			content: "The ask was cancelled.",
			details: { askId: "ask-1", outcome: "cancelled", toolCallId: "call-1" },
		};
		const out = projectAskAnswers([assistant(), cancelled] as ContextMessage[]);
		expect(out.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect(String((out[1] as any).content[0].text)).toMatch(/cancelled/);
	});
});
