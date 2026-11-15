import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../extensions/agents/records.js";
import type { Cost, CostAgent, Usage } from "../extensions/costs/scan.js";
import { buildStatsSnapshot, type StatsInput } from "../extensions/stats/build.js";
import type { StatsRun } from "../extensions/stats/build.js";
import { parseTodo } from "../extensions/todos/parse.js";
import type { TodoFile } from "../extensions/todos/watcher.js";

function amount(cost: number): Usage {
	return { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost };
}

function costAgent(uuid: string, parentUuid: string | null, depth: number, own: number, failed = false): CostAgent {
	return {
		uuid,
		parentUuid,
		type: uuid === "root" ? null : "scout",
		depth,
		forked: false,
		failed,
		status: "ok",
		note: "",
		own: amount(own),
		known: true,
		subtree: amount(own),
		subtreeKnown: true,
		models: [],
	};
}

function sample(): Cost {
	return {
		total: amount(0.6),
		own: amount(0.1),
		descendants: amount(0.5),
		models: [{ key: "deepseek/deepseek-flash", usage: amount(0.6) }],
		agents: [costAgent("root", null, 1, 0.1), costAgent("child", "root", 2, 0.3), costAgent("nested", "child", 3, 0.2)],
		incomplete: false,
	};
}

function record(uuid: string, parentUuid: string | null, depth: number, failed = false): AgentRecord {
	return {
		uuid,
		parentUuid,
		type: "scout",
		failed,
		sessionFile: `/tmp/${uuid}.jsonl`,
		spawnedAt: depth,
		depth,
		forked: false,
	};
}

function todoFile(): TodoFile {
	return {
		name: "2026-01-01-work.md",
		path: "/todos/2026-01-01-work.md",
		mtimeMs: 123,
		...parseTodo("# Work\n- [x] done\n- [ ] next\n", "fallback"),
	};
}

function baseInput(overrides: Partial<StatsInput> = {}): StatsInput {
	return {
		session: {
			id: "root",
			file: "/tmp/root.jsonl",
			cwd: "/work",
			idle: true,
			model: { provider: "deepseek", id: "deepseek-flash" },
			context: { tokens: 100, contextWindow: 1000, percent: 10 },
			sessionAgeMs: 60_000,
			lastActivityAt: 1_700_000_000_000,
		},
		costs: { cost: sample(), scanning: false, error: null, stale: false },
		records: [record("child", "root", 2), record("old", "root", 2, true)],
		supervisor: null,
		definitions: new Map([["scout", { model: "deepseek/deepseek-flash" }]]),
		todos: [todoFile()],
		...overrides,
	};
}

