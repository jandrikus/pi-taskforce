import { afterEach, describe, expect, it, vi } from "vitest";

import { AskBroker, DELIVERY_UNCONFIRMED } from "../extensions/ask/broker.js";
import { forgetProcessToken } from "../extensions/ask/process.js";
import { DISPATCH_ENTRY, DONE_ENTRY, DRAFT_ENTRY, PENDING_ENTRY, SUBMIT_ENTRY } from "../extensions/ask/journal.js";
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

const pendingEntry = (id: string, sessionId: string, ask = two) => ({
	type: "custom",
	customType: PENDING_ENTRY,
	data: {
		v: 1,
		id,
		sessionId,
		createdAt: 1,
		ask,
		from: { agentId: "3f2a7c11", agentType: "reviewer", depth: 1 },
		via: [],
		attribution: "reviewer (3f2a7c11)",
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
		/** Set false to model a provider pi cannot authenticate. */
		credentials?: boolean;
		/** Null models no model selected. */
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
	const notices: string[] = [];
	let failSend = false;
	let component: any = null;
	let terminal: ((result: AskResult) => void) | null = null;
	let resolved = 0;

	// The user message pi appends after accepting sendUserMessage(): carrying the
	// marker is the only acknowledgement the extension can observe.
	const appendMarker = (text: string) =>
		branch.push({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
	let failDraft = options.failDraftOnce ?? false;
	let failDone = options.failDoneOnce ?? false;
	let failSubmit = options.failSubmitOnce ?? false;
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
			entries.push({ type, data: data as never });
			branch.push({ type: "custom", customType: type, data });
		},
		events: { emit: (channel: string, data: unknown) => bus.push({ channel, data }) },
		sendUserMessage: (text: string, sendOptions?: unknown) => {
			if (failSend || options.sendThrows) throw new Error("the session is not accepting input");
			sent.push({ text, options: sendOptions });
			if ((options.accept ?? true) === true) appendMarker(text);
		},
	};
	const tf = {
		self: { uuid: "root" },
		isRoot: true,
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
		deliver: () => {
			const last = sent.at(-1);
			if (last) appendMarker(last.text);
		},
		bus,
		entries,
		sent,
		notices,
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
	it("is offered again and answered from the phone as a new user message", async () => {
		const branch = [
			pendingEntry("ask-1", "S1"),
			draftEntry("ask-1", 2, 1, { db: { picked: ["pg"] }, name: { typed: "acme" } }),
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
		expect(ui.broker.recoveredCount).toBe(1);

		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.id).toBe("ask-1");
		expect(open.from).toBe("recovered from the previous run");
		// Durable before anything is acknowledged: the answers are in the journal,
		// the message is not in the session yet.
		expect(
			open.answer({ answers: [{ id: "db", values: ["lite"] }, { id: "name", values: ["acme"] }] }).pending.state,
		).toBe("dispatched");
		expect(ui.entries.find((entry) => entry.type === SUBMIT_ENTRY)).toMatchObject({
			data: { id: "ask-1", by: "remote" },
		});
		expect(ui.entries.at(-1)).toMatchObject({ type: DISPATCH_ENTRY, data: { id: "ask-1" } });
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		await tick();

		expect(ui.sent).toHaveLength(1);
		expect(ui.sent[0]!.text).toMatch(/^Answers to questions recovered from the previous run/);
		expect(ui.sent[0]!.text).toMatch(/Which database\?/);
		expect(ui.sent[0]!.text).toMatch(/Answer: SQLite/);
		expect(ui.sent[0]!.text).toMatch(/Answer: acme/);
		expect(ui.sent[0]!.text).toMatch(/Asked by: reviewer/);
		// A running turn is not interrupted.
		expect(ui.sent[0]!.options).toEqual({ deliverAs: "followUp" });
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "remote" },
		]);

		// A stale second submission cannot deliver twice.
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] })).toMatch(/no longer waiting/);
		expect(ui.sent).toHaveLength(1);
	});

	it("starts the next turn when pi is idle", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], idle: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		expect(ui.sent[0]!.options).toEqual({ deliverAs: "followUp" });
		await tick();
	});

	it("treats cancel as an explicit decision and sends nothing", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ outcome: "cancelled" })).toBeNull();
		expect(ui.sent).toHaveLength(0);
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { how: "cancelled" } });
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("keeps the question pending when the send cannot be made, and a restart retries", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		ui.setFailSend(true);
		// The send threw before pi took anything: saved, with the concrete reason.
		const failed = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(failed.pending.state).toBe("dispatched");
		expect(failed.pending.message).toMatch(/were not sent.*not confirmed/s);
		await tick();
		expect(ui.broker.recoveredCount).toBe(1);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		// The dispatch is recorded, so this process may not send again: the call
		// might have queued something before it threw.
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.message).toBe(DELIVERY_UNCONFIRMED);
		expect(ui.sent).toHaveLength(0);

		// A restart is the safe boundary: a new process token allows the retry.
		forgetProcessToken();
		ui.setFailSend(false);
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.retry).toBe(false);
		await tick();
		expect(ui.sent).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("never offers a question that was already done", () => {
		const branch = [
			pendingEntry("ask-1", "S1"),
			{ type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 3, how: "cancelled" } },
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_OPEN)).toEqual([]);
	});

	it("does not restore another session's question", () => {
		const ui = setup({ sessionId: "S2", branch: [pendingEntry("ask-1", "S1")] });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
	});

	it("closes the terminal copy when the phone answers first", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		// The overlay was dismissed once the message was accepted.
		await showing;
		expect(ui.sent).toHaveLength(1);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "remote" },
		]);
	});

	it("opens where the draft left off, and submits from the terminal", async () => {
		const ui = setup({
			branch: [pendingEntry("ask-1", "S1"), draftEntry("ask-1", 2, 1, { db: { picked: ["pg"] }, name: { typed: "acme" } })],
		});
		ui.broker.restore(ui.ctx as never);
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const screen = ui.component().render(100).join("\n");
		expect(screen).toMatch(/Question 2 of 2/);
		expect(screen).toMatch(/acme/);
		expect(screen).toMatch(/recovered from the previous run/);

		// The overlay ignores keys that arrive right as it opens.
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\x1b[13;5u");
		await showing;
		expect(ui.sent[0]!.text).toMatch(/Answer: PostgreSQL/);
		expect(ui.sent[0]!.text).toMatch(/Answer: acme/);
	});
});

