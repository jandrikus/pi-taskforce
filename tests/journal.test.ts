import { describe, expect, it } from "vitest";

import {
	type AskDraft,
	ANSWER_ENTRY,
	DONE_ENTRY,
	DRAFT_ENTRY,
	PENDING_ENTRY,
	SUBMIT_ENTRY,
	WAKE_ATTEMPT_ENTRY,
	draftFromSubmit,
	journalAsks,
	recoverableAsks,
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

	it("keeps a completed canonical answer in the inventory while removing it from pending", () => {
		const canonical = {
			type: "custom_message",
			customType: ANSWER_ENTRY,
			content: "android",
			details: { v: 2, askId: "a", toolCallId: "call-1", assistantEntryId: "a1" },
		};
		const entries = [pending("a"), submit("a", 5, { outcome: "answered", answers: [] }), canonical, done("a")] as never;
		const scan = scanAsks(entries);
		expect(scan.pending).toEqual([]);
		expect(scan.all).toHaveLength(1);
		expect(scan.all[0]!.done).toMatchObject({ how: "answered" });
		expect(scan.all[0]!.canonical).toMatchObject({ toolCallId: "call-1" });
		expect(journalAsks(entries, "S1").map((entry) => entry.pending.id)).toEqual(["a"]);
		expect(journalAsks(entries, "S2")).toEqual([]);
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

	it("reads the canonical answer and the wake attempt for a pending question", () => {
		const canonical = {
			type: "custom_message",
			customType: ANSWER_ENTRY,
			content: "android",
			details: { v: 2, askId: "a", toolCallId: "call-1", assistantEntryId: "a1" },
		};
		const found = recoverableAsks(
			[pending("a"), canonical, { type: "custom", customType: WAKE_ATTEMPT_ENTRY, data: { v: 1, id: "a" } }] as never,
			"S1",
		);
		expect(found[0]!.canonical).toMatchObject({ askId: "a", toolCallId: "call-1", text: "android" });
		expect(found[0]!.wakeAttempts).toHaveLength(1);
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

	it("uses the persisted entry id for a v1 payload identity, not its timestamp", () => {
		const one = { ...submit("ask-1", 5, result), id: "entry-first" };
		const two = { ...submit("ask-1", 5, { outcome: "cancelled", answers: [] }), id: "entry-second" };
		const scan = scanAsks([pending("ask-1"), one, two]);
		expect(scan.pending[0]!.submitted!.result.outcome).toBe("answered");
		expect(scan.pending[0]!.submitted!.submitId).toBe("entry-first");
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

describe("§12 the canonical answer record", () => {
	it("is read back by call id, and a done entry still wins", () => {
		const branch = [
			pending("ask-1"),
			{
				type: "custom_message",
				customType: ANSWER_ENTRY,
				content: "android",
				details: { v: 2, askId: "ask-1", toolCallId: "call-1", assistantEntryId: "a1" },
			},
		];
		const found = recoverableAsks(branch as never, "S1");
			expect(found).toHaveLength(1);
		expect(found[0]!.canonical).toMatchObject({ toolCallId: "call-1", text: "android" });
		expect(
			recoverableAsks(
				[...branch, { type: "custom", customType: DONE_ENTRY, data: { v: 1, id: "ask-1", at: 5, how: "cancelled" } }] as never,
				"S1",
			),
		).toEqual([]);
	});

	it("ignores an answer without a call id", () => {
		const branch = [
			pending("ask-1"),
			{ type: "custom_message", customType: ANSWER_ENTRY, content: "android", details: { askId: "ask-1" } },
		];
		expect(recoverableAsks(branch as never, "S1")[0]!.canonical).toBeNull();
	});
});
