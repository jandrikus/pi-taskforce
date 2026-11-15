import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { CostMonitor } from "../extensions/costs/monitor.js";
import type { Cost, Usage } from "../extensions/costs/scan.js";
import { StatsFeature } from "../extensions/stats/feature.js";
import {
	STATS_REQUEST_CHANNEL,
	STATS_RESPONSE_CHANNEL,
	type StatsResponse,
} from "../extensions/stats/contract.js";
import type { Taskforce } from "../extensions/runtime.js";

function amount(cost: number): Usage {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost };
}

function sample(): Cost {
	return {
		total: amount(0.3),
		own: amount(0.1),
		descendants: amount(0.2),
		models: [{ key: "deepseek/deepseek-flash", usage: amount(0.3) }],
		agents: [
			{
				uuid: "root",
				parentUuid: null,
				type: null,
				depth: 1,
				forked: false,
				failed: false,
				status: "ok",
				note: "",
				own: amount(0.1),
				known: true,
				subtree: amount(0.3),
				subtreeKnown: true,
				models: [],
			},
		],
		incomplete: false,
	};
}

function fakeContext(id: string, file: string, branch: readonly unknown[] = []): ExtensionContext {
	return {
		mode: "rpc",
		hasUI: true,
		cwd: "/work",
		model: { provider: "deepseek", id: "deepseek-flash" },
		isIdle: () => true,
		getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }),
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => file,
			getHeader: () => ({ type: "session", id, timestamp: new Date(1_000).toISOString() }),
			getEntries: () => [{ timestamp: new Date(2_000).toISOString() }],
			getBranch: () => branch,
		},
		ui: { notify: () => {} },
	} as unknown as ExtensionContext;
}

function fakeTaskforce(): Taskforce {
	return {
		cwd: "/work",
		children: { all: () => [] },
		catalog: { byName: new Map() },
		supervisor: null,
	} as unknown as Taskforce;
}

function harness(read: (path: string) => Promise<Cost> = async () => sample()) {
	const monitor = new CostMonitor({ read, getLive: () => false });
	const costs = {
		monitor,
		refresh: () => monitor.refresh(),
	} as unknown as import("../extensions/costs/feature.js").CostFeature;
	const stats = new StatsFeature({
		tf: fakeTaskforce(),
		costs,
		todos: null,
		now: () => 10_000,
	});

	const handlers = new Map<string, Set<(data: unknown) => void>>();
	const responses: StatsResponse[] = [];
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
	const pi = {
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const set = handlers.get(channel) ?? new Set();
				set.add(handler);
				handlers.set(channel, set);
				return () => set.delete(handler);
			},
			emit: (channel: string, data: unknown) => {
				if (channel === STATS_RESPONSE_CHANNEL) {
					responses.push(data as StatsResponse);
					return;
				}
				for (const handler of handlers.get(channel) ?? []) handler(data);
			},
		},
		registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => {
			commands.set(name, command.handler);
		},
	} as unknown as ExtensionAPI;

	stats.register(pi);
	stats.start(pi);
	const bind = (id: string, file: string, branch: readonly unknown[] = []) => {
		stats.bind(fakeContext(id, file, branch));
		monitor.bind(file);
	};
	return { stats, monitor, responses, commands, bind, request: (data: unknown) => pi.events.emit(STATS_REQUEST_CHANNEL, data) };
}