describe("§12 drafts reach the session within the debounce", () => {
	it("writes typing after one second, and a boundary at once", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [] });
		const ask = ui.broker.ask(one, ui.ctx as never);
		await vi.advanceTimersByTimeAsync(0);
		expect(ui.entries[0]!.type).toBe(PENDING_ENTRY);

		vi.advanceTimersByTime(400);
		ui.component().handleInput("a");
		ui.component().handleInput("c");
		ui.component().handleInput("m");
		ui.component().handleInput("e");
		ui.component().render(100);
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY)).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(999);
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY)).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		const draft = ui.entries.find((entry) => entry.type === DRAFT_ENTRY)!.data;
		expect(draft.answers).toMatchObject({ name: { typed: "acme" } });

		// Hiding flushes a later edit without waiting for the debounce.
		ui.component().handleInput("d");
		ui.component().render(100);
		await vi.advanceTimersByTimeAsync(0);
		ui.component().handleInput("\x1bh");
		const drafts = ui.entries.filter((entry) => entry.type === DRAFT_ENTRY);
		expect(drafts.at(-1)!.data.answers).toMatchObject({ name: { typed: "acmed" } });

		// A graceful shutdown flushes the last second too.
		ui.component().handleInput("x");
		ui.component().render(100);
		ui.broker.flushJournal();
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY).at(-1)!.data.answers).toMatchObject({
			name: { typed: "acmedx" },
		});
		ui.terminal()({ outcome: "cancelled", answers: [] });
		await ask;
	});
});

describe("§12 recovery acceptance is the message, not the void return", () => {
	it("keeps a queued answer pending until the user message appears on the branch", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: "manual" });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		// Queued behind the running turn: the send returned, but nothing proves it
		// will ever be appended.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(ui.sent).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(1);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);

		ui.deliver();
		await new Promise((resolve) => setTimeout(resolve, 350));
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("does not offer a question whose recovered message is already on the branch", () => {
		const marker = "pi-taskforce-recovery:ask-1";
		const branch = [
			pendingEntry("ask-1", "S1"),
			{ type: "message", message: { role: "user", content: [{ type: "text", text: `Answers…\n[${marker}]` }] } },
		];
		const ui = setup({ branch });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_OPEN)).toEqual([]);
	});

	it("keeps the terminal copy open when the send fails, and refuses an unsafe retry", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		void ui.broker.showRecovered(ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 450));
		ui.setFailSend(true);
		ui.component().handleInput("\x1b[13;5u");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ui.component().render(100).join("\n")).toMatch(/not sent/);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		// The dispatch was recorded, so this process may not try again: the call
		// could have queued a message before it threw. The overlay stays open.
		ui.setFailSend(false);
		ui.component().handleInput("\x1b[13;5u");
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(ui.component().render(100).join("\n")).toMatch(/not confirmed/);
		expect(ui.sent).toHaveLength(0);
		expect(ui.resolved()).toBe(0);
		expect(ui.broker.recoveredCount).toBe(1);
	});
});

