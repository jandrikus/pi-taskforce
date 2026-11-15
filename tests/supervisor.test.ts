import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseDefinition } from "../extensions/agents/definitions.js";

import { Supervisor, resolveExtensionReference, type SupervisorContext } from "../extensions/agents/supervisor.js";
import type { AgentRecord } from "../extensions/agents/records.js";

function context(overrides: Partial<SupervisorContext> = {}): SupervisorContext {
	const self: AgentRecord = {
		uuid: "a",
		parentUuid: null,
		type: null,
		failed: false,
		sessionFile: null,
		spawnedAt: 0,
		depth: 1,
		forked: false,
	};
	return {
		cwd: "/tmp",
		self,
		features: { todos: true, subagents: true, ask: true },
		maxDepth: 3,
		maxRunning: 8,
		silenceTimeoutMs: 600_000,
		forkPath: true,
		sessionFile: null,
		extensionEntry: "/x/index.ts",
		parentAppendSystemPrompt: null,
		spawnable: null,
		inheritedPrompt: null,
		...overrides,
	};
}

const hooks = {
	registerChild: () => {},
	recordSessionFile: () => {},
	recordFailed: () => {},
	onAsk: () => {},
	onRunEnd: () => {},
	onUpdate: () => {},
	hasChildren: () => false,
};

function supervisorAt(depth: number, spawnable: string[] | null = null, maxDepth = 3): Supervisor {
	const base = context({ maxDepth, spawnable });
	return new Supervisor({ ...base, self: { ...base.self, depth, type: "worker" } }, hooks);
}

describe("§3, §7 the depth limit", () => {
	it("lets the root spawn two levels below it, and no more", () => {
		// The default depth is three, and the root counts as one of the three.
		expect(supervisorAt(1).checkSpawnable("scout")).toBeNull();
		expect(supervisorAt(2).checkSpawnable("scout")).toBeNull();
		expect(supervisorAt(3).checkSpawnable("scout")).toMatch(/past the ceiling/);
	});

	it("repeats the agent's depth and the maximum in the refusal", () => {
		const message = supervisorAt(3).checkSpawnable("scout") ?? "";
		expect(message).toMatch(/depth 3/);
		expect(message).toMatch(/maximum of 3/);
		expect(message).toMatch(/depth 4/);
	});
});

describe("goal-based delegation through a child process", () => {
	it("sends the rendered goal and unified tools to an isolated child", async () => {
		const definition = parseDefinition([
			"name: scout",
			"label: Scout",
			"tools: [read]",
			"subagents: [reviewer]",
			"taskTemplate: 'Investigate: {goal}'",
		].join("\n"), "/tmp/scout.yaml", "project");
		const ctx = context({
			parentModel: () => ({ model: { provider: "claude-code", id: "claude-opus-5-5" }, thinking: "low" }),
			models: () => ({ getAll: () => [], hasConfiguredAuth: () => true }),
		});
		const registered: AgentRecord[] = [];
		const supervisor = new Supervisor(ctx, {
			...hooks,
			registerChild: (child) => { registered.push(child); },
		});
		const originalEntry = process.argv[1];
		const originalScript = process.env.FAKE_PI_SCRIPT;
		process.argv[1] = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
		process.env.FAKE_PI_SCRIPT = "inspect";
		try {
			const child: AgentRecord = {
				...ctx.self, uuid: "child", parentUuid: ctx.self.uuid,
				type: definition.name, depth: 2,
			};
			const { run } = await supervisor.spawn({
				definition, args: {}, goal: "Find authentication. Don't change files.",
				controls: { fork: false, background: false, thinking: null },
			}, child);
			const outcome = await run.waitForEnd();
			expect(outcome.failed).toBe(false);
			const inspected = JSON.parse(outcome.result!) as { task: string; args: string[] };
			// §6. The launch is a fact in the child's context, so it never has to probe for it.
			expect(inspected.task).toBe(
				"You are running on `claude-code/claude-opus-5-5` at thinking level `low`.\n\n" +
					"Investigate: Find authentication. Don't change files.",
			);
			const tools = inspected.args[inspected.args.indexOf("--tools") + 1]!.split(",");
			expect(tools).toContain("delegate");
			expect(tools).toContain("ask");
			expect(tools).not.toContain("writeTasks");
			expect(tools).toContain("read");
			expect(tools).not.toContain("reviewer");
			expect(registered).toEqual([child]);
			// §6. No pinned model: the parent's, named exactly with its provider.
			const args = inspected.args;
			expect(args[args.indexOf("--provider") + 1]).toBe("claude-code");
			expect(args[args.indexOf("--model") + 1]).toBe("claude-opus-5-5");
			expect(args[args.indexOf("--thinking") + 1]).toBe("low");
			expect(run.model).toEqual({ provider: "claude-code", id: "claude-opus-5-5" });
			expect(run.thinking).toBe("low");
		} finally {
			if (originalEntry === undefined) delete process.argv[1];
			else process.argv[1] = originalEntry;
			if (originalScript === undefined) delete process.env.FAKE_PI_SCRIPT;
			else process.env.FAKE_PI_SCRIPT = originalScript;
			await supervisor.stopAll("test cleanup");
			supervisor.cleanUp();
		}
	});
});