describe("session stats snapshot", () => {
	it("keeps root own and known descendant totals, model buckets, and session age", () => {
		const snapshot = buildStatsSnapshot(baseInput());
		expect(snapshot.session.status).toBe("idle");
		expect(snapshot.session.sessionAgeMs).toBe(60_000);
		expect(snapshot.costs.available).toBe(true);
		expect(snapshot.costs.total?.cost).toBeCloseTo(0.6);
		expect(snapshot.costs.own?.cost).toBeCloseTo(0.1);
		expect(snapshot.costs.descendants?.cost).toBeCloseTo(0.5);
		expect(snapshot.costs.models[0]?.key).toBe("deepseek/deepseek-flash");
		expect(snapshot.session.model).toEqual({ known: true, provider: "deepseek", id: "deepseek-flash" });
	});

	it("labels live child status, configured model, and run elapsed only from a current run", () => {
		const run: StatsRun = { isRunning: true, isIdle: false, status: "running", durationMs: 12_000 };
		const snapshot = buildStatsSnapshot(
			baseInput({
				supervisor: {
					runFor: (uuid) => (uuid === "child" ? run : undefined),
					contextUsageOf: (uuid) =>
						uuid === "child" ? { tokens: 300, contextWindow: 1000, percent: 30, stale: false } : null,
				},
			}),
		);

		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		expect(child.status).toBe("running");
		expect(child.statusEvidence).toBe("live-run");
		expect(child.runElapsedMs).toBe(12_000);
		expect(child.configuredModel).toBe("deepseek/deepseek-flash");
		expect(child.context).toMatchObject({ known: true, tokens: 300, source: "run" });
	});

	it("never turns absence of a run into idle evidence, and keeps a stored failure separate", () => {
		const snapshot = buildStatsSnapshot(
			baseInput({
				supervisor: {
					runFor: () => undefined,
					contextUsageOf: () => null,
				},
			}),
		);

		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		const old = snapshot.agents.find((agent) => agent.uuid === "old")!;
		expect(child.status).toBe("unknown");
		expect(child.statusEvidence).toBe("none");
		expect(child.runElapsedMs).toBeNull();
		expect(child.storedFailure).toBe(false);
		expect(old.status).toBe("unknown");
		expect(old.storedFailure).toBe(true);
		expect(child.context.known).toBe(false);
	});

	it("keeps indirect descendants unknown because this process does not supervise them", () => {
		const snapshot = buildStatsSnapshot(baseInput());
		const nested = snapshot.agents.find((agent) => agent.uuid === "nested")!;
		expect(nested.status).toBe("unknown");
		expect(nested.statusEvidence).toBe("none");
		expect(nested.runElapsedMs).toBeNull();
		expect(nested.context.known).toBe(false);
		expect(nested.cost?.own.cost).toBeCloseTo(0.2);
	});

	it("exposes parsed TODO items as session-owned and retains no per-agent ownership", () => {
		const snapshot = buildStatsSnapshot(baseInput());
		expect(snapshot.todos).toHaveLength(1);
		expect(snapshot.todos[0]).toMatchObject({
			title: "Work",
			done: 1,
			total: 2,
			remaining: 1,
			owner: { kind: "session", sessionId: "root" },
		});
		expect(snapshot.todos[0]?.items).toEqual([
			{ text: "done", done: true },
			{ text: "next", done: false },
		]);
	});

	it("does not revive a forked parent's child records for the new root", () => {
		const rootOnly: Cost = {
			...sample(),
			total: amount(0.1),
			own: amount(0.1),
			descendants: amount(0),
			agents: [costAgent("root", null, 1, 0.1)],
		};
		const snapshot = buildStatsSnapshot(
			baseInput({
				costs: { cost: rootOnly, scanning: false, error: null, stale: false },
				records: [record("inherited", "old-root", 2, true)],
			}),
		);
		expect(snapshot.agents).toEqual([]);
	});

	it("keeps unreadable costs unavailable instead of presenting a zero total", () => {
		const snapshot = buildStatsSnapshot(
			baseInput({
				costs: { cost: null, scanning: true, error: null, stale: false },
			}),
		);
		expect(snapshot.costs.available).toBe(false);
		expect(snapshot.costs.total).toBeNull();
		expect(snapshot.costs.own).toBeNull();
		expect(snapshot.costs.descendants).toBeNull();
		expect(snapshot.problems).toContain("Costs are still being read.");
		for (const agent of snapshot.agents) expect(agent.cost).toBeNull();
	});

	it("reports a failed read without inventing a snapshot", () => {
		const snapshot = buildStatsSnapshot(
			baseInput({
				costs: { cost: null, scanning: false, error: "permission denied", stale: true },
			}),
		);
		expect(snapshot.costs.available).toBe(false);
		expect(snapshot.costs.total).toBeNull();
		expect(snapshot.costs.error).toBe("permission denied");
		expect(snapshot.problems.some((problem) => problem.includes("permission denied"))).toBe(true);
	});
});

