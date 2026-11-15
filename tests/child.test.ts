import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ChildRun, type RunOutcome } from "../extensions/agents/child.js";

const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function runScript(script: string): { run: ChildRun; outcome: Promise<RunOutcome> } {
	const run = new ChildRun(
		{
			command: process.execPath,
			args: [FAKE_PI],
			cwd: process.cwd(),
			env: { ...process.env, FAKE_PI_SCRIPT: script },
			task: "find the parser",
			silenceTimeoutMs: 60_000,
			timeoutMs: 0,
			model: null,
			thinking: null,
		},
		{ onSessionFile: () => {}, onAsk: () => {}, onEnd: () => {}, onUpdate: () => {} },
	);
	void run.begin();
	return { run, outcome: run.waitForEnd() };
}

describe("§10 a child's result is its last message", () => {
	it("hands over the last assistant text when the child finishes", async () => {
		const outcome = await runScript("finish").outcome;
		expect(outcome.failed).toBe(false);
		expect(outcome.reason).toBeNull();
		expect(outcome.result).toBe("Found it: the parser lives in src/parse.ts.");
	});

	it("skips a last message that only calls tools", async () => {
		const outcome = await runScript("silent-last").outcome;
		expect(outcome.result).toBe("Found it: the parser lives in src/parse.ts.");
	});

	it("knows its context use as a percentage when it finishes on its own", async () => {
		const outcome = await runScript("finish").outcome;
		expect(outcome.usage.contextWindow).toBe(1000);
		expect(outcome.usage.percent).toBe(25);
	});

	it("reports a failed final model call as a failure, not as a finish", async () => {
		const outcome = await runScript("error-last").outcome;
		expect(outcome.failed).toBe(true);
		expect(outcome.reason).toMatch(/last model call failed: 529 overloaded/);
	});

	it("reports a crash mid-run as a failure, and still hands over what it wrote", async () => {
		const outcome = await runScript("crash").outcome;
		expect(outcome.failed).toBe(true);
		expect(outcome.reason).toMatch(/exited in the middle of its run/);
		expect(outcome.result).toBe("Looking around.");
	});

	it("reads a stop as a stop, not as a crash", async () => {
		const { run, outcome } = runScript("hang");
		await new Promise((resolve) => setTimeout(resolve, 200));
		await run.stop("stopped by the user");
		const ended = await outcome;
		expect(ended.failed).toBe(false);
		expect(ended.reason).toBe("stopped by the user");
		expect(ended.result).toBeNull();
	});
});
