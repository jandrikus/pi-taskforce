/**
 * §12. The real extension, a real AgentSession and a synthetic provider: a
 * recovered question is answered into the original ask call's tool result, and
 * the model request contains no recovery user message.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";

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

const ask = {
	context: "Build target",
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

async function waitFor(check: () => boolean, timeout = 5000): Promise<void> {
	const started = Date.now();
	while (!check()) {
		if (Date.now() - started > timeout) throw new Error("timed out waiting for the model request");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

afterEach(() => {
	delete (globalThis as any).__taskforceAskProbe;
});

describe("§12 the real extension against a synthetic provider", () => {
	it("puts a recovered answer back as the original tool result and never as user input", async () => {
		const cwd = "/tmp/taskforce-askprobe";
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
		const sm = SessionManager.inMemory(cwd, { id: "probe-session" } as never);
		sm.appendMessage({ role: "user", content: "Please ask me which target to build.", timestamp: Date.now() } as any);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_ask_1", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as any);
		sm.appendCustomEntry("pi-taskforce-ask-pending", {
			v: 2,
			id: "ask-1",
			sessionId: "probe-session",
			createdAt: Date.now(),
			ask,
			from: { agentId: "root", agentType: "root", depth: 0 },
			via: [],
			attribution: null,
			toolCallId: "call_ask_1",
			assistantEntryId: null,
		});
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
		expect(loader.getExtensions().errors).toEqual([]);
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
		const state = (globalThis as any).__taskforceAskProbe;
		await waitFor(() => state.requests.length > 0);

		const request = state.requests[0];
		expect(request.roles).toEqual(["system", "user", "assistant", "toolResult"]);
		expect(request.roles).not.toContain("custom");
		expect(JSON.stringify(request.messages.at(-1))).toMatch(/Android/);
		expect(JSON.stringify(request.messages)).not.toMatch(/recovered from the previous run/);

		const userTexts = sm
			.getBranch()
			.filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
			.map((entry: any) => JSON.stringify(entry.message.content));
		expect(userTexts).toHaveLength(1);
		expect(userTexts[0]).toMatch(/Please ask me which target/);
		expect(
			sm.getBranch().some(
				(entry: any) => entry.type === "custom_message" && entry.customType === "pi-taskforce-ask-answer",
			),
		).toBe(true);
		const branch = sm.getBranch();
		const visibleAt = branch.findIndex((entry: any) => entry.customType === "pi-taskforce-ask-visible");
		const assistantAt = branch.findIndex((entry: any) => entry.type === "message" && entry.message?.role === "assistant" && entry.id !== branch[1]?.id);
		expect(visibleAt).toBeGreaterThan(-1);
		expect(assistantAt).toBeGreaterThan(visibleAt);

		// A real /reload re-binds the extension against the same branch. The
		// canonical answer is observed, so it is neither offered nor written twice.
		await session.waitForIdle();
		await session.reload();
		const afterReload = sm.getBranch().filter((entry: any) => entry.customType === "pi-taskforce-ask-answer");
		expect(afterReload).toHaveLength(1);
		expect(
			sm.getBranch().filter(
				(entry: any) => entry.customType === "pi-taskforce-ask-done" && entry.data?.id === "ask-1",
			),
		).toHaveLength(1);
		session.dispose();
	}, 15_000);

	it("keeps a streaming send replayable until the canonical answer is on the branch", async () => {
		const cwd = "/tmp/taskforce-askprobe-stream";
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
		const sm = SessionManager.inMemory(cwd, { id: "probe-stream" } as never);
		sm.appendMessage({ role: "user", content: "Please ask me which target to build.", timestamp: Date.now() } as any);
		sm.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call_ask_stream", name: "ask", arguments: { questions: ask.questions } }],
			api: "probe-api",
			provider: "synthetic",
			model: "fake-1",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "toolUse",
			timestamp: Date.now(),
		} as any);
		sm.appendCustomEntry("pi-taskforce-ask-pending", {
			v: 2,
			id: "ask-stream",
			sessionId: "probe-stream",
			createdAt: Date.now(),
			ask,
			from: { agentId: "root", agentType: "root", depth: 0 },
			via: [],
			attribution: null,
			toolCallId: "call_ask_stream",
			assistantEntryId: null,
		});
		(globalThis as any).__taskforceAskProbe = {
			requests: [],
			opens: [],
			answered: 0,
			holdStream: true,
			autoAnswer: false,
		};
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
		const state = (globalThis as any).__taskforceAskProbe;
		expect(state.opens).toHaveLength(1);

		const turn = session.prompt("start a stream");
		await waitFor(() => state.requests.length > 0);
		const reply = state.opens[0].answer({ answers: [{ id: "q", values: ["android"] }] });
		expect(reply.pending.state).toBe("saved");
		expect(sm.getBranch().some((entry: any) => entry.customType === "pi-taskforce-ask-answer")).toBe(false);
		expect(sm.getBranch().some((entry: any) => entry.customType === "pi-taskforce-ask-done")).toBe(false);

		// A second, different answer while the first is queued must not replace
		// the immutable payload or add another submission.
		const second = state.opens[0].answer({ answers: [{ id: "q", values: ["ios"] }] });
		expect(second.pending.state).toBe("saved");
		expect(second.pending.message).toMatch(/already saved/i);
		expect(sm.getBranch().filter((entry: any) => entry.customType === "pi-taskforce-ask-submit")).toHaveLength(1);
		expect(sm.getBranch().filter((entry: any) => entry.customType === "pi-taskforce-ask-send-attempt")).toHaveLength(1);

		state.releaseStream!();
		await turn;
		await waitFor(() => sm.getBranch().some((entry: any) => entry.customType === "pi-taskforce-ask-answer"));
		await waitFor(() => sm.getBranch().some((entry: any) => entry.customType === "pi-taskforce-ask-done"));
		expect(state.requests[0].roles).toEqual(["system", "user", "assistant", "user"]);
		const canonical = sm.getBranch().find((entry: any) => entry.customType === "pi-taskforce-ask-answer") as any;
		expect(JSON.stringify(canonical.content)).toMatch(/Android/);
		expect(JSON.stringify(canonical.content)).not.toMatch(/iOS/);
		expect(sm.getBranch().filter((entry: any) => entry.customType === "pi-taskforce-ask-submit")).toHaveLength(1);
		session.dispose();
	}, 15_000);
});
