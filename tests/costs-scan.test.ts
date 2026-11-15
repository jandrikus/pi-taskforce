import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readCost } from "../extensions/costs/scan.js";
import {
	appendSession,
	assistant,
	branchSummary,
	childFile,
	childRecord,
	cleanup,
	compaction,
	type Fixture,
	makeFixture,
	messageUsage,
	ROOT_ID,
	toolResult,
	usage,
	usageEntry,
	writeRawSession,
	writeSession,
} from "./costs/fixture.js";

function rawAssistant(id: string, usageJson: string): string {
	return `{"type":"message","id":${JSON.stringify(id)},"parentId":null,"timestamp":"2026-11-09T10:00:00Z","message":{"role":"assistant","provider":"openai","model":"observed","usage":${usageJson}}}`;
}

let fixture: Fixture | null = null;
afterEach(() => {
	if (fixture) cleanup(fixture);
	fixture = null;
});

describe("session cost: own transcript", () => {
	it("sums every usage source once, across all entries", async () => {
		fixture = makeFixture();
		appendSession(fixture.rootFile, [
			assistant("a1", usage(10, 2, 0, 0, 0.1)),
			toolResult("t1", usage(1, 0, 0, 0, 0.01)),
			usageEntry("u1", usage(2, 1, 0, 0, 0.02)),
			compaction("c1", usage(3, 1, 0, 0, 0.03)),
			branchSummary("b1", usage(4, 1, 0, 0, 0.04)),
			messageUsage("m1", "branchSummary", usage(5, 0, 0, 0, 0.05)),
		]);

		const cost = await readCost(fixture.rootFile);
		expect(cost.own.cost).toBeCloseTo(0.25);
		expect(cost.total.cost).toBeCloseTo(0.25);
		expect(cost.descendants.cost).toBe(0);
		expect(cost.incomplete).toBe(false);
		expect(cost.models.map((model) => model.key)).toEqual(["Tools/summaries", "deepseek/deepseek-flash"]);
		expect(cost.models[0]?.usage.cost).toBeCloseTo(0.13);
		expect(cost.models[1]?.usage.cost).toBeCloseTo(0.12);
	});

	it("keeps provider/model buckets that sum to the total", async () => {
		fixture = makeFixture();
		appendSession(fixture.rootFile, [
			assistant("a1", usage(1, 1, 0, 0, 0.2), { provider: "a", model: "one" }),
			assistant("a2", usage(1, 1, 0, 0, 0.3), { provider: "b", model: "two" }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.models.reduce((sum, model) => sum + model.usage.cost, 0)).toBeCloseTo(cost.total.cost);
	});

	it("is complete when the session has no subagents folder", async () => {
		fixture = makeFixture();
		appendSession(fixture.rootFile, [assistant("a1", usage(1, 1, 0, 0, 0.1))]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents).toHaveLength(1);
		expect(cost.incomplete).toBe(false);
	});
});

describe("session cost: nested descendants", () => {
	it("walks by the recorded agent uuid, not the child transcript header id", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "child");
		const grand = join(fixture.base, "subagents", "child-stem", "grand.jsonl");
		writeSession(child, "a-different-pi-session-id", [
			assistant("ca", usage(20, 5, 0, 0, 0.3)),
			childRecord("cg", {
				uuid: "grand-uuid",
				parentUuid: "child-uuid",
				sessionFile: grand,
				depth: 3,
			}),
		]);
		writeSession(grand, "another-pi-session-id", [assistant("ga", usage(30, 5, 0, 0, 0.4))]);
		appendSession(fixture.rootFile, [
			assistant("ra", usage(10, 2, 0, 0, 0.1)),
			childRecord("rc", { uuid: "child-uuid", parentUuid: ROOT_ID, sessionFile: child }),
		]);

		const cost = await readCost(fixture.rootFile);
		expect(cost.total.cost).toBeCloseTo(0.8);
		expect(cost.own.cost).toBeCloseTo(0.1);
		expect(cost.descendants.cost).toBeCloseTo(0.7);
		expect(cost.agents.map((agent) => [agent.uuid, agent.depth])).toEqual([
			[ROOT_ID, 1],
			["child-uuid", 2],
			["grand-uuid", 3],
		]);
		expect(cost.agents[0]?.own.cost).toBeCloseTo(0.1);
		expect(cost.agents[1]?.own.cost).toBeCloseTo(0.3);
		expect(cost.agents[2]?.own.cost).toBeCloseTo(0.4);
		expect(cost.agents[0]?.subtree.cost).toBeCloseTo(0.8);
		expect(cost.agents[1]?.subtree.cost).toBeCloseTo(0.7);
	});

	it("uses the latest child record per uuid, from any branch", async () => {
		fixture = makeFixture();
		const first = childFile(fixture, "first");
		const second = childFile(fixture, "second");
		writeSession(first, "first", [assistant("a", usage(1, 0, 0, 0, 0.1))]);
		writeSession(second, "second", [assistant("b", usage(1, 0, 0, 0, 0.2))]);
		appendSession(fixture.rootFile, [
			childRecord("r1", { uuid: "c", parentUuid: ROOT_ID, sessionFile: first, type: "scout" }),
			childRecord("r2", { uuid: "c", parentUuid: ROOT_ID, sessionFile: second, type: "general" }),
			childRecord("r3", { uuid: "ignored", parentUuid: "someone-else", sessionFile: first }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.total.cost).toBeCloseTo(0.2);
		expect(cost.agents[1]).toMatchObject({ uuid: "c", type: "general", own: { cost: 0.2 } });
		expect(cost.agents.map((agent) => agent.uuid)).not.toContain("ignored");
	});

	it("re-reads a resumed child transcript without double counting", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "resumed");
		writeSession(child, "resumed-session", [assistant("first", usage(1, 0, 0, 0, 0.1))]);
		appendSession(fixture.rootFile, [
			childRecord("r", { uuid: "c", parentUuid: ROOT_ID, sessionFile: child }),
		]);
		const before = await readCost(fixture.rootFile);
		expect(before.total.cost).toBeCloseTo(0.1);
		appendSession(child, [assistant("second", usage(1, 0, 0, 0, 0.2))]);
		const after = await readCost(fixture.rootFile);
		expect(after.agents[1]?.own.cost).toBeCloseTo(0.3);
		expect(after.total.cost).toBeCloseTo(0.3);
	});

	it("leaves a forked child's copied history out of its own cost", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "forked");
		const grand = join(fixture.base, "subagents", "forked", "grand.jsonl");
		writeSession(
			child,
			"forked-session",
			[
				assistant("ra", usage(10, 2, 0, 0, 0.1)),
				assistant("own", usage(20, 5, 0, 0, 0.2)),
				childRecord("cg", { uuid: "grand", parentUuid: "child-uuid", sessionFile: grand, depth: 3 }),
			],
			{ parentSession: fixture.rootFile },
		);
		writeSession(grand, "grand-session", [assistant("ga", usage(1, 0, 0, 0, 0.3))]);
		appendSession(fixture.rootFile, [
			assistant("ra", usage(10, 2, 0, 0, 0.1)),
			childRecord("rc", { uuid: "child-uuid", parentUuid: ROOT_ID, sessionFile: child, forked: true }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[1]?.own.cost).toBeCloseTo(0.2);
		expect(cost.agents[1]?.subtree.cost).toBeCloseTo(0.5);
		expect(cost.total.cost).toBeCloseTo(0.6);
	});
});

