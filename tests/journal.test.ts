import { describe, expect, it } from "vitest";

import {
	type AskDraft,
	DISPATCH_ENTRY,
	DONE_ENTRY,
	DRAFT_ENTRY,
	PENDING_ENTRY,
	SUBMIT_ENTRY,
	draftFromSubmit,
	recoverableAsks,
	recoveredMessage,
	scanAsks,
} from "../extensions/ask/journal.js";
import { validateAsk } from "../extensions/ask/schema.js";

function askOf(questions: unknown) {
	const checked = validateAsk(null, questions);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

const ask = askOf([
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

const pending = (id: string, sessionId = "S1") => ({
	type: "custom",
	customType: PENDING_ENTRY,
	data: {
		v: 1,
		id,
		sessionId,
		createdAt: 1,
		ask,
		from: { agentId: "root", agentType: "root", depth: 0 },
		via: [],
		attribution: null,
	},
});

const draft = (id: string, at: number, index: number, answers: AskDraft["answers"] = {}) => ({
	type: "custom",
	customType: DRAFT_ENTRY,
	data: { v: 1, id, at, index, answers },
});

const submit = (id: string, at: number, result: unknown) => ({
	type: "custom",
	customType: SUBMIT_ENTRY,
	data: { v: 1, id, at, by: "remote", result },
});

const done = (id: string, how = "answered") => ({
	type: "custom",
	customType: DONE_ENTRY,
	data: { v: 1, id, at: 9, how },
});

describe("§12 the ask journal", () => {
	it("restores the question with the latest draft, and never with an answer nobody gave", () => {
		const scan = scanAsks([
			pending("a"),
			draft("a", 2, 0, { db: { picked: ["pg"] } }),
			draft("a", 3, 1, { db: { picked: ["lite"] }, name: { typed: "acme" } }),
		]);
		expect(scan.pending).toHaveLength(1);
		expect(scan.pending[0]!.pending.ask.questions.map((q) => q.id)).toEqual(["db", "name"]);
		expect(scan.pending[0]!.draft).toMatchObject({
			index: 1,
			answers: { db: { picked: ["lite"] }, name: { typed: "acme" } },
		});
	});

	it("does not resurrect a question that has a done entry", () => {
		const scan = scanAsks([pending("a"), draft("a", 2, 1, { name: { typed: "x" } }), done("a")]);
		expect(scan.pending).toEqual([]);
		expect(scan.done.get("a")).toMatchObject({ how: "answered" });
		// A draft written after the done entry is ignored too: the ask is over.
		expect(scanAsks([pending("b"), done("b", "cancelled"), draft("b", 5, 0)]).pending).toEqual([]);
	});

	it("restores only this session's questions, not a fork's copied history", () => {
		const entries = [pending("parent", "S1"), pending("mine", "S2"), done("finished", "cancelled")];
		expect(recoverableAsks(entries, "S2").map((entry) => entry.pending.id)).toEqual(["mine"]);
		// A fork of S1 copies S1's entries but runs as S3: the parent's question is
		// readable history, not a question the fork is waiting on.
		expect(recoverableAsks(entries, "S3")).toEqual([]);
		expect(recoverableAsks(entries, null)).toEqual([]);
	});

	it("ignores an entry whose ask no longer validates", () => {
		const broken = { type: "custom", customType: PENDING_ENTRY, data: { v: 1, id: "x", ask: { questions: [] } } };
		expect(scanAsks([broken]).pending).toEqual([]);
	});

	it("says the answers are new input, who asked, and what was left out", () => {
		const text = recoveredMessage(
			{
				v: 1,
				id: "a",
				sessionId: "S1",
				createdAt: 1,
				ask,
				from: { agentId: "3f2a7c11", agentType: "reviewer", depth: 1 },
				via: [],
				attribution: "reviewer (3f2a7c11)",
			},
			{
				outcome: "answered",
				answers: [
					{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, omitted: false, note: "use the pooler" },
					{ id: "name", values: [], labels: [], typed: false, omitted: true, note: null },
				],
			},
		);
		expect(text).toMatch(/^Answers to questions recovered from the previous run/);
		expect(text).toMatch(/no longer live/);
		expect(text).toMatch(/not the result of that old call/);
		expect(text).toMatch(/Asked by: reviewer \(3f2a7c11\)/);
		expect(text).toMatch(/subagent and is not running any more/);
		expect(text).toMatch(/1\. Which database\?/);
		expect(text).toMatch(/Answer: PostgreSQL/);
		expect(text).toMatch(/Note: use the pooler/);
		expect(text).toMatch(/2\. Name\?/);
		expect(text).toMatch(/Answer: skipped, the agent decides/);
	});
});

describe("§12 a submitted answer survives a restart", () => {
	const result = {
		outcome: "answered",
		answers: [
			{ id: "db", values: ["lite"], labels: ["SQLite"], typed: false, omitted: false, note: null },
			{ id: "name", values: ["acme"], labels: ["acme"], typed: true, omitted: false, note: "keep it" },
		],
	};

	it("attaches the last submission to the question and restores it as a draft", () => {
		const scan = scanAsks([pending("ask-1"), draft("ask-1", 2, 0, { db: { picked: ["pg"] } }), submit("ask-1", 5, result)]);
		expect(scan.pending).toHaveLength(1);
		expect(scan.pending[0]!.submitted!.at).toBe(5);
		// The submit is newer than the draft, so its answers are what comes back.
		expect(scan.pending[0]!.draft).toMatchObject({
			index: 2,
			answers: {
				db: { picked: ["lite"] },
				name: { typed: "acme", note: "keep it" },
			},
		});
	});

	it("keeps a newer draft over an older submission", () => {
		const scan = scanAsks([pending("ask-1"), submit("ask-1", 2, result), draft("ask-1", 5, 0, { db: { picked: ["pg"] } })]);
		expect(scan.pending[0]!.draft).toMatchObject({ index: 0, answers: { db: { picked: ["pg"] } } });
		expect(scan.pending[0]!.submitted!.at).toBe(2);
	});

	it("ignores a submission that is not about a question on this branch", () => {
		const scan = scanAsks([pending("ask-1"), submit("ask-2", 5, result)]);
		expect(scan.pending[0]!.submitted).toBeNull();
	});

	it("turns a skipped answer into a skipped draft", () => {
		const draft = draftFromSubmit(
			{
				v: 1,
				id: "ask-1",
				at: 5,
				by: "terminal",
				result: {
					outcome: "answered",
					answers: [
						{ id: "db", values: ["pg"], labels: ["PostgreSQL"], typed: false, omitted: false, note: null },
						{ id: "name", values: [], labels: [], typed: false, omitted: true, note: null },
					],
				},
			},
			ask,
		);
		expect(draft.answers.db).toMatchObject({ picked: ["pg"] });
		expect(draft.answers.name).toMatchObject({ skipped: true });
	});
});

describe("§12 the dispatch record", () => {
	it("is read back with its process token, and a done entry still wins", () => {
		const branch = [
			pending("ask-1"),
			{ type: "custom", customType: DISPATCH_ENTRY, data: { v: 1, id: "ask-1", sessionId: "S1", at: 4, token: "proc-1" } },
		];
		const found = recoverableAsks(branch as never, "S1");
		expect(found).toHaveLength(1);
		expect(found[0]!.dispatch).toMatchObject({ token: "proc-1", sessionId: "S1" });
		expect(
			recoverableAsks(
				[...branch, { type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 5, how: "cancelled" } }] as never,
				"S1",
			),
		).toEqual([]);
	});

	it("ignores a dispatch record without a token", () => {
		const branch = [
			pending("ask-1"),
			{ type: "custom", customType: DISPATCH_ENTRY, data: { v: 1, id: "ask-1", at: 4 } },
		];
		expect(recoverableAsks(branch as never, "S1")[0]!.dispatch).toBeNull();
	});
});
