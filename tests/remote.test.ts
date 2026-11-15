import { describe, expect, it } from "vitest";

import { AskBroker } from "../extensions/ask/broker.js";
import { ASK_CLOSE, ASK_OPEN, type RemoteAsk, normalizeRemoteAnswer } from "../extensions/ask/remote.js";
import { validateAsk } from "../extensions/ask/schema.js";
import type { AskResult } from "../extensions/ask/schema.js";
import type { Taskforce } from "../extensions/runtime.js";

function askOf(questions: unknown) {
	const checked = validateAsk(null, questions);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

const db = {
	id: "db",
	prompt: "Which database?",
	options: [
		{ value: "pg", label: "PostgreSQL" },
		{ value: "lite", label: "SQLite" },
	],
};
const features = {
	id: "features",
	prompt: "Which features?",
	type: "multiselect",
	allowOther: false,
	options: [
		{ value: "auth", label: "Auth" },
		{ value: "billing", label: "Billing" },
	],
};
const ok = { id: "ok", prompt: "Go?", type: "confirm" };
const name = { id: "name", prompt: "Name?" };

describe("§12 a remote answer", () => {
	it("takes labels from the options, not from the sender", () => {
		const result = normalizeRemoteAnswer(askOf([db]), { answers: [{ id: "db", values: ["pg"], labels: ["evil"] }] });
		expect(result).toEqual({
			outcome: "answered",
			answers: [{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, omitted: false, note: null }],
		});
	});

	it("marks a typed select answer and keeps a note", () => {
		const result = normalizeRemoteAnswer(askOf([db]), { answers: [{ id: "db", values: ["DuckDB"], note: " fast " }] }) as AskResult;
		expect(result.answers[0]).toMatchObject({ values: ["DuckDB"], labels: ["DuckDB"], typed: true, note: "fast" });
	});

	it("orders a multiselect as the options are listed and refuses typed values without allowOther", () => {
		const ask = askOf([features]);
		const result = normalizeRemoteAnswer(ask, { answers: [{ id: "features", values: ["billing", "auth"] }] }) as AskResult;
		expect(result.answers[0]!.values).toEqual(["auth", "billing"]);
		expect(normalizeRemoteAnswer(ask, { answers: [{ id: "features", values: ["x"] }] })).toMatch(/not an option/);
	});

	it("reads a missing or empty answer as omitted, and refuses unknown ids", () => {
		const ask = askOf([db, name]);
		const result = normalizeRemoteAnswer(ask, { answers: [{ id: "name", values: [" "] }] }) as AskResult;
		expect(result.answers.map((a) => a.omitted)).toEqual([true, true]);
		expect(normalizeRemoteAnswer(ask, { answers: [{ id: "nope", values: ["x"] }] })).toMatch(/no question/);
	});

	it("accepts only yes or no on a confirm, and passes a cancel through", () => {
		const ask = askOf([ok]);
		expect(normalizeRemoteAnswer(ask, { answers: [{ id: "ok", values: ["maybe"] }] })).toMatch(/yes or no/);
		expect(normalizeRemoteAnswer(ask, { outcome: "cancelled" })).toEqual({ outcome: "cancelled", answers: [] });
	});
});

describe("§12 the broker publishes the ask it shows", () => {
	function setup() {
		const bus: Array<{ channel: string; data: any }> = [];
		const pi = { appendEntry: () => {}, events: { emit: (channel: string, data: unknown) => bus.push({ channel, data }) } };
		const tf = { self: { uuid: "root" }, isRoot: true, asksUserDirectly: true, depth: 0, settings: { ask: { notify: false } } } as unknown as Taskforce;
		const broker = new AskBroker(pi as never, tf, { wake: () => {}, onChange: () => {} });
		let terminalDone: ((r: AskResult) => void) | null = null;
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: (factory: any) =>
					new Promise<AskResult>((resolve) => {
						terminalDone = resolve;
						factory({ terminal: { write: () => {} }, requestRender: () => {} }, { fg: (_: string, t: string) => t, bg: (_: string, t: string) => t, bold: (t: string) => t }, {}, resolve);
					}),
			},
		};
		return { bus, broker, ctx, terminal: () => terminalDone! };
	}

	it("lets a remote answer close the overlay, once", async () => {
		const { bus, broker, ctx } = setup();
		const pending = broker.ask(askOf([db]), ctx as never);
		await new Promise((r) => setTimeout(r, 0));
		const open = bus.find((e) => e.channel === ASK_OPEN)!.data as RemoteAsk;
		expect(open.ask.questions[0]!.id).toBe("db");
		expect(open.answer({ answers: [{ id: "db", values: ["lite"] }] })).toBeNull();
		const result = await pending;
		expect(result.answers[0]!.labels).toEqual(["SQLite"]);
		expect(open.answer({ answers: [{ id: "db", values: ["pg"] }] })).toMatch(/already answered/);
		expect(bus.filter((e) => e.channel === ASK_CLOSE).map((e) => e.data)).toEqual([{ id: open.id, outcome: "answered", by: "remote" }]);
	});

	it("tells the remote when the terminal answered", async () => {
		const { bus, broker, ctx, terminal } = setup();
		const pending = broker.ask(askOf([db]), ctx as never);
		await new Promise((r) => setTimeout(r, 0));
		const open = bus.find((e) => e.channel === ASK_OPEN)!.data as RemoteAsk;
		terminal()({ outcome: "cancelled", answers: [] });
		await pending;
		expect(bus.filter((e) => e.channel === ASK_CLOSE).map((e) => e.data)).toEqual([{ id: open.id, outcome: "cancelled", by: "terminal" }]);
		expect(open.answer({ outcome: "cancelled" })).toMatch(/already answered/);
	});
});