describe("session cost: containment", () => {
	it("marks a missing transcript unknown and the total incomplete", async () => {
		fixture = makeFixture();
		appendSession(fixture.rootFile, [
			assistant("a", usage(1, 0, 0, 0, 0.1)),
			childRecord("r", { uuid: "c", parentUuid: ROOT_ID, sessionFile: childFile(fixture, "gone") }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.total.cost).toBeCloseTo(0.1);
		expect(cost.incomplete).toBe(true);
		expect(cost.agents[1]).toMatchObject({ uuid: "c", status: "missing", known: false });
	});

	it("rejects a sibling root tree and a legacy flat transcript", async () => {
		fixture = makeFixture();
		const sibling = join(fixture.dir, "sibling", "subagents", "other-root", "c.jsonl");
		const legacy = join(fixture.dir, "subagents", "legacy.jsonl");
		writeSession(sibling, "sib", [assistant("a", usage(1, 0, 0, 0, 9))]);
		writeSession(legacy, "legacy", [assistant("a", usage(1, 0, 0, 0, 9))]);
		appendSession(fixture.rootFile, [
			childRecord("s", { uuid: "sib", parentUuid: ROOT_ID, sessionFile: sibling }),
			childRecord("l", { uuid: "legacy", parentUuid: ROOT_ID, sessionFile: legacy }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents.slice(1).map((agent) => agent.status)).toEqual(["outside", "outside"]);
		expect(cost.total.cost).toBe(0);
		expect(cost.incomplete).toBe(true);
	});

	it("rejects a symlinked directory component and a symlinked session folder", async () => {
		fixture = makeFixture();
		const elsewhere = join(fixture.dir, "elsewhere");
		mkdirSync(elsewhere);
		writeSession(join(elsewhere, "c.jsonl"), "c", [assistant("a", usage(1, 0, 0, 0, 9))]);
		symlinkSync(elsewhere, join(fixture.base, "link"));
		appendSession(fixture.rootFile, [
			childRecord("r", { uuid: "c", parentUuid: ROOT_ID, sessionFile: join(fixture.base, "link", "c.jsonl") }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[1]?.status).toBe("outside");
		expect(cost.incomplete).toBe(true);

		const second = makeFixture();
		const realBase = second.base;
		const moved = join(second.dir, "moved-base");
		mkdirSync(moved);
		writeSession(join(moved, "c.jsonl"), "c", [assistant("a", usage(1, 0, 0, 0, 9))]);
		rmSync(realBase, { recursive: true, force: true });
		symlinkSync(moved, realBase);
		appendSession(second.rootFile, [
			childRecord("r", { uuid: "c", parentUuid: ROOT_ID, sessionFile: join(realBase, "c.jsonl") }),
		]);
		const redirected = await readCost(second.rootFile);
		cleanup(second);
		expect(redirected.agents[1]?.status).toBe("outside");
	});
});

describe("session cost: duplicates, cycles and malformed data", () => {
	it("does not charge an ancestor or a repeated transcript twice", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "child");
		writeSession(child, "child-session", [assistant("a", usage(1, 0, 0, 0, 0.2))]);
		appendSession(fixture.rootFile, [
			assistant("ra", usage(1, 0, 0, 0, 0.1)),
			childRecord("root", { uuid: "root-path", parentUuid: ROOT_ID, sessionFile: fixture.rootFile }),
			childRecord("c1", { uuid: "c1", parentUuid: ROOT_ID, sessionFile: child }),
			childRecord("c2", { uuid: "c2", parentUuid: ROOT_ID, sessionFile: child }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[1]?.status).toBe("cycle");
		expect(cost.agents[2]?.own.cost).toBeCloseTo(0.2);
		expect(cost.agents[3]?.status).toBe("duplicate");
		expect(cost.total.cost).toBeCloseTo(0.3);
		expect(cost.incomplete).toBe(false);
	});

	it("reports a uuid seen twice under different parents as duplicate, not a second charge", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "child");
		const grand = join(fixture.base, "subagents", "child", "grand.jsonl");
		writeSession(child, "child-session", [
			assistant("ca", usage(1, 0, 0, 0, 0.2)),
			childRecord("cg", { uuid: "same", parentUuid: "same", sessionFile: grand, depth: 3 }),
		]);
		writeSession(grand, "grand-session", [assistant("ga", usage(1, 0, 0, 0, 0.9))]);
		appendSession(fixture.rootFile, [
			childRecord("rc", { uuid: "same", parentUuid: ROOT_ID, sessionFile: child }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[1]?.status).toBe("ok");
		expect(cost.agents[2]?.status).toBe("duplicate");
		expect(cost.total.cost).toBeCloseTo(0.2);
		expect(cost.incomplete).toBe(false);
	});

	it("marks a malformed child transcript or malformed usage incomplete, without throwing", async () => {
		fixture = makeFixture();
		const broken = childFile(fixture, "broken");
		writeFileSync(broken, `${JSON.stringify({ type: "session", version: 3, id: "b", timestamp: "x", cwd: "/" })}\nnot json\n`);
		appendSession(fixture.rootFile, [
			assistant("a", usage(1, 0, 0, 0, 0.1)),
			childRecord("r", { uuid: "b", parentUuid: ROOT_ID, sessionFile: broken }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.total.cost).toBeCloseTo(0.1);
		expect(cost.incomplete).toBe(true);
		expect(cost.agents[1]?.known).toBe(false);
		expect(cost.agents[1]?.note).toMatch(/unreadable transcript line/);

		const fixture2 = makeFixture();
		const bad = childFile(fixture2, "bad-usage");
		writeSession(bad, "bad", [
			{ type: "message", id: "x", timestamp: 1, message: { role: "assistant", provider: "p", model: "m", usage: { input: "ten", cost: { total: "a lot" } } } },
		]);
		appendSession(fixture2.rootFile, [
			childRecord("r", { uuid: "bad", parentUuid: ROOT_ID, sessionFile: bad }),
		]);
		const partial = await readCost(fixture2.rootFile);
		cleanup(fixture2);
		expect(partial.incomplete).toBe(true);
		expect(partial.agents[1]?.known).toBe(false);
		expect(partial.agents[1]?.own.cost).toBe(0);
	});

	it("marks a file that is not a session as an unreadable child", async () => {
		fixture = makeFixture();
		const notSession = childFile(fixture, "not-session");
		writeFileSync(notSession, `${JSON.stringify({ type: "message", id: "x" })}\n`);
		appendSession(fixture.rootFile, [
			childRecord("r", { uuid: "x", parentUuid: ROOT_ID, sessionFile: notSession }),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[1]).toMatchObject({ status: "error", known: false });
		expect(cost.incomplete).toBe(true);
	});
});

describe("session cost: observed model and historical request input", () => {
	it("reads the last-recorded branch's provider response model and prompt token count", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "observed");
		const first = { ...assistant("a1", usage(100, 999, 900, 50, 0.1)), parentId: null };
		const second = {
			...assistant("a2", usage(1000, 700, 11000, 25, 0.2), {
				provider: "openai",
				model: "gpt-requested",
				responseModel: "gpt-actual",
			}),
			parentId: "a1",
		};
		const after = { ...compaction("c1", usage(5, 1, 0, 0, 0.01)), parentId: "a2" };
		writeSession(child, "child-session", [first, second, after], { parentSession: fixture.rootFile });
		appendSession(fixture.rootFile, [
			childRecord("r1", { uuid: "child-uuid", parentUuid: ROOT_ID, sessionFile: child }),
		]);

		const cost = await readCost(fixture.rootFile);
		const agent = cost.agents.find((entry) => entry.uuid === "child-uuid")!;
		expect(agent.observedModel).toMatchObject({
			known: true,
			provider: "openai",
			id: "gpt-actual",
			evidence: "response-model",
			branch: "last-recorded",
		});
		expect(agent.lastContext).toMatchObject({
			kind: "request-input",
			source: "transcript",
			tokens: 12025,
			provider: "openai",
			model: "gpt-requested",
			provenance: "before-compaction",
			branch: "last-recorded",
		});
		expect(agent.lastContext?.observedAt).toBeGreaterThan(0);
	});

	it("skips a forked child's inherited model and context", async () => {
		fixture = makeFixture();
		const child = childFile(fixture, "fork-observed");
		const inherited = { ...assistant("ra", usage(4000, 10, 5000, 0, 0.4), { model: "parent-model" }), parentId: null };
		const own = {
			...assistant("own", usage(20, 2, 30, 0, 0.02), { provider: "deepseek", model: "deepseek-flash" }),
			parentId: "ra",
		};
		writeSession(child, "fork-session", [inherited, own], { parentSession: fixture.rootFile });
		appendSession(fixture.rootFile, [
			inherited,
			childRecord("r1", { uuid: "child-uuid", parentUuid: ROOT_ID, sessionFile: child, forked: true }),
		]);

		const cost = await readCost(fixture.rootFile);
		const agent = cost.agents.find((entry) => entry.uuid === "child-uuid")!;
		expect(agent.observedModel).toMatchObject({ id: "deepseek-flash" });
		expect(agent.lastContext).toMatchObject({ tokens: 50, model: "deepseek-flash" });
	});

	it("follows the parent chain even when another entry has a later timestamp", async () => {
		fixture = makeFixture();
		const side = { ...assistant("side", usage(99, 1, 99, 0, 0.9), { model: "side-model" }), timestamp: "2030-01-01T00:00:00Z", parentId: null };
		const first = { ...assistant("a1", usage(10, 1, 20, 0, 0.1), { model: "older-model" }), timestamp: "2021-01-01T00:00:00Z", parentId: null };
		const second = {
			...assistant("a2", usage(30, 1, 40, 0, 0.2), { model: "newer-model" }),
			timestamp: "2022-01-01T00:00:00Z",
			parentId: "a1",
		};
		writeSession(fixture.rootFile, ROOT_ID, [side, first, second]);

		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.observedModel).toMatchObject({ id: "newer-model" });
		expect(cost.agents[0]?.lastContext).toMatchObject({ tokens: 70 });
	});

	it("keeps an undated or malformed request input unknown while keeping the observed model", async () => {
		fixture = makeFixture();
		const undated = {
			type: "message",
			id: "a1",
			parentId: null,
			message: { role: "assistant", provider: "openai", model: "observed", usage: usage(10, 1, 20, 0, 0.1) },
		};
		const malformed = {
			...assistant("a2", usage(10, 1, -5, 0, 0.1), { model: "second" }),
			parentId: "a1",
		};
		writeSession(fixture.rootFile, ROOT_ID, [undated, malformed]);

		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.observedModel).toMatchObject({ id: "second" });
		expect(cost.agents[0]?.lastContext).toBeUndefined();
	});

	it("keeps the last measured request input when a later request has invalid usage", async () => {
		fixture = makeFixture();
		const valid = {
			...assistant("a1", usage(10, 1, 20, 0, 0.1), { model: "measured" }),
			timestamp: "2026-11-09T10:00:00Z",
			parentId: null,
		};
		const invalid = {
			...assistant("a2", usage(10, 1, -1, 0, 0.2), { model: "invalid" }),
			timestamp: "2026-11-09T10:05:00Z",
			parentId: "a1",
		};
		writeSession(fixture.rootFile, ROOT_ID, [valid, invalid]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.lastContext).toMatchObject({
			tokens: 30,
			observedAt: Date.parse("2026-11-09T10:00:00Z"),
			branch: "last-recorded",
		});
		expect(cost.agents[0]?.observedModel).toMatchObject({ id: "invalid" });
	});

	it("keeps spend when timestamp metadata is malformed", async () => {
		fixture = makeFixture();
		const line = {
			...assistant("a1", usage(10, 2, 4, 0, 0.5), { model: "observed" }),
			timestamp: 123,
			parentId: null,
		};
		writeSession(fixture.rootFile, ROOT_ID, [line]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.own).toMatchObject({ input: 10, output: 2, cacheRead: 4, cost: 0.5 });
		expect(cost.agents[0]?.known).toBe(true);
		expect(cost.agents[0]?.lastContext).toBeUndefined();
		expect(cost.agents[0]?.observedModel).toMatchObject({ id: "observed", observedAt: null });
	});

	it("rejects fractional, unsafe, and impossible calendar request input while keeping spend", async () => {
		const cases = [
			{ name: "fractional", u: usage(1.5, 1, 2, 0, 0.1), timestamp: "2026-11-09T10:00:00Z" },
			{ name: "unsafe", u: usage(Number.MAX_SAFE_INTEGER + 1, 1, 0, 0, 0.1), timestamp: "2026-11-09T10:00:00Z" },
			{ name: "invalid-calendar", u: usage(10, 1, 20, 0, 0.1), timestamp: "2026-02-30T10:00:00Z" },
		];
		for (const tc of cases) {
			fixture = makeFixture();
			const line = { ...assistant("a1", tc.u, { model: "observed" }), timestamp: tc.timestamp, parentId: null };
			writeSession(fixture.rootFile, ROOT_ID, [line]);
			const cost = await readCost(fixture.rootFile);
			expect(cost.agents[0]?.lastContext, tc.name).toBeUndefined();
			expect(cost.agents[0]?.own.cost, tc.name).toBeCloseTo(0.1);
			expect(cost.agents[0]?.known, tc.name).toBe(true);
		}
	});

	it("rejects fractional lexemes that round to a safe integer", async () => {
		for (const input of ["9007199254740991.1", "1.0000000000000001"]) {
			fixture = makeFixture();
			writeRawSession(fixture.rootFile, ROOT_ID, [
				rawAssistant("a1", `{"input":${input},"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.1}}`),
			]);
			const cost = await readCost(fixture.rootFile);
			expect(cost.agents[0]?.lastContext, input).toBeUndefined();
			expect(cost.agents[0]?.own.cost, input).toBeCloseTo(0.1);
			expect(cost.agents[0]?.known, input).toBe(true);
		}
	});

	it("accepts genuinely integral exponent notation for request input", async () => {
		fixture = makeFixture();
		writeRawSession(fixture.rootFile, ROOT_ID, [
			rawAssistant("a1", '{"input":1.0e3,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.1}}'),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.lastContext).toMatchObject({ tokens: 1_000 });
	});

	it("uses only the effective message usage, not nested tool-call usage", async () => {
		fixture = makeFixture();
		const line = {
			...assistant("a1", usage(10, 1, 20, 0, 0.1), { model: "observed" }),
			parentId: null,
			message: {
				role: "assistant",
				provider: "openai",
				model: "observed",
				usage: usage(10, 1, 20, 0, 0.1),
				content: [
					{
						type: "toolCall",
						arguments: {
							usage: usage(900_000, 800_000, 700_000, 600_000, 99),
						},
					},
				],
			},
		};
		writeSession(fixture.rootFile, ROOT_ID, [line]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.lastContext).toMatchObject({ tokens: 30 });
	});

	it("rejects a duplicate request-input field whose effective value is not a number", async () => {
		fixture = makeFixture();
		writeRawSession(fixture.rootFile, ROOT_ID, [
			rawAssistant("a1", '{"input":10,"input":"bad","output":1,"cacheRead":1,"cacheWrite":0,"cost":{"total":0.1}}'),
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.lastContext).toBeUndefined();
	});

	it("reads the effective duplicate usage object", async () => {
		fixture = makeFixture();
		writeRawSession(fixture.rootFile, ROOT_ID, [
			'{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-09T10:00:00Z","message":{"role":"assistant","provider":"openai","model":"observed","usage":{"input":1,"output":1,"cacheRead":1,"cacheWrite":0,"cost":{"total":0.1}},"usage":{"input":100,"output":1,"cacheRead":20,"cacheWrite":0,"cost":{"total":0.2}}}}',
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.lastContext).toMatchObject({ tokens: 120 });
		expect(cost.agents[0]?.own.cost).toBeCloseTo(0.2);
	});

	it("keeps a valid deep entry's spend and skips only its exact history", async () => {
		fixture = makeFixture();
		const deep = `[`.repeat(20_000) + "0" + `]`.repeat(20_000);
		const deepLine =
			`{"type":"message","id":"a1","parentId":null,"timestamp":"2026-11-09T10:00:00Z",` +
			`"message":{"role":"assistant","provider":"openai","model":"deep","usage":{"input":10,"output":1,"cacheRead":20,"cacheWrite":0,"cost":{"total":0.1}},"content":${deep}}}`;
		const normal = rawAssistant("a2", '{"input":5,"output":1,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.2}}').replace(
			'"parentId":null',
			'"parentId":"a1"',
		);
		writeRawSession(fixture.rootFile, ROOT_ID, [deepLine, normal]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.own.cost).toBeCloseTo(0.3);
		expect(cost.agents[0]?.lastContext).toMatchObject({ tokens: 5 });
	});

	it("does not use rounded disk values when the runtime has no JSON source support", async () => {
		fixture = makeFixture();
		writeRawSession(fixture.rootFile, ROOT_ID, [
			rawAssistant("a1", '{"input":1.0000000000000001,"output":1,"cacheRead":20,"cacheWrite":0,"cost":{"total":0.1}}').replace(
				'"model":"observed"',
				'"model":"rounded-only"',
			),
		]);
		const original = JSON.parse;
		JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
			if (!reviver) return original(text);
			return original(text, function (key, value) {
				return reviver.call(this, key, value);
			});
		}) as typeof JSON.parse;
		vi.resetModules();
		try {
			const fresh = await import("../extensions/costs/scan.js");
			const cost = await fresh.readCost(fixture.rootFile);
			expect(cost.agents[0]?.own.cost).toBeCloseTo(0.1);
			expect(cost.agents[0]?.observedModel).toMatchObject({ id: "rounded-only" });
			expect(cost.agents[0]?.lastContext).toBeUndefined();
		} finally {
			JSON.parse = original;
			vi.resetModules();
		}
	});

	it("records a model switch as the latest observed model, not the configured one", async () => {
		fixture = makeFixture();
		writeSession(fixture.rootFile, ROOT_ID, [
			{ ...assistant("a1", usage(1, 0, 0, 0, 0.1), { provider: "openai", model: "first" }), parentId: null },
			{ ...assistant("a2", usage(1, 0, 0, 0, 0.2), { provider: "deepseek", model: "second" }), parentId: "a1" },
		]);
		const cost = await readCost(fixture.rootFile);
		expect(cost.agents[0]?.observedModel).toMatchObject({ provider: "deepseek", id: "second", evidence: "message" });
	});
});
