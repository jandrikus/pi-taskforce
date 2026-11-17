/**
 * §12. Two real operating-system processes: the first leaves an ask pending,
 * the second reopens the same session, restores it, answers it and runs the
 * model with the answer as the original call's tool result.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { DONE_ENTRY, WAKE_ATTEMPT_ENTRY } from "../extensions/ask/journal.js";

const seed = fileURLToPath(new URL("./fixtures/root-restart-seed.ts", import.meta.url));
const run = fileURLToPath(new URL("./fixtures/root-restart-run.ts", import.meta.url));

function runOnce(seedVariant: string) {
	const cwd = mkdtempSync(join(tmpdir(), "taskforce-root-restart-"));
	const log = join(cwd, "requests.jsonl");
	execFileSync("bun", [seed, cwd], {
		encoding: "utf8",
		env: { ...process.env, RESTART_SEED: seedVariant },
	});
	execFileSync("bun", [run, cwd], {
		encoding: "utf8",
		env: { ...process.env, PI_OFFLINE: "1", ASK_PROBE_LOG: log, ASK_PROBE_AUTO: "1" },
		timeout: 30_000,
	});
	const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
	return { cwd, requests };
}

describe("§12 a root restart in a second process", () => {
	it("reapplies a journalled submission from a previous process", () => {
		const { requests } = runOnce("submitted");
		expect(requests).toHaveLength(1);
		expect(requests[0].roles).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(JSON.stringify(requests[0].messages)).toMatch(/Android/);
		expect(JSON.stringify(requests[0].messages)).toMatch(/call_restart_ask/);
	});

	it("continues a completed canonical answer whose wake belonged to a previous process", () => {
		const { cwd, requests } = runOnce("canonical-wake");
		expect(requests).toHaveLength(1);
		expect(requests[0].roles).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(JSON.stringify(requests[0].messages)).toMatch(/Android/);
		const file = join(cwd, "sessions", readdirSync(join(cwd, "sessions")).find((name) => name.endsWith(".jsonl"))!);
		const branch = SessionManager.open(file, join(cwd, "sessions")).getBranch();
		expect(branch.filter((entry: any) => entry.type === "custom" && entry.customType === DONE_ENTRY)).toHaveLength(1);
		expect(branch.filter((entry: any) => entry.type === "custom" && entry.customType === WAKE_ATTEMPT_ENTRY)).toHaveLength(2);
	});

	it("continues a completed canonical answer that died before its wake", () => {
		const { cwd, requests } = runOnce("canonical-done");
		expect(requests).toHaveLength(1);
		expect(requests[0].roles).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(JSON.stringify(requests[0].messages)).toMatch(/Android/);
		const file = join(cwd, "sessions", readdirSync(join(cwd, "sessions")).find((name) => name.endsWith(".jsonl"))!);
		const branch = SessionManager.open(file, join(cwd, "sessions")).getBranch();
		expect(branch.filter((entry: any) => entry.type === "custom" && entry.customType === DONE_ENTRY)).toHaveLength(1);
		expect(branch.filter((entry: any) => entry.type === "custom" && entry.customType === WAKE_ATTEMPT_ENTRY)).toHaveLength(1);
	});

	it("projects the recovered answer as the original tool result", () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-root-restart-"));
		const log = join(cwd, "requests.jsonl");
		execFileSync("bun", [seed, cwd], { encoding: "utf8" });
		execFileSync("bun", [run, cwd], {
			encoding: "utf8",
			env: { ...process.env, PI_OFFLINE: "1", ASK_PROBE_LOG: log, ASK_PROBE_AUTO: "1" },
			timeout: 30_000,
		});
		expect(existsSync(log)).toBe(true);
		const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		expect(requests).toHaveLength(1);
		expect(requests[0].roles).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(JSON.stringify(requests[0].messages)).toMatch(/Android/);
		expect(JSON.stringify(requests[0].messages)).toMatch(/call_restart_ask/);
		expect(JSON.stringify(requests[0].messages)).not.toMatch(/recovered from the previous run/);

		const sessions = join(cwd, "sessions");
		const file = join(sessions, readdirSync(sessions).find((name) => name.endsWith(".jsonl"))!);
		const sm = SessionManager.open(file, sessions);
		const userTexts = sm
			.getBranch()
			.filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
			.map((entry: any) => JSON.stringify(entry.message.content));
		expect(userTexts).toHaveLength(1);
		expect(userTexts[0]).toMatch(/Start the restarted task/);
	}, 40_000);
});
