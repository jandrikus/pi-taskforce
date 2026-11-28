import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Check } from "typebox/value";
import type { TObject } from "typebox";
import { describe, expect, it, vi } from "vitest";

import { builtinGeneral, parseDefinition, renderGoal } from "../extensions/agents/definitions.js";
import { Orchestration, REPORT_MESSAGE } from "../extensions/agents/orchestration.js";
import { CHILD_ENTRY, type AgentRecord } from "../extensions/agents/records.js";
import { Supervisor } from "../extensions/agents/supervisor.js";
import type { AskBroker } from "../extensions/ask/broker.js";
import { Taskforce } from "../extensions/runtime.js";
import { registerSpawnTools } from "../extensions/tools/spawn.js";
import { registerSubagentTools } from "../extensions/tools/subagents.js";

interface RegisteredTool {
	name: string;
	description: string;
	promptSnippet?: string;
	parameters: TObject<Record<string, { default?: unknown }>>;
	execute(id: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<{
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	}>;
}

function setup(options: { maxDepth?: number; spawnable?: string[]; registerRoster?: boolean; withPromptText?: boolean } = {}) {
	const tools = new Map<string, RegisteredTool>();
	const sendMessage = vi.fn();
	const pi = {
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		sendMessage,
	} as unknown as ExtensionAPI;
	const entries: AgentRecord[] = [];
	const tf = new Taskforce("/tmp/taskforce-delegate-test", (record) => entries.push(record), { projectTrusted: false });
	tf.identity = null;
	tf.catalog = { byName: new Map([["general", builtinGeneral()]]), failures: [] };
	tf.bindSession("root-1", null);
	const supervisor = new Supervisor({
		cwd: tf.cwd, self: tf.self,
		features: { todos: true, subagents: true, ask: true },
		maxDepth: options.maxDepth ?? 3, maxRunning: 8, silenceTimeoutMs: 600_000, forkPath: true,
		sessionFile: null, extensionEntry: "/extension.ts",
		parentAppendSystemPrompt: null, spawnable: options.spawnable ?? null, inheritedPrompt: null,
	}, {
		registerChild: (record) => tf.children.add(record), recordSessionFile: vi.fn(), recordFailed: vi.fn(),
		onAsk: vi.fn(), onRunEnd: vi.fn(), onUpdate: vi.fn(), hasChildren: () => tf.children.all().length > 0,
	});
	tf.supervisor = supervisor;
	const spawn = vi.spyOn(supervisor, "spawn").mockImplementation(async (request, child) => {
		tf.children.add(child);
		return {
			task: renderGoal(request.definition, request.goal!),
			run: {
				isRunning: false, hasOpenQuestion: false,
				waitForEnd: async () => ({ failed: false, reason: null, result: "Done", usage: {} }),
			} as never,
		};
	});
	const broker = { expectForegroundQuestion: vi.fn() } as unknown as AskBroker;
	const onChange = vi.fn();
	const orchestration = new Orchestration(pi, tf, broker, onChange);
	registerSpawnTools(pi, tf, orchestration, {
		registerRoster: options.registerRoster ?? true,
		allowed: (name) => !options.spawnable || options.spawnable.includes(name),
	});
	registerSubagentTools(pi, tf, orchestration, { withPromptText: options.withPromptText ?? true });
	const call = async (name: string, args: Record<string, unknown>) => {
		const result = await tools.get(name)!.execute("call-1", args);
		return result.content.map((part) => part.text).join("\n");
	};
	return { tools, tf, spawn, broker, onChange, call, sendMessage, entries, orchestration, supervisor };
}

describe("§7 delegate", () => {
	it("registers one uniform typed tool, not one per preset", () => {
		const { tools } = setup();
		expect(tools.has("general")).toBe(false);
		const schema = tools.get("delegate")!.parameters;
		expect(Object.keys(schema.properties)).toEqual(["type", "advisor", "goal", "background", "fork", "thinking"]);
		expect(schema.required).toEqual(["goal"]);
		expect(schema.properties.type!.default).toBe("general");
		expect(Check(schema, { goal: "Do it" })).toBe(true);
		expect(Check(schema, { goal: "Do it", thinking: "max", background: true, fork: true })).toBe(true);
		for (const bad of [
			{}, { goal: "" }, { goal: "Do it", taskId: 1 },
			{ goal: "Do it", thinking: "enormous" }, { goal: "Do it", background: "yes" },
			{ goal: "Do it", context: "old custom parameter" },
		]) expect(Check(schema, bad)).toBe(false);
	});

	it.each(["worker", "worker-sol"])('grants only the named %s a round trip to the same advisor', async (type) => {
		const { tf, orchestration, supervisor, call, sendMessage, entries } = setup();
		for (const name of [type, "design-advisor"]) tf.catalog.byName.set(name, { ...builtinGeneral(), name, fork: false, extensions: [], subagents: [] });
		await call("delegate", { type: "design-advisor", goal: "Design the screen" });
		const advisor = entries[0]!.uuid;
		for (const args of [{ type: "general", advisor }, { type, advisor: "foreign" }, { type, advisor, fork: true }]) {
			expect(await call("delegate", { ...args, goal: "Build" })).toMatch(/requires/);
		}
		await call("delegate", { type, advisor, goal: "Build" });
		const worker = entries[1]!;
		expect(worker.advisor).toBe(advisor);
		expect(await orchestration.consult("foreign", "Read it")).toMatch(/No advisor grant/);
		const start = vi.spyOn(supervisor, "messageChild").mockImplementation(async () => {
			vi.spyOn(supervisor, "runFor").mockReturnValue({ waitForEnd: async () => ({ result: "Use tabs" }) } as never);
			return { delivered: true, restarted: true };
		});
		const reply = orchestration.consult(worker.uuid, "Which layout?");
		expect(await orchestration.consult(worker.uuid, "Another?")).toMatch(/busy/);
		expect(await orchestration.message(entries[0]!, "Change scope")).toMatch(/not sent/);
		expect(await reply).toBe("Use tabs");
		expect(start).toHaveBeenCalledOnce();
		expect(start.mock.calls[0]![0].uuid).toBe(advisor);
		expect(start.mock.calls[0]![2]).toContain("Which layout?");
		expect(sendMessage).not.toHaveBeenCalled();
	});

	it("defaults to general and records the child in the parent's session", async () => {
		const { spawn, call, entries } = setup();
		expect(await call("delegate", { goal: "Do it" })).toMatch(/Done/);
		expect(spawn).toHaveBeenCalledOnce();
		const [request, child] = spawn.mock.calls[0]!;
		expect(request.goal).toBe("Do it");
		expect(request.definition.name).toBe("general");
		expect(request.controls).toEqual({ background: false, fork: false, thinking: null });
		expect(child.uuid).toMatch(/^[\da-f-]{36}$/);
		expect(child.parentUuid).toBe("root-1");
		expect(child.depth).toBe(2);
		expect(entries.map((entry) => entry.uuid)).toEqual([child.uuid]);
	});

	it("names the model the child actually got, so nobody has to ask it", async () => {
		const { tf, spawn, call } = setup();
		spawn.mockImplementation(async (_request, child) => {
			tf.children.add(child);
			return {
				task: "Do it",
				run: {
					isRunning: false,
					hasOpenQuestion: false,
					model: { provider: "deepseek", id: "deepseek-flash" },
					thinking: "low",
					waitForEnd: async () => ({ failed: false, reason: null, result: "Done", usage: {} }),
				} as never,
			};
		});
		const reply = await call("delegate", { goal: "Do it" });
		expect(reply).toMatch(/Report from general `[\da-f-]{36}` on `deepseek\/deepseek-flash` at thinking level `low`\./);
	});

	it("uses preset model, tools, instructions and controls, with explicit overrides", async () => {
		const { tools, tf, spawn, call } = setup();
		const preset = parseDefinition([
			"name: scout", "label: Scout", "model: fast-model", "tools: [read, bash]",
			"identity: Inspect but do not edit", "appendSystemPrompt: Report relevant files",
			"taskTemplate: 'Investigate {goal}'", "background: true", "fork: true", "thinking: low",
		].join("\n"), "/scout.yml", "user");
		tf.catalog.byName.set("scout", preset);
		await call("delegate", { type: "scout", goal: "the parser" });
		expect(spawn.mock.calls[0]![0].definition).toBe(preset);
		expect(spawn.mock.calls[0]![0].controls).toEqual({ background: true, fork: true, thinking: "low" });
		await call("delegate", { type: "scout", goal: "the tests", background: false, fork: false, thinking: "high" });
		expect(spawn.mock.calls[1]![0].controls).toEqual({ background: false, fork: false, thinking: "high" });
		expect(tools.has("scout")).toBe(false);
	});

	it("rejects unknown, malformed and unmigrated types before spawning", async () => {
		const { tf, spawn, call } = setup();
		expect(await call("delegate", { type: "missing", goal: "Do it" })).toMatch(/Unknown or disabled.*missing/);
		expect(await call("delegate", { goal: "  " })).toMatch(/non-empty goal/);
		tf.catalog.byName.set("legacy", parseDefinition("name: legacy\nlabel: Legacy\ntaskTemplate: 'Check {target}'", "/legacy.yml", "user"));
		expect(await call("delegate", { type: "legacy", goal: "Do it" })).toMatch(/needs migration.*target/);
		tf.catalog.byName.delete("general");
		expect(await call("delegate", { goal: "Do it" })).toMatch(/Unknown or disabled.*general/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("keeps the depth and allowlist refusals", async () => {
		const deep = setup({ maxDepth: 1 });
		expect(await deep.call("delegate", { goal: "Do it" })).toMatch(/past the ceiling/);
		expect(deep.spawn).not.toHaveBeenCalled();
		const limited = setup({ spawnable: ["scout"] });
		expect(await limited.call("delegate", { goal: "Do it" })).toMatch(/may not spawn `general`/);
		expect(limited.spawn).not.toHaveBeenCalled();
	});

	it("does not register delegation for an isolated agent, but keeps the child tools", () => {
		const { tools } = setup({ registerRoster: false, withPromptText: false });
		expect(tools.has("delegate")).toBe(false);
		expect(tools.has("setSubagentTask")).toBe(false);
		expect(tools.get("closeSubagent")!.promptSnippet).toBeUndefined();
		expect(tools.has("closeSubagent")).toBe(true);
	});
});

describe("§10 reports", () => {
	it("delivers a background report as a follow-up that never cuts into a run", async () => {
		const { call, sendMessage } = setup();
		expect(await call("delegate", { goal: "Do it", background: true })).toMatch(/in the background/);
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		const [message, delivery] = sendMessage.mock.calls[0]!;
		expect(message.customType).toBe(REPORT_MESSAGE);
		expect(message.content).toMatch(/Done/);
		expect(delivery).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("tells the parent the report waits for its turn to end", async () => {
		const { call } = setup();
		const started = await call("delegate", { goal: "Do it", background: true });
		expect(started).toMatch(/your current turn has ended/);
		expect(started).toMatch(/do not poll or sleep/);
	});

	it("marks a report queued in listSubagents until it is delivered", async () => {
		const { call, sendMessage, orchestration } = setup();
		await call("delegate", { goal: "Do it", background: true });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		const uuid = sendMessage.mock.calls[0]![0].details.agentId as string;

		expect(await call("listSubagents", {})).toMatch(/report queued until your turn ends/);
		orchestration.reportDelivered(uuid);
		expect(await call("listSubagents", {})).not.toMatch(/report queued/);
	});

	it("forgets queued marks when the parent settles", async () => {
		const { call, sendMessage, orchestration } = setup();
		await call("delegate", { goal: "Do it", background: true });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		const uuid = sendMessage.mock.calls[0]![0].details.agentId as string;
		expect(orchestration.hasQueuedReport(uuid)).toBe(true);
		orchestration.forgetQueuedReports();
		expect(orchestration.hasQueuedReport(uuid)).toBe(false);
	});

	it("does not restart a child whose report is still queued", async () => {
		const { call, sendMessage, orchestration, supervisor } = setup();
		const messageChild = vi.spyOn(supervisor, "messageChild");
		vi.spyOn(supervisor, "transcriptProblem").mockReturnValue(null);
		await call("delegate", { goal: "Do it", background: true });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce());
		const uuid = sendMessage.mock.calls[0]![0].details.agentId as string;

		const reply = await call("messageSubagent", { subagent: uuid, message: "Report now" });
		expect(reply).toMatch(/report is queued/);
		expect(reply).toMatch(/not sent/);
		expect(messageChild).not.toHaveBeenCalled();
		expect(sendMessage).toHaveBeenCalledOnce();

		orchestration.reportDelivered(uuid);
		messageChild.mockResolvedValue({ delivered: true, restarted: false } as never);
		expect(await call("messageSubagent", { subagent: uuid, message: "Follow-up" })).not.toMatch(/report is queued/);
		expect(messageChild).toHaveBeenCalledOnce();
	});
});

describe("§9 child records", () => {
	it("reads children back from the session, the later entry winning", () => {
		const { tf } = setup();
		const record: AgentRecord = {
			uuid: "c1", parentUuid: "root-1", type: "general", failed: false,
			sessionFile: null, spawnedAt: 1, depth: 2, forked: false,
		};
		tf.children.load([
			{ type: "custom", customType: CHILD_ENTRY, data: record },
			{ type: "custom", customType: "other", data: { ...record, uuid: "nope" } },
			{ type: "custom", customType: CHILD_ENTRY, data: { ...record, failed: true, sessionFile: "/s.jsonl" } },
		]);
		expect(tf.children.all()).toHaveLength(1);
		expect(tf.children.get("c1")).toMatchObject({ failed: true, sessionFile: "/s.jsonl" });
	});

	it("appends an entry only when a record really changes", () => {
		const { tf, entries } = setup();
		tf.children.add({
			uuid: "c1", parentUuid: "root-1", type: "general", failed: false,
			sessionFile: null, spawnedAt: 1, depth: 2, forked: false,
		});
		tf.children.update("c1", { failed: false });
		tf.children.update("c1", { failed: true });
		expect(entries).toHaveLength(2);
	});

	it("addresses only the agent's own children", async () => {
		const { call } = setup();
		expect(await call("closeSubagent", { subagent: "stranger" })).toMatch(/not one of your subagents/);
	});
});
