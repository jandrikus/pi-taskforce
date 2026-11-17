/**
 * §12. Deterministic regressions against a real AgentSession, no model and no
 * network. These are the races a fake context cannot show: a follow-up that
 * outlives the branch it was queued on, an async input hook that leaves the
 * session looking idle, and an extension reload that keeps the old queue.
 */
import { describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AskBroker } from "../extensions/ask/broker.js";
import { ANSWER_ENTRY, DONE_ENTRY, PENDING_ENTRY, SUBMIT_ENTRY, WAKE_ATTEMPT_ENTRY, WAKE_ENTRY } from "../extensions/ask/journal.js";
import { validateAsk } from "../extensions/ask/schema.js";

const model = {
	id: "synthetic",
	name: "Synthetic",
	provider: "synthetic",
	api: "synthetic",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10000,
	maxTokens: 100,
} as any;

const assistant = () => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text: "synthetic" }],
	api: "synthetic",
	provider: "synthetic",
	model: "synthetic",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "stop" as const,
	timestamp: Date.now(),
});

async function makeSession() {
	const cwd = "/tmp";
	const agentDir = "/tmp/taskforce-nonexistent-review";
	const settings = SettingsManager.inMemory();
	const sm = SessionManager.inMemory(cwd, { id: "S1" } as never);
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager: settings,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	} as any);
	await loader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager: settings,
		resourceLoader: loader,
		sessionManager: sm,
		noTools: true,
		model,
	} as any);
	(session as any)._modelRuntime.hasConfiguredAuth = () => true;
	(session as any).agent.streamFunction = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: assistant() }));
		return stream;
	};
	return { session, sm };
}

function ask() {
	const checked = validateAsk(null, [{ id: "q", prompt: "Question" }]);
	if (!checked.ok) throw new Error(checked.message);
	return checked.ask;
}

