/**
 * §12. A completed answer is still the result of its original call. A context
 * edit that removes the canonical message leaves the assistant call without a
 * result, so the request boundary must stop before the provider even though the
 * journal also has a normal DONE marker.
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import {
	ANSWER_ENTRY,
	DONE_ENTRY,
	PENDING_ENTRY,
	SUBMIT_ENTRY,
	WAKE_ATTEMPT_ENTRY,
} from "../extensions/ask/journal.js";

const extension = fileURLToPath(new URL("../extensions/index.ts", import.meta.url));
const probe = fileURLToPath(new URL("./fixtures/ask-probe.ts", import.meta.url));
const model = {
	id: "fake-1",
	name: "Fake 1",
	provider: "synthetic",
	api: "probe-api",
	baseUrl: "http://127.0.0.1:9/unused",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4096,
} as any;

describe("§12 a completed answer edited out of context", () => {
	it("stops the request when the original call has no result", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-context-edit-"));
		const sessions = join(cwd, "sessions");
		const log = join(cwd, "requests.jsonl");
		const manager = SessionManager.create(cwd, sessions, { id: "edit-session" });
		manager.appendMessage({ role: "user", content: "Build the app.", timestamp: Date.now() } as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_edit_ask", name: "ask", arguments: {} }],
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
			id: "ask-edit",
			sessionId: "edit-session",
			createdAt: Date.now(),
			ask: {
				context: "Edit test",
				questions: [{ id: "q", prompt: "Which target?", type: "select", options: [{ value: "android", label: "Android" }] }],
			},
			from: { agentId: "root", agentType: "root", depth: 0 },
			via: [],
			attribution: null,
			toolCallId: "call_edit_ask",
			assistantEntryId,
		});
		manager.appendCustomEntry(SUBMIT_ENTRY, {
			v: 2,
			id: "ask-edit",
			at: Date.now(),
			by: "terminal",
			sessionId: "edit-session",
			submitId: "edit-submit",
			result: {
				outcome: "answered",
				answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }],
			},
		});
		const answerId = manager.appendCustomMessageEntry(
			ANSWER_ENTRY,
			"q: Android",
			true,
			{
				v: 2,
				askId: "ask-edit",
				outcome: "answered",
				toolCallId: "call_edit_ask",
				assistantEntryId,
				sessionId: "edit-session",
				from: { agentId: "root", agentType: "root", depth: 0 },
				at: Date.now(),
			},
		);
		// Product order: DONE precedes the continuation attempt. The wake attempt
		// belongs to this test process so startup does not add a second request.
		manager.appendCustomEntry(DONE_ENTRY, {
			v: 1,
			id: "ask-edit",
			at: Date.now(),
			how: "recovered",
		});
		manager.appendCustomEntry(WAKE_ATTEMPT_ENTRY, {
			v: 2,
			id: "ask-edit",
			at: Date.now(),
			toolCallId: "call_edit_ask",
			sessionId: "edit-session",
			process: "context-edit-test-process",
			canonicalEntryId: answerId,
		});
		manager.appendContextEdit(answerId, null);

		(globalThis as any)[Symbol.for("pi-taskforce.process-id")] = "context-edit-test-process";
		process.env.ASK_PROBE_LOG = log;
		process.env.ASK_PROBE_AUTO = "0";
		(globalThis as any).__taskforceAskProbe = { requests: [], opens: [], answered: 0, autoAnswer: false };
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
		const loader = new DefaultResourceLoader({
			cwd,
			agentDir: `${cwd}/agent`,
			additionalExtensionPaths: [extension, probe],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			settingsManager: settings,
		} as any);
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir: `${cwd}/agent`,
			model,
			thinkingLevel: "off",
			resourceLoader: loader,
			sessionManager: manager,
			noTools: "all",
			settingsManager: settings,
		} as any);
		await session.bindExtensions({ mode: "print", onError: () => {} });
		await session.prompt("Continue.").catch(() => {});
		expect(existsSync(log)).toBe(false);
		expect((globalThis as any).__taskforceAskProbe.requests).toHaveLength(0);
		session.dispose();

		delete process.env.ASK_PROBE_LOG;
		delete process.env.ASK_PROBE_AUTO;
		delete (globalThis as any).__taskforceAskProbe;
	}, 30_000);
});
