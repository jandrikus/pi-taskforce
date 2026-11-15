import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildChildEnv, readChildIdentity } from "../extensions/agents/env.js";
import { resolveExtensionReference } from "../extensions/agents/supervisor.js";
import { loadSettings } from "../extensions/config/settings.js";
import { decideProjectTrust, projectConfigFiles } from "../extensions/config/trust.js";
import { Taskforce } from "../extensions/runtime.js";

const none = { savedDecision: () => null, defaultProjectTrust: () => undefined };

describe("§3, §6 project trust", () => {
	it("trusts a project only on purpose", () => {
		expect(decideProjectTrust({ argv: ["node", "pi"], ...none })).toBe(false);
		expect(decideProjectTrust({ argv: ["node", "pi", "--approve"], ...none })).toBe(true);
		expect(decideProjectTrust({ argv: ["node", "pi", "-a"], ...none })).toBe(true);
		expect(decideProjectTrust({ argv: ["node", "pi"], ...none, savedDecision: () => true })).toBe(true);
		expect(decideProjectTrust({ argv: ["node", "pi"], ...none, defaultProjectTrust: () => "always" })).toBe(true);
		expect(decideProjectTrust({ argv: ["node", "pi"], ...none, defaultProjectTrust: () => "ask" })).toBe(false);
	});

	it("lets the command line win, the last flag first, and a saved no beat the default", () => {
		const trusting = { savedDecision: () => true, defaultProjectTrust: () => "always" };
		expect(decideProjectTrust({ argv: ["node", "pi", "--no-approve"], ...trusting })).toBe(false);
		expect(decideProjectTrust({ argv: ["node", "pi", "-a", "-na"], ...none })).toBe(false);
		expect(decideProjectTrust({ argv: ["node", "pi", "-na", "-a"], ...none })).toBe(true);
		expect(
			decideProjectTrust({ argv: ["node", "pi"], savedDecision: () => false, defaultProjectTrust: () => "always" }),
		).toBe(false);
	});

	it("trusts nothing when the trust store cannot be read", () => {
		const broken = {
			savedDecision: () => {
				throw new Error("corrupt");
			},
			defaultProjectTrust: () => "always",
		};
		expect(decideProjectTrust({ argv: ["node", "pi"], ...broken })).toBe(false);
	});

	it("passes the root's decision down to a child", () => {
		const identity = {
			agentId: "c", parentId: "p", agentType: "general", depth: 2, maxDepth: 3, maxRunning: 8, silenceTimeoutMs: 600_000, tools: null,
			features: { todos: true, subagents: true, ask: true }, forked: false, forkPath: false, spawnable: null,
		};
		expect(readChildIdentity(buildChildEnv({ ...identity, projectTrusted: true }))?.projectTrusted).toBe(true);
		expect(readChildIdentity(buildChildEnv({ ...identity, projectTrusted: false }))?.projectTrusted).toBe(false);
	});
});

describe("§3, §6 an untrusted project's own configuration", () => {
	let project: string;

	beforeEach(() => {
		project = mkdtempSync(join(tmpdir(), "taskforce-trust-"));
		mkdirSync(join(project, ".pi", "agents"), { recursive: true });
		mkdirSync(join(project, ".pi", "extensions"), { recursive: true });
		writeFileSync(join(project, ".pi", "evil.ts"), "export default function () {}\n");
		writeFileSync(join(project, ".pi", "extensions", "named.ts"), "export default function () {}\n");
		writeFileSync(
			join(project, ".pi", "agents", "general.yaml"),
			"name: general\nlabel: Project General\nextensions: [.pi/evil.ts]\n",
		);
		writeFileSync(join(project, ".pi", "pi-taskforce.json"), JSON.stringify({ subagents: { maxDepth: 9 } }));
	});

	afterEach(() => rmSync(project, { recursive: true, force: true }));

	it("is not read, so a project cannot replace a built-in agent", () => {
		const tf = new Taskforce(project, () => {}, { projectTrusted: false });
		const general = tf.catalog.byName.get("general");
		expect(general?.label).not.toBe("Project General");
		expect(general?.extensions).toEqual([]);
		expect(tf.settings.subagents.maxDepth).not.toBe(9);
	});

	it("is read once the project is trusted", () => {
		const tf = new Taskforce(project, () => {}, { projectTrusted: true });
		expect(tf.catalog.byName.get("general")?.label).toBe("Project General");
		expect(loadSettings(project, ".pi", true).subagents.maxDepth).toBe(9);
	});

	it("does not resolve extension files the project supplies", () => {
		expect(resolveExtensionReference(".pi/evil.ts", project, false)).toBeNull();
		expect(resolveExtensionReference("named", project, false)).toBeNull();
		expect(resolveExtensionReference(".pi/evil.ts", project, true)).toBe(join(project, ".pi", "evil.ts"));
		expect(resolveExtensionReference("named", project, true)).toBe(join(project, ".pi", "extensions", "named.ts"));
		// An absolute path is the user's own choice, whatever the project.
		expect(resolveExtensionReference(join(project, ".pi", "evil.ts"), "/", false)).toBe(join(project, ".pi", "evil.ts"));
	});

	it("never takes agent directories from a trusted project", () => {
		writeFileSync(
			join(project, ".pi", "pi-taskforce.json"),
			JSON.stringify({ subagents: { maxDepth: 5, agentDirs: [join(project, "agents")], sharedExtensions: ["/project/evil.ts"], sharedTools: ["evil"] } }),
		);
		const settings = loadSettings(project, ".pi", true);
		expect(settings.subagents.maxDepth).toBe(5);
		expect(settings.subagents.agentDirs).not.toContain(join(project, "agents"));
		expect(settings.subagents.sharedExtensions).not.toContain("/project/evil.ts");
		expect(settings.subagents.sharedTools).not.toContain("evil");
	});

	it("reads agent directories from the global file, as absolute or ~/ paths", () => {
		const home = mkdtempSync(join(tmpdir(), "taskforce-home-"));
		const saved = process.env.HOME;
		try {
			process.env.HOME = home;
			const dir = join(home, ".pi", "config", "pi-taskforce");
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, "settings.json"),
				JSON.stringify({ subagents: { agentDirs: ["~/shared/agents", "/opt/agents", "relative", 3, "/opt/agents"], sharedExtensions: ["~/memory.ts"], sharedTools: ["recall", "search", "fetch"] } }),
			);
			expect(loadSettings(project, ".pi", true).subagents.sharedExtensions).toEqual(["~/memory.ts"]);
			expect(loadSettings(project, ".pi", true).subagents.sharedTools).toEqual(["recall", "search", "fetch"]);
			expect(loadSettings(project, ".pi", false).subagents.agentDirs).toEqual([
				join(home, "shared", "agents"),
				"/opt/agents",
			]);
		} finally {
			process.env.HOME = saved;
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("names the files it skipped", () => {
		expect(projectConfigFiles(project)).toEqual([
			join(project, ".pi", "agents"),
			join(project, ".pi", "pi-taskforce.json"),
		]);
		expect(projectConfigFiles(join(project, "nowhere"))).toEqual([]);
	});
});
