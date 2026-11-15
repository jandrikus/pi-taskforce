import { describe, expect, it } from "vitest";

import { renderAskResult, validateAsk } from "../extensions/ask/schema.js";
import { decodeAsk, encodeAsk } from "../extensions/ask/protocol.js";
import { runDialogs, type DialogUI } from "../extensions/ask/dialogs.js";

function ok(context: unknown, questions: unknown) {
	const result = validateAsk(context, questions);
	if (!result.ok) throw new Error(`expected success, got: ${result.message}`);
	return result.ask;
}

function bad(context: unknown, questions: unknown): string {
	const result = validateAsk(context, questions);
	if (result.ok) throw new Error("expected a refusal");
	return result.message;
}

describe("§12 what an ask may be", () => {
	it("infers the type from the shape of the call", () => {
		const ask = ok(null, [
			{ id: "a", prompt: "pick" , options: [{ value: "x", label: "X" }] },
			{ id: "b", prompt: "say" },
		]);
		expect(ask.questions[0]?.type).toBe("select");
		expect(ask.questions[1]?.type).toBe("text");
	});

	it("defaults allowOther on for the option types and off for the others", () => {
		const ask = ok(null, [
			{ id: "a", prompt: "pick", options: [{ value: "x", label: "X" }] },
			{ id: "b", prompt: "say" },
			{ id: "c", prompt: "sure?", type: "confirm" },
		]);
		expect(ask.questions[0]?.allowOther).toBe(true);
		expect(ask.questions[1]?.allowOther).toBe(false);
		expect(ask.questions[2]?.allowOther).toBe(false);
	});

	it("gives a confirm question its Yes and No options", () => {
		const ask = ok(null, [{ id: "a", prompt: "sure?", type: "confirm" }]);
		expect(ask.questions[0]?.options.map((option) => option.label)).toEqual(["Yes", "No"]);
	});

	it("labels questions by position when they carry no label", () => {
		const ask = ok(null, [
			{ id: "a", prompt: "one" },
			{ id: "b", prompt: "two", label: "Scope" },
		]);
		expect(ask.questions.map((question) => question.label)).toEqual(["Q1", "Scope"]);
	});

	it("refuses every call the writeup says it refuses", () => {
		expect(bad(null, [])).toMatch(/at least one question/);
		expect(bad(null, [{ prompt: "x" }])).toMatch(/has no `id`/);
		expect(bad(null, [{ id: "a", prompt: "x" }, { id: "a", prompt: "y" }])).toMatch(/unique/);
		expect(bad(null, [{ id: "a" }])).toMatch(/has no `prompt`/);
		expect(bad(null, [{ id: "a", prompt: "x", options: [{ label: "X" }] }])).toMatch(
			/missing its `value`/,
		);
		expect(bad(null, [{ id: "a", prompt: "x", options: [{ value: "x" }] }])).toMatch(
			/missing its `label`/,
		);
		expect(bad(null, [{ id: "a", prompt: "x", type: "select" }])).toMatch(/has no options/);
		expect(
			bad(null, [{ id: "a", prompt: "x", type: "text", options: [{ value: "v", label: "L" }] }]),
		).toMatch(/declares options/);
		expect(
			bad(null, [
				{ id: "a", prompt: "x", options: [{ value: "v", label: "L" }], default: "nope" },
			]),
		).toMatch(/not one of its options/);
	});
});

describe("§12 how an outcome reads back to the agent", () => {
	const ask = ok("context line", [
		{ id: "scope", prompt: "how far?", options: [{ value: "wide", label: "Wide" }] },
		{ id: "note", prompt: "anything else?" },
	]);

	it("phrases omitted as permission to proceed, never as an error", () => {
		const body = renderAskResult(ask, {
			outcome: "answered",
			answers: [
				{ id: "scope", values: ["wide"], labels: ["Wide"], typed: false, omitted: false, note: null },
				{ id: "note", values: [], labels: [], typed: false, omitted: true, note: null },
			],
		});
		expect(body).toMatch(/scope: Wide/);
		expect(body).toMatch(/note: omitted\. Proceed on your own judgment/);
		expect(body).not.toMatch(/error/i);
	});

	it("phrases unattended the same way, and cancelled as a stop", () => {
		expect(renderAskResult(ask, { outcome: "unattended", answers: [] })).toMatch(
			/Proceed on your own judgment/,
		);
		expect(renderAskResult(ask, { outcome: "cancelled", answers: [] })).toMatch(/Stop here/);
	});

	it("says when an answer was typed rather than picked, and carries the note", () => {
		const body = renderAskResult(ask, {
			outcome: "answered",
			answers: [
				{ id: "scope", values: ["deep"], labels: ["deep"], typed: true, omitted: false, note: "only the parser" },
				{ id: "note", values: [], labels: [], typed: false, omitted: true, note: null },
			],
		});
		expect(body).toMatch(/typed, not picked/);
		expect(body).toMatch(/note: only the parser/);
	});

	it("does not call a text answer typed, since there was nothing to pick", () => {
		const body = renderAskResult(ask, {
			outcome: "answered",
			answers: [
				{ id: "scope", values: [], labels: [], typed: false, omitted: true, note: null },
				{ id: "note", values: ["ship it"], labels: ["ship it"], typed: true, omitted: false, note: null },
			],
		});
		expect(body).toMatch(/^note: ship it$/m);
	});
});

