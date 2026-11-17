/**
 * §12. Deterministic regressions against a real AgentSession, no model and no
 * network. These are the races a fake context cannot show: a follow-up that
 * outlives the branch it was queued on, an async input hook that leaves the
 * session looking idle, and an extension reload that keeps the old queue.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { AskBroker, DELIVERY_UNCONFIRMED } from "../extensions/ask/broker.js";
import { DISPATCH_ENTRY, DONE_ENTRY, PENDING_ENTRY, SUBMIT_ENTRY } from "../extensions/ask/journal.js";
import { validateAsk } from "../extensions/ask/schema.js";
import { forgetProcessToken, processToken } from "../extensions/ask/process.js";

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
	sm.appendCustomEntry(PENDING_ENTRY, {
		v: 1,
		id: "ask-1",
		sessionId: "S1",
		createdAt: 1,
		ask: ask(),
		from: { agentId: "root", agentType: "root", depth: 0 },
		via: [],
		attribution: null,
	});
	const pi = {
		appendEntry: (type: string, data: unknown) => sm.appendCustomEntry(type, data),
		sendUserMessage: (text: string, sendOptions?: any) => {
			if (options.dropSend) return;
			session.sendUserMessage(text, sendOptions).catch(() => {});
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

afterEach(() => forgetProcessToken());

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

	it("keeps the process token across a reload, so a late hook still belongs to this process", async () => {
		const { session } = await makeSession();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		(session as any)._runInputHandlers = async (text: string) => {
			await gate;
			return { text };
		};
		const before = processToken();
		const running = session.prompt("gated");
		await tick();
		await (session as any).reload();
		expect(processToken()).toBe(before);
		release();
		await running;
		expect(userTexts((session as any).sessionManager).some((text: string) => text.includes("gated"))).toBe(true);
	});
});

describe("the broker against a real session", () => {
	it("dispatches once and refuses a second send while the first may still land", async () => {
		const { session, sm } = await makeSession();
		const { broker, remote, events } = setup(session, sm);
		expect(remote.status).toBeNull();
		const reply = remote.answer({ answers: [{ id: "q", values: ["ONE"] }] });
		expect(reply.pending.state).toBe("dispatched");
		expect(reply.pending.retry).toBe(false);
		expect(broker.hasUnresolvedDispatch()).toBe(true);

		const again = remote.answer({ answers: [{ id: "q", values: ["ONE"] }] });
		expect(again.pending.state).toBe("dispatched");
		await tick();
		await session.prompt("let the queue drain");
		await tick();
		const accepted = userTexts(sm).filter((text: string) => text.includes("pi-taskforce-recovery:ask-1"));
		expect(accepted).toHaveLength(1);
		broker.pokeAcceptance();
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.id === "ask-1")).toBe(true);
		expect(broker.hasUnresolvedDispatch()).toBe(false);
		expect(events.filter((event) => event.channel === "ask:close")).toHaveLength(1);
	});

	it("cannot cancel an answer that was already dispatched", async () => {
		const { session, sm } = await makeSession();
		const { broker, remote } = setup(session, sm);
		remote.answer({ answers: [{ id: "q", values: ["SECRET-ANSWER"] }] });
		const cancelled = remote.answer({ outcome: "cancelled" });
		expect(cancelled.pending.state).toBe("dispatched");
		expect(broker.recoveredCount).toBe(1);
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY)).toBe(false);
		await tick();
		await session.prompt("later prompt");
		broker.pokeAcceptance();
		expect(userTexts(sm).some((text: string) => text.includes("SECRET-ANSWER"))).toBe(true);
	});

	it("writes the dispatch before the send, so a reload stays guarded and observes acceptance", async () => {
		const { session, sm } = await makeSession();
		const first = setup(session, sm);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let calls = 0;
		(session as any)._runInputHandlers = async (text: string) => {
			if (++calls === 1) await gate;
			return { text };
		};
		first.remote.answer({ answers: [{ id: "q", values: ["YES"] }] });
		await tick();
		const dispatched = sm.getBranch().filter((entry: any) => entry.customType === DISPATCH_ENTRY) as any[];
		expect(dispatched).toHaveLength(1);
		expect(dispatched[0]!.data.token).toBe(processToken());

		// A reloaded broker (new instance, same process token) must not resend.
		const reloaded = new AskBroker(first.pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
		reloaded.restore(first.ctx as never);
		const status = reloaded.recoveredCount === 1 && reloaded.hasUnresolvedDispatch();
		expect(status).toBe(true);
		release();
		await tick();
		await session.prompt("drain");
		reloaded.pokeAcceptance();
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.how === "recovered")).toBe(true);
		expect(reloaded.recoveredCount).toBe(0);
	});

	it("allows a retry only after a new process token, and the marker still wins", async () => {
		const { session, sm } = await makeSession();
		// The first process dispatched but the message never arrived (a lost turn).
		const first = setup(session, sm, { dropSend: true });
		first.remote.answer({ answers: [{ id: "q", values: ["FIRST"] }] });
		await tick();
		expect(userTexts(sm).some((text: string) => text.includes("FIRST"))).toBe(false);

		// A restart: new process, new token, the old queue cannot reach this one.
		forgetProcessToken();
		const next = new AskBroker(first.pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
		next.restore(first.ctx as never);
		expect(next.recoveredCount).toBe(1);
		expect(next.hasUnresolvedDispatch()).toBe(false);
		const reopened = first.events.filter((event) => event.channel === "ask:open").at(-1)!.data;
		expect(reopened.status.state).toBe("dispatched");
		expect(reopened.status.retry).toBe(true);
		// This second send is real: the session accepts it.
		(first.pi as any).sendUserMessage = (text: string, sendOptions?: any) => {
			session.sendUserMessage(text, sendOptions).catch(() => {});
		};
		const reply = reopened.answer({ answers: [{ id: "q", values: ["SECOND"] }] });
		expect(reply.pending.retry).toBe(false);
		expect(reply.pending.message).toBe(DELIVERY_UNCONFIRMED);
		await tick();
		await session.prompt("drain");
		next.pokeAcceptance();
		expect(sm.getBranch().some((entry: any) => entry.customType === DONE_ENTRY && entry.data.how === "recovered")).toBe(true);
		// The old dispatch cannot repeat: the marker on the branch wins first.
		const after = new AskBroker(first.pi as never, { isRoot: true } as never, { onChange() {}, wake() {} });
		after.restore(first.ctx as never);
		expect(after.recoveredCount).toBe(0);
	});
});
