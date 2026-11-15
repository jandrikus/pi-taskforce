import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../extensions/agents/records.js";
import type { ChildRun } from "../extensions/agents/child.js";
import type { Taskforce } from "../extensions/runtime.js";
import {
	AGENTS_EVENT_CHANNEL,
	AGENTS_REQUEST_CHANNEL,
	AGENTS_RESPONSE_CHANNEL,
} from "../extensions/observe/contract.js";
import { ObserveFeature } from "../extensions/observe/feature.js";

function eventBus() {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		on(channel: string, fn: (data: unknown) => void) {
			const set = handlers.get(channel) ?? new Set();
			set.add(fn);
			handlers.set(channel, set);
			return () => set.delete(fn);
		},
		emit(channel: string, data: unknown) {
			for (const fn of handlers.get(channel) ?? []) fn(data);
		},
		count(channel: string) {
			return handlers.get(channel)?.size ?? 0;
		},
	};
}

function record(uuid: string, extra: Partial<AgentRecord> = {}): AgentRecord {
	return {
		uuid,
		parentUuid: "root",
		type: "worker",
		failed: false,
		sessionFile: `/s/subagents/root/${uuid}.jsonl`,
		spawnedAt: 1,
		depth: 2,
		forked: false,
		...extra,
	};
}

function fakeRun(patch: Partial<Record<keyof ChildRun, unknown>> = {}): ChildRun {
	return {
		isRunning: true,
		status: "running",
		activity: "running bash",
		hasOpenQuestion: false,
		durationMs: 1200,
		recentToolCalls: ["read", "bash"],
		...patch,
	} as unknown as ChildRun;
}

function fakeTaskforce(
	records: AgentRecord[],
	runs: Record<string, ChildRun | undefined>,
): Taskforce {
	return {
		children: { all: () => records },
		supervisor: { runFor: (id: string) => runs[id] },
	} as unknown as Taskforce;
}

function feature(tf: Taskforce, sid = "S1") {
	const events = eventBus();
	const pi = { events, getActiveTools: () => new Set<string>() } as unknown as Parameters<ObserveFeature["start"]>[0];
	const observe = new ObserveFeature({ tf, now: () => 5000 });
	observe.start(pi);
	const state = { sid };
	const ctx = {
		sessionManager: { getSessionId: () => state.sid },
	} as unknown as Parameters<ObserveFeature["bind"]>[0];
	observe.bind(ctx);
	return { events, observe, state };
}

describe("read-only agent snapshot", () => {
	it("answers only the session this context shows", () => {
		const tf = fakeTaskforce([record("C1")], { C1: fakeRun() });
		const { events } = feature(tf);
		const answers: any[] = [];
		events.on(AGENTS_RESPONSE_CHANNEL, (d) => answers.push(d));
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r1", sessionId: "S2" });
		expect(answers).toHaveLength(0);
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r2", sessionId: "S1" });
		expect(answers).toHaveLength(1);
		expect(answers[0].version).toBe(1);
		expect(answers[0].snapshot.sessionId).toBe("S1");
		expect(answers[0].snapshot.agents[0]).toMatchObject({
			uuid: "C1",
			status: "running",
			activity: "running bash",
			waiting: false,
			runElapsedMs: 1200,
			recentTools: ["read", "bash"],
		});
	});

	it("separates a live status from the recorded outcome", () => {
		const tf = fakeTaskforce(
			[record("LIVE"), record("ENDED"), record("GONE", { failed: true }), record("NESTED", { depth: 3 })],
			{ LIVE: fakeRun({ hasOpenQuestion: true, activity: "asking a question" }), ENDED: fakeRun({ isRunning: false }) },
		);
		const { events } = feature(tf);
		const answers: any[] = [];
		events.on(AGENTS_RESPONSE_CHANNEL, (d) => answers.push(d));
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r", sessionId: "S1" });
		const byId = Object.fromEntries(answers[0].snapshot.agents.map((a: any) => [a.uuid, a]));
		expect(byId.LIVE.status).toBe("running");
		expect(byId.LIVE.waiting).toBe(true);
		expect(byId.ENDED.status).toBe("idle");
		expect(byId.GONE).toMatchObject({ status: "unknown", storedFailure: true, activity: "" });
		expect(byId.NESTED.status).toBe("unknown");
	});

	it("stops answering after the context rebinds or the feature is disposed", () => {
		const tf = fakeTaskforce([record("C1")], {});
		const { events, observe, state } = feature(tf);
		const answers: any[] = [];
		events.on(AGENTS_RESPONSE_CHANNEL, (d) => answers.push(d));
		state.sid = "S2";
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r1", sessionId: "S1" });
		expect(answers).toHaveLength(0);
		state.sid = "S1";
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r2", sessionId: "S1" });
		expect(answers).toHaveLength(0);
		observe.bind({ sessionManager: { getSessionId: () => "S1" } } as never);
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r3", sessionId: "S1" });
		expect(answers).toHaveLength(1);
		observe.dispose();
		expect(events.count(AGENTS_REQUEST_CHANNEL)).toBe(0);
		events.emit(AGENTS_REQUEST_CHANNEL, { requestId: "r4", sessionId: "S1" });
		expect(answers).toHaveLength(1);
	});
});

describe("read-only agent activity events", () => {
	it("publishes versioned events only for the bound session", () => {
		const tf = fakeTaskforce([record("C1")], { C1: fakeRun() });
		const { events, observe, state } = feature(tf);
		const got: any[] = [];
		events.on(AGENTS_EVENT_CHANNEL, (d) => got.push(d));
		observe.activity("C1", { kind: "message_end" });
		expect(got).toHaveLength(1);
		expect(got[0]).toMatchObject({
			version: 1,
			sessionId: "S1",
			agentId: "C1",
			at: 5000,
			event: { kind: "message_end" },
		});
		state.sid = "S2";
		observe.activity("C1", { kind: "message_end" });
		expect(got).toHaveLength(1);
	});
});
