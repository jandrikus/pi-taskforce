/**
 * §12. A real AgentSession compaction: the canonical answer is in the text the
 * summariser receives, so a call that compaction removes does not lose the
 * user's answer.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

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

describe("§12 compaction", () => {
	it("includes the canonical answer in the real summarisation input", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "taskforce-compaction-"));
		const log = join(cwd, "requests.jsonl");
		process.env.ASK_PROBE_LOG = log;
		process.env.ASK_PROBE_SUMMARY = "1";
		process.env.ASK_PROBE_AUTO = "0";
		try {
			const settings = SettingsManager.inMemory({ compaction: { enabled: true } } as any);
			const sm = SessionManager.inMemory(cwd, { id: "compact-session" } as never);
			sm.appendMessage({ role: "user", content: "Please ask me which target to build.", timestamp: Date.now() } as any);
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "call_compact", name: "ask", arguments: {} }],
				api: "probe-api",
				provider: "synthetic",
				model: "fake-1",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "toolUse",
				timestamp: Date.now(),
			} as any);
			sm.appendCustomMessageEntry("pi-taskforce-ask-answer", "q: Android", true, {
				v: 2,
				askId: "ask-compact",
				outcome: "answered",
				toolCallId: "call_compact",
			});
			sm.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "building android" }],
				api: "probe-api",
				provider: "synthetic",
				model: "fake-1",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			} as any);
			for (let i = 0; i < 30; i++) {
				sm.appendMessage({ role: "user", content: `filler ${i} `.repeat(4000), timestamp: Date.now() } as any);
				sm.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: `reply ${i}` }],
					api: "probe-api",
					provider: "synthetic",
					model: "fake-1",
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: "stop",
					timestamp: Date.now(),
				} as any);
			}
			(globalThis as any).__taskforceAskProbe = { requests: [], opens: [], answered: 1, autoAnswer: false };
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
				sessionManager: sm,
				noTools: "all",
				settingsManager: settings,
			} as any);
			await session.bindExtensions({ mode: "print", onError: () => {} });
			const result = await session.compact("keep the recovered answer");
			const requests = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
			expect(JSON.stringify(requests.at(-1))).toMatch(/Android/);
			expect(result.summary).toMatch(/Android/);
			expect(JSON.stringify(sm.buildSessionProjection().messages)).toMatch(/Android/);
			session.dispose();
		} finally {
			delete process.env.ASK_PROBE_LOG;
			delete process.env.ASK_PROBE_SUMMARY;
			delete process.env.ASK_PROBE_AUTO;
			delete (globalThis as any).__taskforceAskProbe;
		}
	}, 30_000);
});