describe("§6 which agents an agent may spawn", () => {
	it("lets an agent with no declared list spawn anything", () => {
		expect(supervisorAt(1, null).checkSpawnable("anything")).toBeNull();
	});

	it("refuses a type outside the list, naming the agent, the list and the type tried", () => {
		const message = supervisorAt(2, ["scout"]).checkSpawnable("writer") ?? "";
		expect(message).toMatch(/`worker` may not spawn `writer`/);
		expect(message).toMatch(/may spawn are: scout/);
	});

	it("refuses everything for `subagents: none`", () => {
		const message = supervisorAt(2, []).checkSpawnable("scout") ?? "";
		expect(message).toMatch(/may spawn are: none/);
	});
});

describe("shared baseline on every launch path", () => {
	for (const fork of [false, true]) {
		for (const resume of [false, true]) {
			it(`keeps infrastructure, role access and skills with fork=${fork}, resume=${resume}`, () => {
				const extension = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
				const definition = parseDefinition(`name: scout\nlabel: Scout\ntools: [read]\nextensions: [${extension}]`, "/tmp/scout.yml", "user");
				const ctx = context({ sharedExtensions: [extension, extension], sharedTools: ["search", "fetch", "recall"], skillPaths: ["/skills/test/SKILL.md"] });
				const supervisor = new Supervisor(ctx, hooks);
				const build = supervisor as unknown as { buildLaunchSpec: (...args: unknown[]) => { args: string[]; env: Record<string, string> } };
				try {
					const spec = build.buildLaunchSpec(definition, { controls: { fork, background: false, thinking: null } }, { ...ctx.self, uuid: "child", depth: 2 }, "task", resume ? "/tmp/child.jsonl" : undefined);
					expect(spec.args.filter((arg) => arg === extension)).toHaveLength(1);
					expect(spec.args).toContain("--no-skills");
					expect(spec.args).toContain("/skills/test/SKILL.md");
					if (resume) expect(spec.args).toContain("--session");
					const allowed = fork ? JSON.parse(spec.env.PI_TASKFORCE_TOOLS!) : spec.args[spec.args.indexOf("--tools") + 1]!.split(",");
					for (const tool of ["read", "search", "fetch", "recall"]) expect(allowed).toContain(tool);
					expect(allowed).not.toContain("write");
				} finally { supervisor.cleanUp(); }
			});
		}
	}
});

describe("§6 the launch facts", () => {
	it("names the model in the spec and in the child's first prompt, and not for a fork", () => {
		const ctx = context({
			parentModel: () => ({ model: { provider: "deepseek", id: "deepseek-flash" }, thinking: "low" }),
			models: () => ({
				getAll: () => [{ provider: "openai", id: "gpt-6.1-terra" }],
				hasConfiguredAuth: () => true,
			}),
		});
		const supervisor = new Supervisor(ctx, hooks);
		const definition = parseDefinition(
			"name: worker\nlabel: W\nmodel: openai/gpt-6.1-terra\nthinking: xhigh",
			"/tmp/worker.yml",
			"user",
		);
		const build = supervisor as unknown as {
			buildLaunchSpec: (...args: unknown[]) => { model: unknown; thinking: string | null };
			buildTask: (...args: unknown[]) => string;
		};
		const controls = { fork: false, background: false, thinking: null };
		const launch = { model: { provider: "openai", id: "gpt-6.1-terra" }, thinking: "xhigh" };
		try {
			const spec = build.buildLaunchSpec(
				definition,
				{ controls },
				{ ...ctx.self, uuid: "child", depth: 2 },
				"task",
				undefined,
			);
			expect(spec.model).toEqual(launch.model);
			expect(spec.thinking).toBe("xhigh");

			const task = build.buildTask(definition, { definition, args: {}, goal: "Do it", controls }, launch);
			expect(task).toMatch(/^You are running on `openai\/gpt-6\.1-terra` at thinking level `xhigh`\./);

			const forked = build.buildTask(
				definition,
				{ definition, args: {}, goal: "Do it", controls: { ...controls, fork: true } },
				null,
			);
			expect(forked).not.toMatch(/You are running on/);
			expect(forked).toMatch(/Your task:\nDo it/);
		} finally {
			supervisor.cleanUp();
		}
	});
});

describe("§6 extension references", () => {
	it("resolves a leading ~ against the user's home, not the child's cwd", () => {
		const here = fileURLToPath(import.meta.url);
		const home = process.env.HOME ?? "";
		if (!here.startsWith(`${home}/`)) return;
		expect(resolveExtensionReference(`~${here.slice(home.length)}`, "/tmp", false)).toBe(here);
	});

	it("reports a reference that names no file", () => {
		expect(resolveExtensionReference("~/nowhere/at/all.ts", "/tmp", false)).toBeNull();
	});
});
