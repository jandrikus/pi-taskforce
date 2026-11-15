import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ChildRun, type ChildActivity } from "../extensions/agents/child.js";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function streamRun(): { run: ChildRun; activities: ChildActivity[]; done: Promise<unknown> } {
	const activities: ChildActivity[] = [];
	const run = new ChildRun(
		{
			command: process.execPath,
			args: [FAKE_PI],
			cwd: process.cwd(),
			env: { ...process.env, FAKE_PI_SCRIPT: "stream" },
			task: "watch me",
			silenceTimeoutMs: 60_000,
			timeoutMs: 0,
			model: null,
			thinking: null,
		},
		{
			onSessionFile: () => {},
			onAsk: () => {},
			onEnd: () => {},
			onUpdate: () => {},
			onActivity: (event) => activities.push(event),
		},
	);
	void run.begin();
	return { run, activities, done: run.waitForEnd() };
}

describe("read-only child activity", () => {
	it("projects streamed text, thinking, tools and a truthful status", async () => {
		const { run, activities, done } = streamRun();
		await done;
		const deltas = activities.filter((e) => e.kind === "delta");
		expect(deltas).toContainEqual({ kind: "delta", index: 0, channel: "text", delta: "Hel" });
		expect(deltas).toContainEqual({ kind: "delta", index: 1, channel: "thinking", delta: "think" });
		expect(activities).toContainEqual({
			kind: "tool_start",
			toolCallId: "c1",
			name: "bash",
			args: JSON.stringify({ command: "ls" }),
		});
		expect(activities).toContainEqual({ kind: "tool_update", toolCallId: "c1", output: "partial output" });
		expect(activities).toContainEqual({ kind: "tool_end", toolCallId: "c1", isError: true });
		expect(activities.filter((e) => e.kind === "message_start")).toHaveLength(1);
		expect(activities.filter((e) => e.kind === "message_end").length).toBeGreaterThanOrEqual(1);

		const statuses = activities.filter((e) => e.kind === "status");
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.some((s) => s.kind === "status" && s.status === "running")).toBe(true);
		// The last status is after the run ended: it must not still claim running.
		const last = statuses.at(-1);
		expect(last?.kind).toBe("status");
		expect(last?.kind === "status" ? last.status : null).toBe("idle");
		expect(run.isRunning).toBe(false);
	});

	it("does not call an observer that was never registered", async () => {
		const run = new ChildRun(
			{
				command: process.execPath,
				args: [FAKE_PI],
				cwd: process.cwd(),
				env: { ...process.env, FAKE_PI_SCRIPT: "finish" },
				task: "no observer",
				silenceTimeoutMs: 60_000,
				timeoutMs: 0,
				model: null,
				thinking: null,
			},
			{ onSessionFile: () => {}, onAsk: () => {}, onEnd: () => {}, onUpdate: () => {} },
		);
		void run.begin();
		await run.waitForEnd();
		expect(run.isRunning).toBe(false);
	});
});