describe("§12 a recovered question follows its branch", () => {
	it("closes the terminal copy the phone already answered instead of leaving it dead", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		const showing = ui.broker.showRecovered(ui.ctx as never);
		// The render is queued behind `this.screen`; the answer lands first, and the
		// acceptance check closes whatever copy reached the screen.
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		await showing;
		await tick();
		expect(ui.sent).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "remote" },
		]);
	});

	it("takes the question back when the branch moves away, and refuses the old callback", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;

		// /tree to a branch that does not have this question.
		ui.setBranch([]);
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "cancelled", by: "terminal" },
		]);
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] })).toMatch(/no longer waiting/);
		expect(ui.sent).toHaveLength(0);
		// It is not done, so returning to the branch offers it again.
		ui.setBranch([pendingEntry("ask-1", "S1")]);
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
	});

	it("does not restore a question asked in another session", () => {
		const ui = setup({ sessionId: "S2", branch: [pendingEntry("ask-1", "S1")] });
		expect(ui.broker.restore(ui.ctx as never)).toBe(0);
	});
});

describe("§12 the journal keeps queued and continuously typed state", () => {
	it("writes a queued question before it reaches the screen", async () => {
		const ui = setup({ branch: [] });
		const first = ui.broker.ask(one, ui.ctx as never);
		const second = ui.broker.ask(one, ui.ctx as never);
		// Both pending entries exist while the first overlay still owns the screen.
		expect(ui.entries.filter((entry) => entry.type === PENDING_ENTRY)).toHaveLength(2);
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\r");
		await first;
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\r");
		await second;
	});

	it("never lets continuous typing push the flush past one second", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [] });
		const ask = ui.broker.ask(one, ui.ctx as never);
		await vi.advanceTimersByTimeAsync(0);
		vi.advanceTimersByTime(400);
		const keys = "abcdefghij";
		for (let i = 0; i < keys.length; i++) {
			ui.component().handleInput(keys[i]!);
			ui.component().render(100);
			await vi.advanceTimersByTimeAsync(100);
		}
		// Typing never stopped, and the first second of it is already on disk.
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY).length).toBeGreaterThanOrEqual(1);
		ui.terminal()({ outcome: "cancelled", answers: [] });
		await ask;
	});

	it("retries a done marker that failed, so an answered question cannot come back", async () => {
		const ui = setup({ branch: [], failDoneOnce: true });
		const ask = ui.broker.ask(one, ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("\r");
		await ask;
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		ui.broker.flushJournal();
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { how: "answered" } });
	});

	it("retries a draft append that failed instead of treating it as written", async () => {
		const ui = setup({ branch: [], failDraftOnce: true });
		const ask = ui.broker.ask(one, ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 400));
		ui.component().handleInput("a");
		ui.component().render(100);
		// The first attempt threw, so nothing was written and the state is retryable.
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY)).toHaveLength(0);
		ui.component().handleInput("\x1bh");
		// Nothing was written yet; the pending state is retried, not suppressed.
		ui.broker.flushJournal();
		expect(ui.entries.filter((entry) => entry.type === DRAFT_ENTRY)).toHaveLength(1);
		ui.terminal()({ outcome: "cancelled", answers: [] });
		await ask;
	});
});

describe("§12 a recovered question can be put away", () => {
	it("hides the real overlay, keeps an uncommitted note in the draft, and comes back", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		void ui.broker.showRecovered(ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 450));
		ui.component().handleInput("\x0e");
		for (const key of "use the pooler") ui.component().handleInput(key);
		ui.component().render(100);
		ui.component().handleInput("\x1bh");
		expect(ui.handle.hidden).toBe(true);
		expect(ui.broker.hiddenCount).toBe(1);
		const drafts = ui.entries.filter((entry) => entry.type === DRAFT_ENTRY);
		expect(drafts.at(-1)!.data.answers).toMatchObject({ db: { note: "use the pooler" } });
		expect(ui.broker.reopen()).toBe(true);
		expect(ui.handle.hidden).toBe(false);
		expect(ui.handle.focused).toBe(true);
	});
});

