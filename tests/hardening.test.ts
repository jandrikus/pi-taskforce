import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { ChildRun, type PendingAsk } from "../extensions/agents/child.js";
import { buildChildEnv, ENV, readChildIdentity, withoutTaskforceEnv } from "../extensions/agents/env.js";
import { ChildRecords } from "../extensions/agents/records.js";
import { attachJsonlReader } from "../extensions/agents/rpc.js";
import {
	intersectAllowlists,
	ownExtensionFlags,
	ownToolLimits,
	Supervisor,
	type SupervisorContext,
} from "../extensions/agents/supervisor.js";
import { AskBroker, attributionOf } from "../extensions/ask/broker.js";
import { CANCELLED_RESULT } from "../extensions/ask/protocol.js";
import type { AskResult } from "../extensions/ask/schema.js";
import { decideProjectTrust } from "../extensions/config/trust.js";
import { parseDefinition } from "../extensions/agents/definitions.js";
import type { AgentRecord } from "../extensions/agents/records.js";
import type { Taskforce } from "../extensions/runtime.js";

const none = { savedDecision: () => null, defaultProjectTrust: () => undefined };
const pi = ["node", "pi"];

describe("§3, §6 the trust override reads the command line as pi does", () => {
	it("does not take a message after `--` for a flag", () => {
		expect(decideProjectTrust({ argv: [...pi, "--no-approve", "--", "--approve"], ...none })).toBe(false);
		expect(decideProjectTrust({ argv: [...pi, "--", "-a"], ...none })).toBe(false);
	});

	it("does not take a flag's value for a flag", () => {
		expect(decideProjectTrust({ argv: [...pi, "--model", "--approve"], ...none })).toBe(false);
		expect(decideProjectTrust({ argv: [...pi, "-e", "-a"], ...none })).toBe(false);
	});

	it("still honours the real flags, the last one winning", () => {
		expect(decideProjectTrust({ argv: [...pi, "-na", "--approve", "hello"], ...none })).toBe(true);
		expect(decideProjectTrust({ argv: [...pi, "-a", "--no-approve"], ...none })).toBe(false);
	});
});

describe("§8 a child's environment", () => {
	it("carries nothing of its parent's taskforce state", () => {
		const parent = {
			PATH: "/bin",
			ANTHROPIC_API_KEY: "kept",
			[ENV.forkPath]: "1",
			[ENV.forked]: "1",
			[ENV.spawnable]: "[\"scout\"]",
			[ENV.tools]: "[\"read\"]",
			PI_TASKFORCE_PROMPT: "{\"appended\":\"parent prompt\"}",
			PI_TASKFORCE_IDENTITY: "parent identity",
		};
		const clean = withoutTaskforceEnv(parent);
		expect(clean).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "kept" });
	});

	it("reads a non-forked grandchild of a fork as isolated", () => {
		const env = {
			...withoutTaskforceEnv({ [ENV.forkPath]: "1", PI_TASKFORCE_PROMPT: "{}" }),
			...buildChildEnv({
				agentId: "g", parentId: "c", agentType: "general", depth: 3, maxDepth: 3, maxRunning: 8,
				silenceTimeoutMs: 600_000, features: { todos: true, subagents: true, ask: true },
				forked: false, forkPath: false, spawnable: null, projectTrusted: false, tools: null,
			}),
		};
		const identity = readChildIdentity(env)!;
		expect(identity.forkPath).toBe(false);
		expect(identity.tools).toBeNull();
		expect(env.PI_TASKFORCE_PROMPT).toBeUndefined();
	});
});

