/**
 * §12. A real child process, started through ChildRun's RPC transport, restores
 * its own unanswered ask before its task prompt can reach the model. The parent
 * answers the new extension_ui_request; only then does the child's model run.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { ChildRun, type PendingAsk, type RunOutcome } from "../extensions/agents/child.js";
import { parseDefinition } from "../extensions/agents/definitions.js";
import { Supervisor } from "../extensions/agents/supervisor.js";
import { ANSWER_ENTRY, DONE_ENTRY, PENDING_ENTRY, SUBMIT_ENTRY } from "../extensions/ask/journal.js";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/ask-probe.ts", import.meta.url));
const ready = fileURLToPath(new URL("./fixtures/child-ready.ts", import.meta.url));
const appendFail = fileURLToPath(new URL("./fixtures/child-append-fail.ts", import.meta.url));
const ask = {
	context: "What should the child build?",
	questions: [
		{
			id: "q",
			prompt: "Which target?",
			type: "select",
			options: [
				{ value: "android", label: "Android" },
				{ value: "ios", label: "iOS" },
			],
		},
	],
};

async function waitFor<T>(check: () => T | null | undefined, timeout = 15_000): Promise<T> {
	const started = Date.now();
	while (true) {
		const value = check();
		if (value) return value;
		if (Date.now() - started > timeout) throw new Error("timed out waiting for the child");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("§12 a restarted child", () => {
	it("pauses before the model until its recovered ask is answered by the parent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-child-recovery-"));
		const sessions = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessions, { id: "child-session" });
		manager.appendMessage({ role: "user", content: "Do the recovered task.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_child_ask", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
		manager.appendCustomEntry(PENDING_ENTRY, {
			v: 2,
			id: "ask-child",
			sessionId: "child-session",
			createdAt: Date.now(),
			ask,
			from: { agentId: "child", agentType: "worker", depth: 1 },
			via: [],
			attribution: null,
			toolCallId: "call_child_ask",
			assistantEntryId,
		});
		const sessionFile = manager.getSessionFile()!;
		const log = join(cwd, "requests.jsonl");
		const readyLog = join(cwd, "ready.log");
		const config = join(cwd, "settings.json");
		writeFileSync(config, JSON.stringify({ subagents: { sharedTools: [] } }), "utf8");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: join(cwd, "agent"),
			PI_OFFLINE: "1",
			PI_TASKFORCE_AGENT_ID: "child",
			PI_TASKFORCE_PARENT_ID: "parent",
			PI_TASKFORCE_AGENT_TYPE: "worker",
			PI_TASKFORCE_DEPTH: "1",
			PI_TASKFORCE_FEATURES: JSON.stringify({ todos: false, subagents: false, ask: true }),
			PI_TASKFORCE_PROJECT_TRUSTED: "1",
			PI_TASKFORCE_SPAWNABLE: "[]",
			PI_TASKFORCE_CONFIG: config,
			ASK_PROBE_LOG: log,
			ASK_PROBE_AUTO: "0",
			CHILD_READY_LOG: readyLog,
		};
		let asked!: (pending: PendingAsk) => void;
		const askSeen = new Promise<PendingAsk>((resolve) => {
			asked = resolve;
		});
		const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		const run = new ChildRun(
			{
				command: pi,
				args: [
					"--mode",
					"rpc",
					"--no-extensions",
					"-e",
					ready,
					"-e",
					extension,
					"-e",
					probe,
					"--session",
					sessionFile,
					"--session-dir",
					sessions,
					"--no-builtin-tools",
					"--provider",
					"synthetic",
					"--model",
					"fake-1",
					"--thinking",
					"off",
				],
				cwd,
				env,
				task: "Continue the recovered task.",
				silenceTimeoutMs: 60_000,
				timeoutMs: 60_000,
				model: null,
				thinking: null,
			},
			{
				onSessionFile: () => {},
				onAsk: (pending) => asked(pending),
				onEnd: () => {},
				onUpdate: () => {},
			},
		);
		const outcome: Promise<RunOutcome> = run.waitForEnd();
		const beginning = run.begin();
		const pending = await Promise.race([
			askSeen,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`no child ask; stderr: ${run.stderrTail}`)), 8_000),
			),
		]);

		// The child reached before_agent_start with its task prompt, but must not
		// have called the model while its recovered ask is unanswered.
		await waitFor(() => existsSync(readyLog));
		expect(existsSync(log)).toBe(false);

		pending.answer({ outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false } as never] });
		await beginning;
		const finished = await outcome;
		expect(finished.failed, finished.errorOutput ?? finished.reason ?? "").toBe(false);
		await waitFor(() => existsSync(log));
		const requests = readFileSync(log, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(requests).toHaveLength(1);
		expect(requests[0].roles).toContain("toolResult");
		expect(JSON.stringify(requests[0].messages)).toMatch(/Android/);
		expect(JSON.stringify(requests[0].messages)).not.toMatch(/recovered from the previous run/);

		const reopened = SessionManager.open(sessionFile, sessions);
		const branch = reopened.getBranch();
		expect(
			branch.some(
				(entry: any) =>
					entry.type === "custom_message" &&
					entry.customType === ANSWER_ENTRY &&
					entry.details?.askId === "ask-child" &&
					entry.details?.toolCallId === "call_child_ask",
			),
		).toBe(true);
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === DONE_ENTRY)).toBe(true);
	}, 30_000);

	it("fails closed with no provider request when the recovered answer cannot be saved", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-child-gate-"));
		const sessions = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessions, { id: "child-gate" });
		manager.appendMessage({ role: "user", content: "Do the recovered task.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_child_gate", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
		manager.appendCustomEntry(PENDING_ENTRY, {
			v: 2,
			id: "ask-child-gate",
			sessionId: "child-gate",
			createdAt: Date.now(),
			ask,
			from: { agentId: "child", agentType: "worker", depth: 1 },
			via: [],
			attribution: null,
			toolCallId: "call_child_gate",
			assistantEntryId,
		});
		const sessionFile = manager.getSessionFile()!;
		const log = join(cwd, "requests.jsonl");
		const config = join(cwd, "settings.json");
		writeFileSync(config, JSON.stringify({ subagents: { sharedTools: [] } }), "utf8");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: join(cwd, "agent"),
			PI_OFFLINE: "1",
			PI_TASKFORCE_AGENT_ID: "child",
			PI_TASKFORCE_PARENT_ID: "parent",
			PI_TASKFORCE_AGENT_TYPE: "worker",
			PI_TASKFORCE_DEPTH: "1",
			PI_TASKFORCE_FEATURES: JSON.stringify({ todos: false, subagents: false, ask: true }),
			PI_TASKFORCE_PROJECT_TRUSTED: "1",
			PI_TASKFORCE_SPAWNABLE: "[]",
			PI_TASKFORCE_CONFIG: config,
			ASK_PROBE_LOG: log,
			ASK_PROBE_AUTO: "0",
		};
		let asked!: (pending: PendingAsk) => void;
		const askSeen = new Promise<PendingAsk>((resolve) => { asked = resolve; });
		const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		const run = new ChildRun(
			{
				command: pi,
				args: [
					"--mode", "rpc", "--no-extensions", "-e", extension, "-e", probe,
					"--session", sessionFile, "--session-dir", sessions,
					"--no-builtin-tools", "--provider", "synthetic", "--model", "fake-1", "--thinking", "off",
				],
				cwd,
				env,
				task: "Continue the recovered task.",
				silenceTimeoutMs: 60_000,
				timeoutMs: 60_000,
				model: null,
				thinking: null,
			},
			{ onSessionFile: () => {}, onAsk: (pending) => asked(pending), onEnd: () => {}, onUpdate: () => {} },
		);
		const outcome = run.waitForEnd();
		const beginning = run.begin();
		const pending = await Promise.race([
			askSeen,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`no child ask; stderr: ${run.stderrTail}`)), 8_000),
			),
		]);
		// The child is parked on the question. Make its next journal append fail,
		// exactly like a full disk, without preventing startup.
		chmodSync(sessionFile, 0o444);
		pending.answer({ outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false } as never] });
		await beginning;
		const finished = await Promise.race([
			outcome,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("gated child did not end")), 8_000)),
		]);
		expect(finished.failed).toBe(true);
		expect(existsSync(log)).toBe(false);
		chmodSync(sessionFile, 0o644);
		const reopened = SessionManager.open(sessionFile, sessions);
		const branch = reopened.getBranch();
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === PENDING_ENTRY && entry.data.id === "ask-child-gate")).toBe(true);
		expect(branch.some((entry: any) => entry.type === "custom_message" && entry.customType === ANSWER_ENTRY)).toBe(false);
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === DONE_ENTRY)).toBe(false);
	}, 30_000);

	it("fails closed when the queued canonical append fails after the answer is saved", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-child-append-"));
		const sessions = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessions, { id: "child-append" });
		manager.appendMessage({ role: "user", content: "Do the recovered task.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_child_append", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
		manager.appendCustomEntry(PENDING_ENTRY, {
			v: 2,
			id: "ask-child-append",
			sessionId: "child-append",
			createdAt: Date.now(),
			ask,
			from: { agentId: "child", agentType: "worker", depth: 1 },
			via: [],
			attribution: null,
			toolCallId: "call_child_append",
			assistantEntryId,
		});
		const sessionFile = manager.getSessionFile()!;
		const log = join(cwd, "requests.jsonl");
		const readyLog = join(cwd, "ready.log");
		const config = join(cwd, "settings.json");
		writeFileSync(config, JSON.stringify({ subagents: { sharedTools: [] } }), "utf8");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: join(cwd, "agent"),
			PI_OFFLINE: "1",
			PI_TASKFORCE_AGENT_ID: "child",
			PI_TASKFORCE_PARENT_ID: "parent",
			PI_TASKFORCE_AGENT_TYPE: "worker",
			PI_TASKFORCE_DEPTH: "1",
			PI_TASKFORCE_FEATURES: JSON.stringify({ todos: false, subagents: false, ask: true }),
			PI_TASKFORCE_PROJECT_TRUSTED: "1",
			PI_TASKFORCE_SPAWNABLE: "[]",
			PI_TASKFORCE_CONFIG: config,
			ASK_PROBE_LOG: log,
			ASK_PROBE_AUTO: "0",
			CHILD_APPEND_FAIL: "1",
			CHILD_READY_LOG: readyLog,
		};
		let asked!: (pending: PendingAsk) => void;
		const askSeen = new Promise<PendingAsk>((resolve) => { asked = resolve; });
		const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		const run = new ChildRun(
			{
				command: pi,
				args: [
					"--mode", "rpc", "--no-extensions", "-e", ready, "-e", extension, "-e", probe, "-e", appendFail,
					"--session", sessionFile, "--session-dir", sessions,
					"--no-builtin-tools", "--provider", "synthetic", "--model", "fake-1", "--thinking", "off",
				],
				cwd,
				env,
				task: "Continue the recovered task.",
				// A failed flush leaves pi's run active in stock 1.5.2; the silence
				// watchdog is what turns that stall into a failed child run.
				silenceTimeoutMs: 2_000,
				timeoutMs: 10_000,
				model: null,
				thinking: null,
			},
			{ onSessionFile: () => {}, onAsk: (pending) => asked(pending), onEnd: () => {}, onUpdate: () => {} },
		);
		const outcome = run.waitForEnd();
		const beginning = run.begin();
		const pending = await Promise.race([
			askSeen,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`no child ask; stderr: ${run.stderrTail}`)), 8_000),
			),
		]);
		await waitFor(() => existsSync(readyLog));
		pending.answer({ outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false } as never] });
		await beginning;
		const finished = await Promise.race([
			outcome,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("append-fail child did not end")), 8_000)),
		]);
		expect(finished.failed, finished.errorOutput ?? finished.reason ?? "").toBe(true);
		expect(existsSync(log)).toBe(false);
		const reopened = SessionManager.open(sessionFile, sessions);
		const branch = reopened.getBranch();
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === PENDING_ENTRY && entry.data.id === "ask-child-append")).toBe(true);
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === SUBMIT_ENTRY && entry.data.id === "ask-child-append")).toBe(true);
		expect(branch.some((entry: any) => entry.type === "custom_message" && entry.customType === ANSWER_ENTRY)).toBe(false);
		expect(branch.some((entry: any) => entry.type === "custom" && entry.customType === DONE_ENTRY)).toBe(false);
	}, 30_000);

	it("fails closed at the request boundary when the original call has no recovered result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-child-request-"));
		const sessions = join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessions, { id: "child-request" });
		manager.appendMessage({ role: "user", content: "Do the recovered task.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_child_request", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
		manager.appendCustomEntry(PENDING_ENTRY, {
			v: 2,
			id: "ask-child-request",
			sessionId: "child-request",
			createdAt: Date.now(),
			ask,
			from: { agentId: "child", agentType: "worker", depth: 1 },
			via: [],
			attribution: null,
			toolCallId: "call_child_request",
			assistantEntryId,
		});
		manager.appendCustomEntry(SUBMIT_ENTRY, {
			v: 2,
			id: "ask-child-request",
			at: Date.now(),
			by: "remote",
			result: { outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }] },
			sessionId: "child-request",
			submitId: "submit-request",
		});
		manager.appendCustomMessageEntry(
			ANSWER_ENTRY,
			"q: Android",
			true,
			{ v: 2, askId: "ask-child-request", outcome: "answered", toolCallId: "call_other", assistantEntryId, sessionId: "child-request" },
		);
		const sessionFile = manager.getSessionFile()!;
		const log = join(cwd, "requests.jsonl");
		const config = join(cwd, "settings.json");
		writeFileSync(config, JSON.stringify({ subagents: { sharedTools: [] } }), "utf8");
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: join(cwd, "agent"),
			PI_OFFLINE: "1",
			PI_TASKFORCE_AGENT_ID: "child",
			PI_TASKFORCE_PARENT_ID: "parent",
			PI_TASKFORCE_AGENT_TYPE: "worker",
			PI_TASKFORCE_DEPTH: "1",
			PI_TASKFORCE_FEATURES: JSON.stringify({ todos: false, subagents: false, ask: true }),
			PI_TASKFORCE_PROJECT_TRUSTED: "1",
			PI_TASKFORCE_SPAWNABLE: "[]",
			PI_TASKFORCE_CONFIG: config,
			ASK_PROBE_LOG: log,
			ASK_PROBE_AUTO: "0",
		};
		const pi = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		const run = new ChildRun(
			{
				command: pi,
				args: [
					"--mode", "rpc", "--no-extensions", "-e", extension, "-e", probe,
					"--session", sessionFile, "--session-dir", sessions,
					"--no-builtin-tools", "--provider", "synthetic", "--model", "fake-1", "--thinking", "off",
				],
				cwd,
				env,
				task: "Continue the recovered task.",
				silenceTimeoutMs: 60_000,
				timeoutMs: 60_000,
				model: null,
				thinking: null,
			},
			{ onSessionFile: () => {}, onAsk: () => {}, onEnd: () => {}, onUpdate: () => {} },
		);
		const outcome = run.waitForEnd();
		await run.begin();
		const finished = await Promise.race([
			outcome,
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("request-boundary child did not end")), 8_000)),
		]);
		expect(finished.failed, finished.errorOutput ?? finished.reason ?? "").toBe(true);
		expect(existsSync(log)).toBe(false);
	}, 30_000);

	it("restarts through the real supervisor, a new UI request id, and pauses for the answer", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-supervisor-recovery-"));
		const sessions = join(cwd, "sessions");
		const parent = SessionManager.create(cwd, sessions, { id: "parent" });
		const parentFile = parent.getSessionFile()!;
		const childDir = join(sessions, "subagents", basename(parentFile, ".jsonl"));
		mkdirSync(childDir, { recursive: true });
		const manager = SessionManager.create(cwd, childDir, { id: "child-session" });
		manager.appendMessage({ role: "user", content: "Do the recovered task.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_supervised_ask", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as never);
		const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
		manager.appendCustomEntry(PENDING_ENTRY, {
			v: 2,
			id: "ask-supervised",
			sessionId: "child-session",
			createdAt: Date.now(),
			ask,
			from: { agentId: "child", agentType: "worker", depth: 1 },
			via: [],
			attribution: null,
			toolCallId: "call_supervised_ask",
			assistantEntryId,
		});
		const childFile = manager.getSessionFile()!;
		const config = join(cwd, "settings.json");
		writeFileSync(config, JSON.stringify({ subagents: { sharedTools: [] } }), "utf8");
		const log = join(cwd, "requests.jsonl");
		const definition = parseDefinition(["name: worker", "label: Worker", "tools: []"].join("\n"), join(cwd, "worker.yaml"), "project");
		let resolveAsk!: (pending: PendingAsk) => void;
		const askSeen = new Promise<PendingAsk>((resolve) => { resolveAsk = resolve; });
		let resolveEnd!: (outcome: RunOutcome) => void;
		let endedEarly: RunOutcome | null = null;
		const ended = new Promise<RunOutcome>((resolve) => { resolveEnd = (outcome) => { endedEarly = outcome; resolve(outcome); }; });
		const previousConfig = process.env.PI_TASKFORCE_CONFIG;
		const previousEntry = process.argv[1];
		const previousProbeLog = process.env.ASK_PROBE_LOG;
		const previousProbeAuto = process.env.ASK_PROBE_AUTO;
		process.env.PI_TASKFORCE_CONFIG = config;
		process.env.ASK_PROBE_LOG = log;
		process.env.ASK_PROBE_AUTO = "0";
		process.argv[1] = execFileSync("which", ["pi"], { encoding: "utf8" }).trim();
		const supervisor = new Supervisor(
			{
				cwd,
				self: {
					uuid: "parent",
					parentUuid: null,
					type: null,
					failed: false,
					sessionFile: parentFile,
					spawnedAt: 0,
					depth: 1,
					forked: false,
				},
				features: { todos: false, subagents: true, ask: true },
				maxDepth: 3,
				maxRunning: 4,
				sharedExtensions: [probe],
				sharedTools: [],
				silenceTimeoutMs: 60_000,
				forkPath: false,
				sessionFile: parentFile,
				extensionEntry: extension,
				parentAppendSystemPrompt: null,
				spawnable: null,
				projectTrusted: true,
				inheritedPrompt: null,
				parentModel: () => ({ model: { provider: "synthetic", id: "fake-1" }, thinking: "off" }),
			},
			{
				registerChild: () => {},
				recordSessionFile: () => {},
				recordFailed: () => {},
				onAsk: (_agent, pending) => resolveAsk(pending),
				onRunEnd: (_agent, outcome) => resolveEnd(outcome),
				onUpdate: () => {},
				hasChildren: () => false,
			},
		);
		try {
			const delivery = supervisor.messageChild(
				{
					uuid: "child",
					parentUuid: "parent",
					type: definition.name,
					failed: false,
					sessionFile: childFile,
					spawnedAt: 0,
					depth: 2,
					forked: false,
				},
				definition,
				"Report the result.",
				"Continue the recovered task.",
			).then((reply) => {
				if (!reply.delivered) throw new Error(`supervisor refused restart: ${reply.error ?? "unknown"}`);
				return reply;
			});
			const pending = await Promise.race([
				askSeen,
				new Promise<never>((_, reject) =>
					setTimeout(
						() => reject(new Error(`no supervised ask; early=${JSON.stringify(endedEarly)}`)),
						8_000,
					),
				),
			]);
			expect(pending.requestId.length).toBeGreaterThan(0);
			await new Promise((resolve) => setTimeout(resolve, 150));
			expect(existsSync(log)).toBe(false);
			pending.answer({ outcome: "answered", answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }] });
			const reply = await delivery;
			expect(reply).toMatchObject({ delivered: true, restarted: true });
			const outcome = await Promise.race([
				ended,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("supervised child did not end")), 8_000),
				),
			]);
			expect(outcome.failed, outcome.errorOutput ?? outcome.reason ?? "").toBe(false);
			const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(requests.at(-1).roles).toContain("toolResult");
			expect(JSON.stringify(requests.at(-1).messages)).toMatch(/call_supervised_ask/);
			const reopened = SessionManager.open(childFile, childDir);
			expect(reopened.getBranch().some((entry: any) => entry.type === "custom_message" && entry.customType === ANSWER_ENTRY)).toBe(true);
		} finally {
			if (previousConfig === undefined) delete process.env.PI_TASKFORCE_CONFIG;
			else process.env.PI_TASKFORCE_CONFIG = previousConfig;
			if (previousEntry === undefined) delete process.argv[1];
			else process.argv[1] = previousEntry;
			if (previousProbeLog === undefined) delete process.env.ASK_PROBE_LOG;
			else process.env.ASK_PROBE_LOG = previousProbeLog;
			if (previousProbeAuto === undefined) delete process.env.ASK_PROBE_AUTO;
			else process.env.ASK_PROBE_AUTO = previousProbeAuto;
			await supervisor.stopAll("test cleanup");
			supervisor.cleanUp();
		}
	}, 40_000);
});