describe("§12 the submission is durable before it is acknowledged", () => {
	it("writes the answers to the journal before it sends anything", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")] });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		// The submit entry is written before the user message, so the payload is
		// never only in the phone's memory.
		const submitAt = ui.entries.findIndex((entry) => entry.type === SUBMIT_ENTRY);
		expect(submitAt).toBeGreaterThanOrEqual(0);
		expect(ui.sent).toHaveLength(1);
		await tick();
	});

	it("sends nothing when the submission cannot be written, and keeps it retryable", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], failSubmitOnce: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] })).toMatch(/could not be saved.*nothing was sent/s);
		expect(ui.sent).toHaveLength(0);
		expect(ui.entries.some((entry) => entry.type === SUBMIT_ENTRY)).toBe(false);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(1);

		// The journal accepts writes again: the same question can be answered.
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		await tick();
		expect(ui.sent).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("does not call a missing credential a failed send", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], credentials: false, idle: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		// Saved, never dispatched: a status with the reason and a retry, not a failure.
		const refused = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(refused.pending.state).toBe("saved");
		expect(refused.pending.retry).toBe(true);
		expect(refused.pending.message).toMatch(/No credentials are configured.*answers are saved/s);
		expect(ui.entries.some((entry) => entry.type === DISPATCH_ENTRY)).toBe(false);
		expect(ui.sent).toHaveLength(0);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);

		ui.setCredentials(true);
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		expect(ui.sent).toHaveLength(1);
		await tick();
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("accepts a provider pi reports as configured even without a stored key", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], idle: true });
		// A local endpoint needs no credential; the registry says it is configured.
		ui.ctx.modelRegistry.hasConfiguredAuth = () => false;
		ui.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "fallback" });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		expect(ui.sent).toHaveLength(1);
		await tick();
	});

	it("restores the submitted answers as a draft when the process restarts", async () => {
		const result: AskResult = {
			outcome: "answered",
			answers: [
				{ id: "db", values: ["lite"], labels: ["SQLite"], typed: false, omitted: false, note: null },
				{ id: "name", values: ["acme"], labels: ["acme"], typed: true, omitted: false, note: "keep it" },
			],
		};
		const ui = setup({ branch: [pendingEntry("ask-1", "S1"), submitEntry("ask-1", 5, result)] });
		expect(ui.broker.restore(ui.ctx as never)).toBe(1);
		void ui.broker.showRecovered(ui.ctx as never);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const screen = ui.component().render(100).join("\n");
		expect(screen).toMatch(/Review/);
		expect(screen).toMatch(/SQLite/);
		expect(screen).toMatch(/acme/);
	});
});

describe("§12 acceptance is event-driven and bounded", () => {
	it("uses message_start as a trigger but confirms the entry on the branch", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false, idle: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");

		// The event fires before the session entry exists: not acceptance yet.
		ui.broker.onMessageStart(ui.ctx as never, { role: "user" });
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(1);

		// The entry is on the branch now, and the event says so.
		ui.deliver();
		ui.broker.onMessageStart(ui.ctx as never, { role: "user" });
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("keeps the answers after the watchdog and refuses an in-process retry", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false, idle: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");
		expect(ui.sent).toHaveLength(1);

		// The send returned but no user message ever appeared.
		await vi.advanceTimersByTimeAsync(26_000);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(1);
		expect(ui.notices.some((notice) => /delivery is not confirmed/.test(notice))).toBe(true);

		// Nothing may be sent again while this process may still deliver it, even
		// when it looks idle and its queue is empty.
		ui.setIdle(true);
		const reply = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(reply.pending.retry).toBe(false);
		expect(reply.pending.message).toMatch(/Restart Pi to retry safely/);
		expect(ui.sent).toHaveLength(1);

		// A late message still finishes the question.
		ui.deliver();
		ui.broker.pokeAcceptance();
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("keeps the saved answers when a reopened card sends an empty form", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false, idle: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(ui.sent[0]!.text).toMatch(/Answer: PostgreSQL/);
		await vi.advanceTimersByTimeAsync(26_000);

		// After a restart the card opens empty; sending it must not overwrite the
		// answers the journal already holds.
		forgetProcessToken();
		expect(open.answer({ answers: [{ id: "db", values: [], omitted: true }] }).pending.retry).toBe(false);
		expect(ui.sent).toHaveLength(2);
		expect(ui.sent[1]!.text).toMatch(/Answer: PostgreSQL/);
	});

	it("closes the terminal copy when a late message arrives after the watchdog", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false, idle: true });
		ui.broker.restore(ui.ctx as never);
		void ui.broker.showRecovered(ui.ctx as never);
		await vi.advanceTimersByTimeAsync(400);
		ui.component().handleInput("\x1b[13;5u");
		await vi.advanceTimersByTimeAsync(26_000);
		// The watchdog left the overlay open and answerable, not finished.
		expect(ui.resolved()).toBe(0);
		expect(ui.broker.recoveredCount).toBe(1);

		// The queued message finally lands.
		ui.deliver();
		ui.broker.pokeAcceptance();
		expect(ui.resolved()).toBe(1);
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "terminal" },
		]);
	});

	it("stops a pending acceptance check when the session shuts down", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		ui.broker.flushJournal();
		// Nothing is left to fire, and the pending entry is still there to restore.
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(1);
	});

	it("ends the wait when the branch moves, so the old branch cannot finish it", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: false });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		ui.setBranch([]);
		ui.broker.restore(ui.ctx as never);
		await vi.advanceTimersByTimeAsync(30_000);
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(ui.broker.recoveredCount).toBe(0);
	});
});