describe("§8 tool limits pass down", () => {
	it("reads the parent's own flags as pi reads them", () => {
		const limits = ownToolLimits([...pi, "--tools", "read,grep", "-xt", "bash", "--", "--no-tools"], {});
		expect(limits.allow).toEqual(["read", "grep"]);
		expect(limits.restrictions).toEqual(["--exclude-tools", "bash"]);
		expect(limits.flags).toEqual(["--tools", "read,grep", "--exclude-tools", "bash"]);
		expect(ownToolLimits([...pi, "--no-tools"], {}).allow).toEqual([]);
		expect(ownToolLimits([...pi], {}).allow).toBeNull();
		expect(ownToolLimits([...pi, "-nbt"], {}).noBuiltinTools).toBe(true);
		expect(ownToolLimits([...pi, "-nbt", "-t", "read"], {}).noBuiltinTools).toBe(false);
	});

	it("is read once, so a later change to the environment cannot loosen it", () => {
		const env: NodeJS.ProcessEnv = { [ENV.tools]: "[\"read\"]" };
		const limits = ownToolLimits([...pi], env);
		delete env[ENV.tools];
		expect(limits.enforced).toEqual(["read"]);
		expect(Object.isFrozen(limits)).toBe(true);
		expect(Object.isFrozen(limits.enforced)).toBe(true);
	});

	it("never widens an allowlist", () => {
		expect(intersectAllowlists(null, null)).toBeNull();
		expect(intersectAllowlists(["read"], null)).toEqual(["read"]);
		expect(intersectAllowlists(null, ["read", "ask"])).toEqual(["read", "ask"]);
		expect(intersectAllowlists(["read", "ask"], ["read", "bash", "ask"])).toEqual(["read", "ask"]);
	});

	it("does not take a message after `--` for an extension flag", () => {
		expect(ownExtensionFlags([...pi, "-e", "/a.ts", "--", "-e", "/evil.ts"])).toEqual(["-e", "/a.ts"]);
	});
});

function supervisorContext(overrides: Partial<SupervisorContext> = {}): SupervisorContext {
	return {
		cwd: "/tmp",
		self: { uuid: "root", parentUuid: null, type: null, failed: false, sessionFile: null, spawnedAt: 0, depth: 1, forked: false },
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
	registerChild: () => {}, recordSessionFile: () => {}, recordFailed: () => {},
	onAsk: () => {}, onRunEnd: () => {}, onUpdate: () => {}, hasChildren: () => false,
};

describe("§7 how many children run at once", () => {
	it("refuses a start once the limit is running", () => {
		const supervisor = new Supervisor(supervisorContext({ maxRunning: 2 }), hooks);
		let live: unknown[] = [{ agentId: "a" }, { agentId: "b" }];
		Object.defineProperty(supervisor, "liveRuns", { get: () => live });
		expect(supervisor.checkSpawnable("general")).toMatch(/already have 2 subagents running/);
		live = [];
		expect(supervisor.checkSpawnable("general")).toBeNull();
	});
});

describe("§9 a recorded transcript path", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is reopened only from this session's own subagents folder", () => {
		dir = mkdtempSync(join(tmpdir(), "taskforce-resume-"));
		const own = join(dir, "sessions", "p", "parent.jsonl");
		const mine = join(dir, "sessions", "p", "subagents", "parent");
		const theirs = join(dir, "sessions", "p", "subagents", "sibling");
		mkdirSync(mine, { recursive: true });
		mkdirSync(theirs, { recursive: true });
		writeFileSync(own, "");
		const inside = join(mine, "child.jsonl");
		const sibling = join(theirs, "child.jsonl");
		const flat = join(dir, "sessions", "p", "subagents", "old.jsonl");
		const elsewhere = join(dir, "sessions", "other.jsonl");
		const link = join(mine, "link.jsonl");
		for (const file of [inside, sibling, flat, elsewhere]) writeFileSync(file, "{}\n");
		symlinkSync(elsewhere, link);

		const supervisor = new Supervisor(supervisorContext({ sessionFile: own }), hooks);
		expect(supervisor.transcriptProblem(inside)).toBeNull();
		expect(supervisor.transcriptProblem(sibling)).toMatch(/outside/);
		expect(supervisor.transcriptProblem(flat)).toMatch(/outside/);
		expect(supervisor.transcriptProblem(elsewhere)).toMatch(/outside/);
		expect(supervisor.transcriptProblem(link)).toMatch(/outside/);
		expect(supervisor.transcriptProblem(join(mine, "..", "..", "..", "other.jsonl"))).toMatch(/outside/);
		expect(supervisor.transcriptProblem(join(dir, "gone.jsonl"))).toMatch(/no longer on disk/);
		expect(new Supervisor(supervisorContext(), hooks).transcriptProblem(inside)).toMatch(/not saved/);
	});

	it("refuses a spawn when the session's subagent folder cannot be made safely", () => {
		dir = mkdtempSync(join(tmpdir(), "taskforce-resume-"));
		const own = join(dir, "sessions", "p", "parent.jsonl");
		mkdirSync(join(dir, "sessions", "p", "subagents"), { recursive: true });
		writeFileSync(own, "");
		const ok = new Supervisor(supervisorContext({ sessionFile: own }), hooks);
		expect(ok.checkSpawnable("scout")).toBeNull();
		mkdirSync(join(dir, "elsewhere"));
		const other = join(dir, "sessions", "p", "other.jsonl");
		writeFileSync(other, "");
		symlinkSync(join(dir, "elsewhere"), join(dir, "sessions", "p", "subagents", "other"));
		const bad = new Supervisor(supervisorContext({ sessionFile: other }), hooks);
		expect(bad.checkSpawnable("scout")).toMatch(/could not be created, or is a symlink/);
		expect(new Supervisor(supervisorContext(), hooks).checkSpawnable("scout")).toBeNull();
	});

	it("is refused everywhere when the session's own folder is a symlink", () => {
		dir = mkdtempSync(join(tmpdir(), "taskforce-resume-"));
		const own = join(dir, "sessions", "p", "parent.jsonl");
		const target = join(dir, "anywhere");
		mkdirSync(join(dir, "sessions", "p", "subagents"), { recursive: true });
		mkdirSync(target);
		writeFileSync(own, "");
		symlinkSync(target, join(dir, "sessions", "p", "subagents", "parent"));
		const planted = join(target, "x.jsonl");
		writeFileSync(planted, "{}\n");
		const supervisor = new Supervisor(supervisorContext({ sessionFile: own }), hooks);
		expect(supervisor.transcriptProblem(join(dir, "sessions", "p", "subagents", "parent", "x.jsonl"))).toMatch(/not saved|outside/);
		expect(supervisor.transcriptProblem(planted)).toMatch(/not saved|outside/);
	});
});