describe("stats request channel", () => {
	it("answers a request for the current session with version 1 and a snapshot", async () => {
		const { stats, bind, responses, request } = harness();
		try {
			bind("session-1", "/tmp/one.jsonl");
			request({ requestId: "req-1", sessionId: "session-1" });
			await vi.waitFor(() => expect(responses).toHaveLength(1));
			const response = responses[0]!;
			expect(response).toMatchObject({
				requestId: "req-1",
				sessionId: "session-1",
				version: 1,
			});
			expect(response.snapshot.session.id).toBe("session-1");
			expect(response.snapshot.costs.total?.cost).toBeCloseTo(0.3);
			expect(response.snapshot.session.status).toBe("idle");
		} finally {
			stats.dispose();
		}
	});

	it("uses the live sessionManager branch for root observations", async () => {
		const { stats, bind, responses, request } = harness();
		try {
			const branch = [
				{
					id: "live-leaf",
					parentId: null,
					type: "message",
					timestamp: "2026-11-09T10:00:00Z",
					message: {
						role: "assistant",
						provider: "openai",
						model: "gpt-live",
						usage: { input: 10, output: 1, cacheRead: 20, cacheWrite: 0 },
					},
				},
			];
			bind("session-1", "/tmp/one.jsonl", branch);
			request({ requestId: "req-live", sessionId: "session-1" });
			await vi.waitFor(() => expect(responses).toHaveLength(1));
			expect(responses[0]?.snapshot.session.activeBranchKnown).toBe(true);
			expect(responses[0]?.snapshot.session.observedModel).toMatchObject({ id: "gpt-live", branch: "active" });
		} finally {
			stats.dispose();
		}
	});

	it("does not answer another session's request", async () => {
		const { stats, bind, responses, request } = harness();
		try {
			bind("session-1", "/tmp/one.jsonl");
			request({ requestId: "req-2", sessionId: "session-2" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(responses).toEqual([]);
		} finally {
			stats.dispose();
		}
	});

	it("rebinds on a session switch and stops answering after disposal", async () => {
		const { stats, bind, responses, request } = harness();
		try {
			bind("session-1", "/tmp/one.jsonl");
			request({ requestId: "old", sessionId: "session-1" });
			await vi.waitFor(() => expect(responses).toHaveLength(1));

			bind("session-2", "/tmp/two.jsonl");
			request({ requestId: "stale", sessionId: "session-1" });
			request({ requestId: "new", sessionId: "session-2" });
			await vi.waitFor(() => expect(responses.some((response) => response.requestId === "new")).toBe(true));
			expect(responses.some((response) => response.requestId === "stale")).toBe(false);

			stats.dispose();
			const before = responses.length;
			request({ requestId: "after-dispose", sessionId: "session-2" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(responses).toHaveLength(before);
		} finally {
			stats.dispose();
		}
	});

	it("drops a response when the session is replaced during an async read", async () => {
		const releases: Array<() => void> = [];
		const read = () =>
			new Promise<Cost>((resolve) => {
				releases.push(() => resolve(sample()));
			});
		const { stats, bind, responses, request } = harness(read);
		try {
			bind("session-1", "/tmp/one.jsonl");
			request({ requestId: "racing", sessionId: "session-1" });
			await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
			bind("session-2", "/tmp/two.jsonl");
			for (const release of releases.splice(0)) release();
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(responses).toEqual([]);
		} finally {
			stats.dispose();
		}
	});

	it("answers with unavailable costs when the transcript cannot be read", async () => {
		const { stats, bind, responses, request } = harness(async () => {
			throw new Error("permission denied");
		});
		try {
			bind("session-1", "/tmp/one.jsonl");
			request({ requestId: "unavailable", sessionId: "session-1" });
			await vi.waitFor(() => expect(responses).toHaveLength(1));
			const snapshot = responses[0]!.snapshot;
			expect(snapshot.costs.available).toBe(false);
			expect(snapshot.costs.total).toBeNull();
			expect(snapshot.costs.error).toContain("permission denied");
			expect(snapshot.problems.some((problem) => problem.includes("permission denied"))).toBe(true);
		} finally {
			stats.dispose();
		}
	});

	it("ignores malformed requests", async () => {
		const { stats, bind, responses, request } = harness();
		try {
			bind("session-1", "/tmp/one.jsonl");
			request(null);
			request({ requestId: "", sessionId: "session-1" });
			request({ requestId: "x" });
			await new Promise((resolve) => setTimeout(resolve, 30));
			expect(responses).toEqual([]);
		} finally {
			stats.dispose();
		}
	});
});

describe("stats command", () => {
	it("registers /stats and prints the same snapshot to a non-TUI surface", async () => {
		const { stats, commands, bind } = harness();
		try {
			const notices: string[] = [];
			const ctx = {
				...fakeContext("session-1", "/tmp/one.jsonl"),
				mode: "rpc",
				ui: { notify: (text: string) => notices.push(text) },
			} as unknown as ExtensionContext;
			bind("session-1", "/tmp/one.jsonl");
			const handler = commands.get("stats");
			expect(handler).toBeDefined();
			await handler!("", ctx);
			expect(notices.at(-1)).toContain("Session");
			expect(notices.at(-1)).toContain("Costs");
			expect(notices.at(-1)).toContain("$0.300");
			expect(notices.at(-1)).toContain("TODOs (session-owned)");
		} finally {
			stats.dispose();
		}
	});
});