describe("§12 quiet start and late cancels", () => {
	it("saves without sending while a turn is running, then sends once when idle", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], idle: false });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;

		const saved = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(saved.pending.state).toBe("saved");
		expect(saved.pending.retry).toBe(true);
		expect(saved.pending.message).toMatch(/still working/);
		// Saved, but no dispatch record and no call: nothing can land later.
		expect(ui.entries.find((entry) => entry.type === SUBMIT_ENTRY)).toMatchObject({ data: { id: "ask-1" } });
		expect(ui.entries.some((entry) => entry.type === DISPATCH_ENTRY)).toBe(false);
		expect(ui.sent).toHaveLength(0);
		expect(ui.broker.hasUnresolvedDispatch()).toBe(false);

		ui.setIdle(true);
		const second = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(ui.sent).toHaveLength(1);
		expect(second.pending.state).toBe("dispatched");
		await tick();
		expect(ui.entries.filter((entry) => entry.type === DISPATCH_ENTRY)).toHaveLength(1);
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
		expect(ui.broker.recoveredCount).toBe(0);
	});

	it("saves without sending while a message is already queued, then sends once", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], idle: true, pending: true });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;

		const saved = open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(saved.pending.state).toBe("saved");
		expect(saved.pending.retry).toBe(true);
		expect(saved.pending.message).toMatch(/already has a message queued/);
		expect(ui.entries.some((entry) => entry.type === DISPATCH_ENTRY)).toBe(false);
		expect(ui.sent).toHaveLength(0);

		ui.setPending(false);
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		expect(ui.sent).toHaveLength(1);
		await tick();
		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
	});

	it("treats a cancel after the message landed as answered, not cancelled", async () => {
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: "manual" });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] }).pending.state).toBe("dispatched");

		// The message is on the branch, but no acceptance check has run yet.
		ui.deliver();
		expect(ui.entries.some((entry) => entry.type === DONE_ENTRY)).toBe(false);
		expect(open.answer({ outcome: "cancelled" })).toBeNull();

		expect(ui.entries.at(-1)).toMatchObject({ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } });
		expect(ui.sent).toHaveLength(1);
		expect(ui.broker.recoveredCount).toBe(0);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "remote" },
		]);
	});

	it("does the same for a cancel from the terminal copy", async () => {
		vi.useFakeTimers();
		const ui = setup({ branch: [pendingEntry("ask-1", "S1")], accept: "manual" });
		ui.broker.restore(ui.ctx as never);
		const open = ui.bus.find((event) => event.channel === ASK_OPEN)!.data as TestAsk;
		open.answer({ answers: [{ id: "db", values: ["pg"] }] });
		const showing = ui.broker.showRecovered(ui.ctx as never);
		await vi.advanceTimersByTimeAsync(400);

		// The message is on the branch, but no acceptance check has run yet.
		ui.deliver();
		// Esc twice is the terminal's cancel.
		ui.component().handleInput("\x1b");
		ui.component().handleInput("\x1b");
		await vi.advanceTimersByTimeAsync(0);
		await showing;

		expect(ui.entries.filter((entry) => entry.type === DONE_ENTRY)).toMatchObject([
			{ type: DONE_ENTRY, data: { id: "ask-1", how: "recovered" } },
		]);
		expect(ui.sent).toHaveLength(1);
		expect(ui.bus.filter((event) => event.channel === ASK_CLOSE).map((event) => event.data)).toEqual([
			{ id: "ask-1", outcome: "answered", by: "terminal" },
		]);
	});
});