describe("§8 what a child writes on its output", () => {
	it("drops a line past the cap instead of buffering it", () => {
		const stream = new PassThrough();
		const lines: string[] = [];
		let overflowed = 0;
		attachJsonlReader(stream, (line) => lines.push(line), () => overflowed++, 16);
		stream.write("{\"type\":\"a\"}\n");
		stream.write("x".repeat(40));
		stream.write("more\n{\"type\":\"b\"}\n");
		expect(lines).toEqual(["{\"type\":\"a\"}"]);
		expect(overflowed).toBe(1);
	});

	it("holds a whole line in one chunk to the cap, and one spanning chunks", () => {
		for (const writes of [[`${"y".repeat(100)}\n`], ["y".repeat(10), `${"y".repeat(10)}\n{"type":"c"}\n`]]) {
			const stream = new PassThrough();
			const lines: string[] = [];
			let overflowed = 0;
			attachJsonlReader(stream, (line) => lines.push(line), () => overflowed++, 16);
			for (const chunk of writes) stream.write(chunk);
			expect(lines).toEqual([]);
			expect(overflowed).toBe(1);
		}
	});

	it("survives output that is JSON but not a message", async () => {
		const fake = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
		const run = new ChildRun(
			{
				command: process.execPath, args: [fake], cwd: process.cwd(),
				env: { ...process.env, FAKE_PI_SCRIPT: "garbage" },
				task: "go", silenceTimeoutMs: 60_000, timeoutMs: 0,
				model: null, thinking: null,
			},
			{ onSessionFile: () => {}, onAsk: () => {}, onEnd: () => {}, onUpdate: () => {} },
		);
		void run.begin();
		const outcome = await run.waitForEnd();
		expect(outcome.failed).toBe(false);
		expect(outcome.result).toBe("Found it: the parser lives in src/parse.ts.");
	});
});