describe("session stats: historical model and context evidence", () => {
	const observedModel = {
		known: true as const,
		provider: "openai",
		id: "gpt-actual",
		observedAt: 1_700_000_000_000,
		evidence: "response-model" as const,
		branch: "last-recorded" as const,
	};
	const lastContext = {
		kind: "request-input" as const,
		source: "transcript" as const,
		tokens: 12_000,
		observedAt: 1_700_000_000_000,
		provider: "openai",
		model: "gpt-requested",
		provenance: "before-compaction" as const,
		branch: "last-recorded" as const,
	};

	function historicalCost(): Cost {
		const base = sample();
		return {
			...base,
			agents: base.agents.map((agent) =>
				agent.uuid === "root"
					? { ...agent, observedModel, lastContext }
					: agent.uuid === "nested"
						? { ...agent, observedModel, lastContext }
						: agent,
			),
		};
	}

	it("uses the actual live leaf branch for the root instead of the persisted last entry", () => {
		const base = baseInput();
		const branch = [
			{
				id: "live-leaf",
				parentId: null,
				type: "message",
				timestamp: "2026-11-09T10:05:00Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-active",
					usage: { input: 1000, output: 2, cacheRead: 500, cacheWrite: 25, cost: 0.2 },
				},
			},
		];
		const snapshot = buildStatsSnapshot({
			...base,
			session: { ...base.session, model: null, context: undefined, activeBranch: branch },
			costs: { ...base.costs, cost: historicalCost() },
		});
		expect(snapshot.session.observedModel).toMatchObject({ id: "gpt-active", branch: "active" });
		expect(snapshot.session.context).toMatchObject({
			known: true,
			tokens: 1525,
			source: "transcript",
			measurement: "request-input",
			branch: "active",
		});
	});

	it("does not fall back to abandoned root history when the live branch is known empty", () => {
		const base = baseInput();
		const snapshot = buildStatsSnapshot({
			...base,
			session: { ...base.session, model: null, context: undefined, activeBranch: [] },
			costs: { ...base.costs, cost: historicalCost() },
		});
		expect(snapshot.session.activeBranchKnown).toBe(true);
		expect(snapshot.session.observedModel).toBeNull();
		expect(snapshot.session.context).toMatchObject({ known: false, source: "root" });
	});

	it("does not fall back to root history when the known live branch has no observation", () => {
		const base = baseInput();
		const branch = [
			{
				id: "user-only",
				parentId: null,
				type: "message",
				timestamp: "2026-11-09T10:05:00Z",
				message: { role: "user", content: "no assistant yet" },
			},
		];
		const snapshot = buildStatsSnapshot({
			...base,
			session: { ...base.session, model: null, context: undefined, activeBranch: branch },
			costs: { ...base.costs, cost: historicalCost() },
		});
		expect(snapshot.session.activeBranchKnown).toBe(true);
		expect(snapshot.session.observedModel).toBeNull();
		expect(snapshot.session.context).toMatchObject({ known: false, source: "root" });
	});

	it("still uses root history when branch availability is unknown", () => {
		const base = baseInput();
		const snapshot = buildStatsSnapshot({
			...base,
			session: { ...base.session, model: null, context: undefined, activeBranch: undefined },
			costs: { ...base.costs, cost: historicalCost() },
		});
		expect(snapshot.session.activeBranchKnown).toBe(false);
		expect(snapshot.session.observedModel).toEqual(observedModel);
		expect(snapshot.session.context).toMatchObject({ known: true, tokens: 12_000 });
	});

	it("does not let a running child's unmeasured live reading mask its durable history", () => {
		const base = baseInput();
		const cost = sample();
		const withChildHistory: Cost = {
			...cost,
			agents: cost.agents.map((agent) =>
				agent.uuid === "child" ? { ...agent, observedModel, lastContext } : agent,
			),
		};
		const run: StatsRun = { isRunning: true, isIdle: false, status: "running", durationMs: 9_000 };
		const snapshot = buildStatsSnapshot({
			...base,
			costs: { ...base.costs, cost: withChildHistory },
			supervisor: {
				runFor: (uuid) => (uuid === "child" ? run : undefined),
				contextUsageOf: () => ({ tokens: null, contextWindow: 1000, percent: null, stale: false }),
			},
		});
		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		expect(child.context).toMatchObject({ known: true, tokens: 12_000, source: "transcript" });
	});

	it("accepts zero as a real live context measurement", () => {
		const base = baseInput();
		const run: StatsRun = { isRunning: true, isIdle: false, status: "running", durationMs: 1_000 };
		const snapshot = buildStatsSnapshot({
			...base,
			supervisor: {
				runFor: (uuid) => (uuid === "child" ? run : undefined),
				contextUsageOf: () => ({ tokens: 0, contextWindow: 1000, percent: 0, stale: false }),
			},
		});
		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		expect(child.context).toMatchObject({ known: true, tokens: 0, source: "run", measurement: "live" });
	});

	it("uses the root's last observed model and request input only when live readings are missing", () => {
		const base = baseInput();
		const snapshot = buildStatsSnapshot({
			...base,
			session: {
				...base.session,
				model: null,
				context: undefined,
			},
			costs: { ...base.costs, cost: historicalCost() },
		});

		expect(snapshot.session.model.known).toBe(false);
		expect(snapshot.session.observedModel).toEqual(observedModel);
		expect(snapshot.session.context).toMatchObject({
			known: true,
			tokens: 12_000,
			contextWindow: null,
			percent: null,
			stale: true,
			source: "transcript",
			measurement: "request-input",
			provenance: "before-compaction",
			requestModel: { known: true, provider: "openai", id: "gpt-requested" },
		});
	});

	it("lets a live measured context win while keeping historical model evidence separate", () => {
		const run: StatsRun = { isRunning: true, isIdle: false, status: "running", durationMs: 12_000 };
		const snapshot = buildStatsSnapshot(
			baseInput({
				costs: { cost: historicalCost(), scanning: false, error: null, stale: false },
				supervisor: {
					runFor: (uuid) => (uuid === "child" ? run : undefined),
					contextUsageOf: (uuid) =>
						uuid === "child" ? { tokens: 300, contextWindow: 1_000, percent: 30, stale: false } : null,
				},
			}),
		);

		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		expect(child.context).toMatchObject({ known: true, tokens: 300, source: "run", measurement: "live" });

		const nested = snapshot.agents.find((agent) => agent.uuid === "nested")!;
		expect(nested.context).toMatchObject({ known: true, tokens: 12_000, source: "transcript", measurement: "request-input" });
		expect(nested.observedModel).toEqual(observedModel);
	});

	it("uses historical context for a stopped child even when a stale run object exists", () => {
		const stopped: StatsRun = { isRunning: false, isIdle: true, status: "idle", durationMs: 60_000 };
		const snapshot = buildStatsSnapshot(
			baseInput({
				costs: { cost: historicalCost(), scanning: false, error: null, stale: false },
				supervisor: {
					runFor: (uuid) => (uuid === "nested" ? stopped : undefined),
					contextUsageOf: () => null,
				},
			}),
		);
		const nested = snapshot.agents.find((agent) => agent.uuid === "nested")!;
		expect(nested.status).toBe("unknown");
		expect(nested.context).toMatchObject({ known: true, tokens: 12_000, source: "transcript", measurement: "request-input" });
	});

	it("keeps context unknown when there is neither a live reading nor a trustworthy transcript measurement", () => {
		const base = baseInput();
		const snapshot = buildStatsSnapshot({ ...base, session: { ...base.session, context: undefined } });
		expect(snapshot.session.context).toMatchObject({ known: false, source: "root", measurement: "none" });
		const child = snapshot.agents.find((agent) => agent.uuid === "child")!;
		expect(child.context).toMatchObject({ known: false, source: "none", measurement: "none" });
	});
});
