import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ENV, withoutTaskforceEnv } from "../extensions/agents/env.js";
import { configuredSettingsPath, loadSettings } from "../extensions/config/settings.js";

describe("§3 an explicit settings file", () => {
	let root: string;
	let project: string;
	let config: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "taskforce-config-"));
		project = join(root, "project");
		config = join(root, "scoped-taskforce.json");
		mkdirSync(project, { recursive: true });
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("replaces the global file for this process tree", () => {
		const env = { [ENV.config]: config, HOME: root };
		writeFileSync(
			config,
			JSON.stringify({
				subagents: {
					agentDirs: [],
					sharedExtensions: ["/opt/infrastructure/search.ts"],
					sharedTools: ["search", "fetch"],
					maxDepth: 2,
				},
			}),
		);
		const settings = loadSettings(project, ".pi", false, env);
		expect(settings.subagents.sharedExtensions).toEqual(["/opt/infrastructure/search.ts"]);
		expect(settings.subagents.sharedTools).toEqual(["search", "fetch"]);
		expect(settings.subagents.maxDepth).toBe(2);
		expect(configuredSettingsPath(env)).toBe(config);
	});

	it("fails clearly when an explicit file is missing, malformed, or names an unknown setting", () => {
		const missing = { [ENV.config]: join(root, "missing.json"), HOME: root };
		expect(() => loadSettings(project, ".pi", false, missing)).toThrow(/cannot read PI_TASKFORCE_CONFIG.*missing\.json/);

		writeFileSync(config, "{ not json");
		expect(() => loadSettings(project, ".pi", false, { [ENV.config]: config, HOME: root })).toThrow(
			/invalid PI_TASKFORCE_CONFIG.*Expected property name/,
		);

		writeFileSync(config, JSON.stringify({ subagents: { sharedTool: ["search"] } }));
		expect(() => loadSettings(project, ".pi", false, { [ENV.config]: config, HOME: root })).toThrow(
			/unknown setting 'subagents\.sharedTool'/,
		);
	});

	it("rejects a relative or empty override instead of guessing a location", () => {
		expect(() => configuredSettingsPath({ [ENV.config]: "relative.json" })).toThrow(/absolute or ~\/ path/);
		expect(() => configuredSettingsPath({ [ENV.config]: "  " })).toThrow(/must name a settings file/);
	});

	it("keeps the selected file in a child environment while stripping taskforce identity", () => {
		const env = {
			[HOME_KEY]: root,
			[ENV.config]: config,
			[ENV.agentId]: "parent",
			[ENV.parentId]: "grandparent",
			UNRELATED: "kept",
		};
		const child = withoutTaskforceEnv(env);
		expect(child[ENV.config]).toBe(config);
		expect(child[ENV.agentId]).toBeUndefined();
		expect(child[ENV.parentId]).toBeUndefined();
		expect(child.UNRELATED).toBe("kept");
	});
});

const HOME_KEY = "HOME";