function setup(session: any, sm: any, options: { dropSend?: boolean } = {}) {
	const events: Array<{ channel: string; data: any }> = [];
	sm.appendMessage({
		...assistant(),
		content: [{ type: "toolCall", id: "call-1", name: "ask", arguments: {} }],
	} as never);
	sm.appendCustomEntry(PENDING_ENTRY, {
		v: 2,
		id: "ask-1",
		sessionId: "S1",
		createdAt: 1,
		ask: ask(),
		from: { agentId: "root", agentType: "root", depth: 0 },
		via: [],
		attribution: null,
		toolCallId: "call-1",
		assistantEntryId: sm.getBranch().at(-1)?.id ?? null,
	});
	const pi = {
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
		sendUserMessage: (text: string, sendOptions?: any) => {
			if (options.dropSend) return;
			session.sendUserMessage(text, sendOptions).catch(() => {});
		},
		sendMessage: (message: any, sendOptions?: any) => {
			if (options.dropSend && message.customType === WAKE_ENTRY) throw new Error("no turn");
			sm.appendCustomMessageEntry(message.customType, message.content, message.display ?? true, message.details);
		},
		events: { emit: (channel: string, data: unknown) => events.push({ channel, data }) },
	};
	const broker = new AskBroker(pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
	const ctx = {
		hasUI: false,
		mode: "tui",
		isIdle: () => session.isIdle,
		hasPendingMessages: () => session.pendingMessageCount > 0,
		model,
		modelRegistry: { hasConfiguredAuth: () => true },
		sessionManager: sm,
	};
	broker.restore(ctx as never);
	const remote = events.find((event) => event.channel === "ask:open")!.data;
	return { broker, remote, events, ctx, pi };
}

const userTexts = (sm: any) =>
	sm
		.getBranch()
		.filter((entry: any) => entry.type === "message" && entry.message?.role === "user")
		.map((entry: any) => JSON.stringify(entry.message.content));

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("the hazard, on a real AgentSession", () => {
	it("a follow-up queued on one branch lands on another after tree navigation", async () => {
		const { session, sm } = await makeSession();
		const branchB = sm.appendMessage(assistant() as never);
		sm.appendCustomEntry("branch-A", {});
		await (session as any).followUp("ANSWER-FROM-A");
		await (session as any).navigateTree(branchB);
		await session.prompt("branch B prompt");
		expect(userTexts(sm).some((text: string) => text.includes("ANSWER-FROM-A"))).toBe(true);
	});

	it("looks idle with an empty queue while another prompt is inside an async input hook", async () => {
		const { session } = await makeSession();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		(session as any)._runInputHandlers = async (text: string) => {
			if (++calls === 1) await gate;
			return { text };
		};
		const pending = session.prompt("gated");
		await tick();
		expect(session.isIdle).toBe(true);
		expect(session.pendingMessageCount).toBe(0);
		release();
		await pending;
	});


});

describe("the broker against a real session", () => {
	it("writes one canonical answer for the original call, and no user message", async () => {
		const { session, sm } = await makeSession();
		const { broker, remote } = setup(session, sm);
		expect(remote.status).toBeNull();
		const reply = remote.answer({ answers: [{ id: "q", values: ["ONE"] }] });
		expect(reply.pending.state).toBe("dispatched");
		expect(reply.pending.retry).toBe(false);

		const again = remote.answer({ answers: [{ id: "q", values: ["ONE"] }] });
		expect(again.pending.state).toBe("dispatched");
		const canonical = sm.getBranch().filter((entry: any) => entry.type === "custom_message" && entry.customType === ANSWER_ENTRY);
		expect(canonical).toHaveLength(1);
		expect((canonical[0] as any).details).toMatchObject({ askId: "ask-1", toolCallId: "call-1" });
		expect(userTexts(sm)).toHaveLength(0);
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.id === "ask-1")).toBe(true);
		expect(sm.getBranch().filter((entry: any) => entry.customType === WAKE_ATTEMPT_ENTRY)).toHaveLength(1);
	});

	it("cannot turn a canonical answer into a cancel", async () => {
		const { session, sm } = await makeSession();
		const { remote } = setup(session, sm);
		remote.answer({ answers: [{ id: "q", values: ["SECRET-ANSWER"] }] });
		const cancelled = remote.answer({ outcome: "cancelled" });
		expect(cancelled.pending.state).toBe("dispatched");
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.how === "cancelled")).toBe(false);
		expect(JSON.stringify(sm.getBranch())).toMatch(/SECRET-ANSWER/);
	});

	it("restores the canonical answer after a reload and never resends it", async () => {
		const { session, sm } = await makeSession();
		const first = setup(session, sm);
		first.remote.answer({ answers: [{ id: "q", values: ["YES"] }] });
		expect(sm.getBranch().filter((entry: any) => entry.customType === ANSWER_ENTRY)).toHaveLength(1);

		// A reloaded broker sees the canonical answer and has nothing to offer.
		const reloaded = new AskBroker(first.pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
		reloaded.restore(first.ctx as never);
		expect(reloaded.recoveredCount).toBe(0);
		await session.prompt("drain");
		expect(sm.getBranch().filter((entry: any) => entry.customType === ANSWER_ENTRY)).toHaveLength(1);
		expect(userTexts(sm)).toHaveLength(1);
	});

	it("materialises a journalled answer after a restart, before reporting it anywhere", async () => {
		const { session, sm } = await makeSession();
		const first = setup(session, sm);
		// The process stopped between the journal write and the canonical message.
		sm.appendCustomEntry(SUBMIT_ENTRY, {
			v: 1,
			id: "ask-1",
			at: 5,
			by: "remote",
			sessionId: "S1",
			result: {
				outcome: "answered",
				answers: [{ id: "q", values: ["SECOND"], labels: ["SECOND"], typed: "SECOND", note: null, omitted: false }],
			},
		});
		const next = new AskBroker(first.pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
		next.restore(first.ctx as never);
		expect(next.recoveredCount).toBe(0);
		const canonical = sm.getBranch().filter((entry: any) => entry.customType === ANSWER_ENTRY);
		expect(canonical).toHaveLength(1);
		expect((canonical[0] as any).details).toMatchObject({ askId: "ask-1", toolCallId: "call-1" });
		expect(JSON.stringify((canonical[0] as any).content)).toMatch(/SECOND/);
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.id === "ask-1")).toBe(true);
	});

});
