import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Taskforce } from "../extensions/runtime.js";
import { ENV } from "../extensions/agents/env.js";
import { AGENTS_EVENT_CHANNEL } from "../extensions/observe/contract.js";
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
	};
}

function busEvents(events: ReturnType<typeof eventBus>) {
	const out: any[] = [];
	events.on(AGENTS_EVENT_CHANNEL, (data) => out.push(data));
	return out;
}

function feature(root: boolean, socketPath?: string, sid = "S1") {
	const events = eventBus();
	const pi = { events, getActiveTools: () => new Set<string>() } as unknown as Parameters<ObserveFeature["start"]>[0];
	const tf = { isRoot: root } as unknown as Taskforce;
	const observe = new ObserveFeature({ tf, now: () => 5000, socketPath });
	observe.start(pi);
	const state = { sid };
	observe.bind({
		sessionManager: { getSessionId: () => state.sid },
	} as unknown as Parameters<ObserveFeature["bind"]>[0]);
	return { events, observe, state };
}

async function waitFor(check: () => boolean, ms = 3_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("timed out");
}

describe("nested activity channel", () => {
	it.each([false, true])("removes its own socket directory on disposal, immediate=%s", async (immediate) => {
		const previous = process.env[ENV.observe];
		const root = feature(true);
		const socket = process.env[ENV.observe]!;
		const dir = dirname(socket);
		try {
			expect(statSync(dir).mode & 0o777).toBe(0o700);
			if (!immediate) await waitFor(() => existsSync(socket));
			root.observe.dispose();
			root.observe.dispose();
			expect(existsSync(socket)).toBe(false);
			expect(existsSync(dir)).toBe(false);
		} finally {
			root.observe.dispose();
			rmSync(dir, { recursive: true, force: true });
			if (previous === undefined) delete process.env[ENV.observe];
			else process.env[ENV.observe] = previous;
		}
	});

	it("does not recursively remove unexpected files in its own directory", () => {
		const previous = process.env[ENV.observe];
		const root = feature(true);
		const socket = process.env[ENV.observe]!;
		const dir = dirname(socket);
		const retained = join(dir, "keep.txt");
		try {
			writeFileSync(retained, "keep");
			root.observe.dispose();
			expect(existsSync(socket)).toBe(false);
			expect(readFileSync(retained, "utf8")).toBe("keep");
		} finally {
			root.observe.dispose();
			rmSync(dir, { recursive: true, force: true });
			if (previous === undefined) delete process.env[ENV.observe];
			else process.env[ENV.observe] = previous;
		}
	});

	it("carries a grandchild's live activity from a child process to the root", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tf-observe-"));
		const socket = join(dir, "observe.sock");
		const root = feature(true, socket);
		const rootEvents = busEvents(root.events);
		const child = feature(false, socket);
		const childEvents = busEvents(child.events);
		try {
			child.observe.activity("G1", {
				kind: "status",
				status: "running",
				activity: "working",
				waiting: false,
				runElapsedMs: 1200,
			});
			await waitFor(() => rootEvents.length > 0);
			expect(rootEvents[0]).toMatchObject({
				version: 1,
				sessionId: "S1",
				agentId: "G1",
				at: 5000,
				event: { kind: "status", status: "running", activity: "working" },
			});
			// The child process's own event bus has no reader; it only forwards.
			expect(childEvents).toHaveLength(0);

			child.observe.activity("G1", {
				kind: "delta",
				index: 0,
				channel: "text",
				delta: "hello",
			});
			await waitFor(() => rootEvents.length > 1);
			expect(rootEvents[1]).toMatchObject({ agentId: "G1", event: { kind: "delta", delta: "hello" } });

			// The root's own direct child still publishes locally, unchanged.
			root.observe.activity("C1", { kind: "message_start" });
			expect(rootEvents.at(-1)).toMatchObject({ sessionId: "S1", agentId: "C1" });
		} finally {
			child.observe.dispose();
			root.observe.dispose();
			expect(() => statSync(socket)).toThrow();
			// An injected path is caller-owned, even when its directory is empty.
			expect(statSync(dir).isDirectory()).toBe(true);
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not forward before a session is bound and drops malformed lines", async () => {
		const dir = mkdtempSync(join(tmpdir(), "tf-observe-"));
		const socket = join(dir, "observe.sock");
		const root = feature(true, socket);
		const rootEvents = busEvents(root.events);
		const events = eventBus();
		const unbound = new ObserveFeature({
			tf: { isRoot: false } as unknown as Taskforce,
			socketPath: socket,
		});
		unbound.start({ events, getActiveTools: () => new Set<string>() } as unknown as Parameters<ObserveFeature["start"]>[0]);
		try {
			unbound.activity("G1", { kind: "message_start" });
			await new Promise((r) => setTimeout(r, 200));
			expect(rootEvents).toHaveLength(0);
			unbound.dispose();
			root.observe.dispose();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("nested channel environment", () => {
	it("passes the root socket down through a child's launch environment", async () => {
		const { buildChildEnv, ENV, readChildIdentity } = await import("../extensions/agents/env.js");
		const previous = process.env[ENV.observe];
		process.env[ENV.observe] = "/tmp/root-observe.sock";
		try {
			const env = buildChildEnv({
				agentId: "C1",
				parentId: "ROOT",
				agentType: "worker",
				depth: 2,
				maxDepth: 3,
				maxRunning: 4,
				silenceTimeoutMs: 1000,
				features: { todos: true, subagents: true, ask: true },
				forked: false,
				forkPath: false,
				spawnable: null,
				projectTrusted: true,
				tools: null,
			});
			expect(env[ENV.observe]).toBe("/tmp/root-observe.sock");
			expect(readChildIdentity(env)?.agentId).toBe("C1");
		} finally {
			if (previous === undefined) delete process.env[ENV.observe];
			else process.env[ENV.observe] = previous;
		}
	});
});