describe("§13 who a child's question is from", () => {
	function brokerWith(options: { asksUserDirectly: boolean; isRoot: boolean; forkedChild: boolean }) {
		const children = new ChildRecords(() => {});
		children.add({
			uuid: "child-1", parentUuid: "root", type: "scout", failed: false, sessionFile: null,
			spawnedAt: 0, depth: 2, forked: options.forkedChild,
		});
		const tf = {
			children,
			self: { uuid: "root" },
			isRoot: options.isRoot,
			asksUserDirectly: options.asksUserDirectly,
		} as unknown as Taskforce;
		const woken: string[] = [];
		const broker = new AskBroker({ appendEntry: () => {} } as never, tf, { wake: (m) => woken.push(m), onChange: () => {} });
		return { broker, woken };
	}

	function pending(envelope: unknown): PendingAsk & { answered: AskResult[] } {
		const answered: AskResult[] = [];
		return { requestId: "r", envelope: envelope as never, arrivedAt: 0, answer: (r) => answered.push(r), answered };
	}

	const question = { context: null, questions: [{ id: "q", prompt: "Which?", type: "text" }] };

	it("names the child as its parent recorded it, not as it claims", () => {
		const { broker } = brokerWith({ asksUserDirectly: true, isRoot: true, forkedChild: false });
		broker.onChildAsk("child-1", pending({ from: { agentId: "root", agentType: "root", depth: 1 }, asksUserDirectly: true, ask: question }));
		const waiting = broker.waitingQuestions;
		expect(waiting).toHaveLength(1);
		expect(waiting[0]!.envelope.from).toEqual({ agentId: "child-1", agentType: "scout", depth: 2 });
		expect(waiting[0]!.envelope.asksUserDirectly).toBe(false);
	});

	it("refuses a question from an agent that is not its child, or one that does not validate", () => {
		const { broker } = brokerWith({ asksUserDirectly: true, isRoot: true, forkedChild: true });
		const stranger = pending({ from: { agentId: "x", agentType: "x", depth: 2 }, asksUserDirectly: true, ask: question });
		broker.onChildAsk("someone-else", stranger);
		expect(stranger.answered).toEqual([CANCELLED_RESULT]);
		const broken = pending({ from: {}, asksUserDirectly: false, ask: { questions: [{ id: "q" }] } });
		broker.onChildAsk("child-1", broken);
		expect(broken.answered).toEqual([CANCELLED_RESULT]);
	});

	it("lets only a forked child on a direct path reach the user", () => {
		const isolated = brokerWith({ asksUserDirectly: false, isRoot: false, forkedChild: true });
		isolated.broker.onChildAsk("child-1", pending({ from: {}, asksUserDirectly: true, ask: question }));
		expect(isolated.broker.waitingQuestions).toHaveLength(1);
	});

	it("passes a confirm question on, at every hop, without letting a child pick its options", () => {
		const confirm = { context: null, questions: [{ id: "go", prompt: "Proceed?", type: "confirm", options: [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }] }] };
		const { broker } = brokerWith({ asksUserDirectly: false, isRoot: false, forkedChild: false });
		broker.onChildAsk("child-1", pending({ from: {}, asksUserDirectly: false, ask: confirm }));
		const first = broker.waitingQuestions[0]!.envelope;
		expect(first.ask.questions[0]!.options.map((o) => o.value)).toEqual(["yes", "no"]);
		// The next parent up revalidates what this one would relay.
		const up = brokerWith({ asksUserDirectly: false, isRoot: false, forkedChild: false });
		up.broker.onChildAsk("child-1", pending(first));
		expect(up.broker.waitingQuestions).toHaveLength(1);
		const forged = { context: null, questions: [{ id: "go", prompt: "Proceed?", type: "confirm", options: [{ value: "rm -rf", label: "Yes" }] }] };
		const third = brokerWith({ asksUserDirectly: false, isRoot: false, forkedChild: false });
		third.broker.onChildAsk("child-1", pending({ from: {}, asksUserDirectly: false, ask: forged }));
		expect(third.broker.waitingQuestions[0]!.envelope.ask.questions[0]!.options.map((o) => o.value)).toEqual(["yes", "no"]);
	});

	it("keeps a parent's comma inside a text answer, and splits only a multiselect", () => {
		const { broker } = brokerWith({ asksUserDirectly: false, isRoot: false, forkedChild: false });
		const asked = pending({
			from: {}, asksUserDirectly: false,
			ask: { context: null, questions: [
				{ id: "db", prompt: "Which database?", type: "text" },
				{ id: "features", prompt: "Which?", type: "multiselect", options: [
					{ value: "auth", label: "Auth" }, { value: "billing", label: "Billing" },
				] },
			] },
		});
		broker.onChildAsk("child-1", asked);
		const reference = broker.waitingQuestions[0]!.reference;
		expect(broker.answer(reference, [
			{ id: "db", value: "Postgres, with pgvector" },
			{ id: "features", value: "auth, billing" },
		])).toBeNull();
		const [db, features] = asked.answered[0]!.answers;
		expect(db!.values).toEqual(["Postgres, with pgvector"]);
		expect(features!.values).toEqual(["auth", "billing"]);
		expect(features!.labels).toEqual(["Auth", "Billing"]);
		expect(features!.typed).toBe(false);
	});

	it("says a relayed question's origin came through its own child", () => {
		expect(
			attributionOf(
				{
					from: { agentId: "deep", agentType: "writer", depth: 3 },
					via: [{ agentId: "child-1", agentType: "scout", depth: 2 }],
					asksUserDirectly: true,
					ask: question as never,
				},
				"root",
			),
		).toBe("writer (deep), relayed by scout (child-1)");
	});
});