describe("§13 the wire between a child and its parent", () => {
	it("round-trips an envelope through a dialog title", () => {
		const ask = ok(null, [{ id: "a", prompt: "x" }]);
		const envelope = {
			from: { agentId: "child-1", agentType: "scout", depth: 2 },
			asksUserDirectly: false,
			ask,
		};
		const decoded = decodeAsk(encodeAsk(envelope));
		expect(decoded?.from.agentId).toBe("child-1");
		expect(decoded?.ask.questions[0]?.id).toBe("a");
	});

	it("does not read an ordinary dialog as an ask", () => {
		expect(decodeAsk("Allow this command?")).toBeNull();
		expect(decodeAsk(undefined)).toBeNull();
	});
});

describe("§12 the rpc surface", () => {
	/** Answers each dialog from the queue, and records the rows each select offered. */
	function ui(answers: Array<string | undefined>) {
		const queue = [...answers];
		const offered: string[][] = [];
		const dialogs: DialogUI = {
			select: async (_title, options) => {
				offered.push(options);
				return queue.shift();
			},
			input: async () => queue.shift(),
		};
		return { dialogs, offered };
	}

	it("asks one question at a time and returns the answers", async () => {
		const ask = ok(null, [
			{ id: "a", prompt: "pick", options: [{ value: "x", label: "X" }] },
			{ id: "b", prompt: "say" },
		]);
		const result = await runDialogs(ui(["X", "hello"]).dialogs, ask);
		expect(result.outcome).toBe("answered");
		expect(result.answers[0]?.values).toEqual(["x"]);
		expect(result.answers[1]?.values).toEqual(["hello"]);
	});

	it("treats dismissing any one dialog as cancelling the whole ask", async () => {
		const ask = ok(null, [
			{ id: "a", prompt: "pick", options: [{ value: "x", label: "X" }] },
			{ id: "b", prompt: "say" },
		]);
		const result = await runDialogs(ui(["X", undefined]).dialogs, ask);
		expect(result.outcome).toBe("cancelled");
		expect(result.answers).toEqual([]);
	});

	it("cancels on a dismissed confirm instead of reading it as No", async () => {
		const ask = ok(null, [{ id: "go", prompt: "Delete the branch?", type: "confirm" }]);
		expect((await runDialogs(ui([undefined]).dialogs, ask)).outcome).toBe("cancelled");
		const no = await runDialogs(ui(["No"]).dialogs, ask);
		expect(no.answers[0]?.values).toEqual(["no"]);
	});

	it("omits a question the user leaves empty rather than cancelling", async () => {
		const ask = ok(null, [{ id: "a", prompt: "say" }]);
		const result = await runDialogs(ui(["   "]).dialogs, ask);
		expect(result.outcome).toBe("answered");
		expect(result.answers[0]?.omitted).toBe(true);
	});

	it("lets a multiselect untick what was picked, and keeps option order", async () => {
		const ask = ok(null, [{
			id: "f", prompt: "which", type: "multiselect",
			options: [{ value: "a", label: "Auth" }, { value: "b", label: "Billing" }, { value: "s", label: "Search" }],
		}]);
		const { dialogs, offered } = ui(["[ ] Search", "[ ] Auth", "[ ] Billing", "[x] Billing", "Done"]);
		const result = await runDialogs(dialogs, ask);
		expect(result.answers[0]?.values).toEqual(["a", "s"]);
		expect(offered[3]).toContain("[x] Billing");
	});
});