describe("§8 what a child is started with", () => {
	const fake = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

	async function launch(options: { fork: boolean; argv: string[]; tools?: string; env?: NodeJS.ProcessEnv }) {
		const definition = parseDefinition(
			["name: scout", "label: Scout", ...(options.tools ? [`tools: [${options.tools}]`] : [])].join("\n"),
			"/tmp/scout.yaml", "user",
		);
		const limits = ownToolLimits(options.argv, options.env ?? {});
		const supervisor = new Supervisor(supervisorContext({ toolLimits: limits }), hooks);
		const originalEntry = process.argv[1];
		const originalScript = process.env.FAKE_PI_SCRIPT;
		process.argv[1] = fake;
		process.env.FAKE_PI_SCRIPT = "inspect";
		try {
			const child: AgentRecord = {
				uuid: "child", parentUuid: "root", type: "scout", failed: false, sessionFile: null,
				spawnedAt: 0, depth: 2, forked: options.fork,
			};
			const { run } = await supervisor.spawn(
				{ definition, args: {}, goal: "look", controls: { fork: options.fork, background: false, thinking: null } },
				child,
			);
			const outcome = await run.waitForEnd();
			return JSON.parse(outcome.result!) as { args: string[]; tools: string | null; forkPath: string | null };
		} finally {
			process.argv[1] = originalEntry!;
			if (originalScript === undefined) delete process.env.FAKE_PI_SCRIPT;
			else process.env.FAKE_PI_SCRIPT = originalScript;
			await supervisor.stopAll("test cleanup");
			supervisor.cleanUp();
		}
	}

	const flag = (args: string[], name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

	it("gives a fork its parent's tool flags and its type's allowlist to enforce", async () => {
		const seen = await launch({ fork: true, argv: [...pi, "-t", "read,grep,ask", "-xt", "bash"], tools: "read" });
		expect(flag(seen.args, "--tools")).toBe("read,grep,ask");
		expect(flag(seen.args, "--exclude-tools")).toBe("bash");
		expect(JSON.parse(seen.tools!)).toEqual(["read", "listSubagents", "messageSubagent", "closeSubagent", "delegate", "ask", "answer_subagent"]);
	});

	it("narrows a non-forked child of a restricted fork to what the fork may use", async () => {
		const seen = await launch({ fork: false, argv: [...pi], tools: "read, bash", env: { [ENV.tools]: "[\"read\",\"delegate\"]" } });
		expect(flag(seen.args, "--tools")!.split(",")).toEqual(["read", "delegate"]);
		expect(seen.tools).toBeNull();
		expect(seen.forkPath).toBeNull();
	});

	it("gives a non-forked child none of pi's tools when its parent has none", async () => {
		const seen = await launch({ fork: false, argv: [...pi, "--no-builtin-tools"], tools: "read, bash" });
		expect(flag(seen.args, "--tools")!.split(",")).not.toContain("read");
		expect(flag(seen.args, "--tools")!.split(",")).toContain("delegate");
		expect(seen.args).toContain("--no-builtin-tools");
	});
});
