import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { delegationProblem, loadCatalog, parseDefinition, renderGoal, renderTask } from "../extensions/agents/definitions.js";

function parse(source: string) {
	return parseDefinition(source, "/tmp/agent.yml", "user");
}

describe("§6 what an agent definition is", () => {
	it("requires a tool-safe name and a label", () => {
		expect(() => parse("label: X")).toThrow(/tool-safe identifier/);
		expect(() => parse("name: 'my agent'\nlabel: X")).toThrow(/tool-safe identifier/);
		expect(() => parse("name: '-bad'\nlabel: X")).toThrow(/tool-safe identifier/);
		expect(() => parse("name: good\n")).toThrow(/`label` is required/);
		expect(parse("name: good_one-2\nlabel: Good").name).toBe("good_one-2");
	});

	it("refuses a prompt field it does not define, and names the one to use", () => {
		expect(() => parse("name: a\nlabel: A\nprompt: do the thing")).toThrow(
			/`prompt` is not a field of an agent definition; use `taskTemplate`/,
		);
		expect(() => parse("name: a\nlabel: A\ndescription: a thing")).toThrow(/use `promptSnippet`/);
		expect(() => parse("name: a\nlabel: A\nsystemPrompt: x")).toThrow(
			/use `identity or appendSystemPrompt`/,
		);
	});

	it("defaults the fields the writeup gives defaults for", () => {
		const definition = parse("name: a\nlabel: A");
		expect(definition.enabled).toBe(true);
		expect(definition.includeParentAppendSystemPrompt).toBe(true);
		expect(definition.piDocs).toBe(false);
		expect(definition.timeoutMs).toBe(0);
		expect(definition.subagents).toBeNull();
		expect(definition.tools).toEqual([]);
	});

	it("reads `subagents: none` as spawning nothing, and an absent field as all", () => {
		expect(parse("name: a\nlabel: A\nsubagents: none").subagents).toEqual([]);
		expect(parse("name: a\nlabel: A\nsubagents: [none]").subagents).toEqual([]);
		expect(parse("name: a\nlabel: A\nsubagents: [scout, writer]").subagents).toEqual([
			"scout",
			"writer",
		]);
		expect(parse("name: a\nlabel: A").subagents).toBeNull();
	});

	it("floors the watchdogs whatever the file says", () => {
		const definition = parse("name: a\nlabel: A\nsilenceTimeoutMs: 5\ntimeoutMs: -4");
		expect(definition.silenceTimeoutMs).toBe(10_000);
		expect(definition.timeoutMs).toBe(0);
	});

	it("still reads a definition written for the old submit reminders", () => {
		expect(parse("name: a\nlabel: A\nsubmitReminders: 2").name).toBe("a");
	});

	it("ignores an unknown thinking level", () => {
		expect(parse("name: a\nlabel: A\nthinking: enormous").thinking).toBeNull();
		expect(parse("name: a\nlabel: A\nthinking: high").thinking).toBe("high");
	});
});

describe("§8 assembling the task from the template", () => {
	const definition = parseDefinition(
		[
			"name: a",
			"label: A",
			"parameters:",
			"  - name: topic",
			"    description: what to look at",
			"  - name: depth",
			"    description: how deep",
			"    required: false",
			"taskTemplate: |",
			"  Look at {topic}.",
			"  Go {depth} deep.",
		].join("\n"),
		"/tmp/agent.yml",
		"user",
	);

	it("fills placeholders from the call", () => {
		expect(renderTask(definition, { topic: "the parser", depth: "two levels" })).toBe(
			"Look at the parser.\nGo two levels deep.",
		);
	});

	it("drops a line holding the placeholder of an omitted parameter", () => {
		expect(renderTask(definition, { topic: "the parser" })).toBe("Look at the parser.");
	});

	it("appends a supplied parameter that has no placeholder", () => {
		const other = parseDefinition(
			[
				"name: b",
				"label: B",
				"parameters:",
				"  - name: topic",
				"    description: what",
				"  - name: extra",
				"    description: more",
				"taskTemplate: Look at {topic}.",
			].join("\n"),
			"/tmp/agent.yml",
			"user",
		);
		expect(renderTask(other, { topic: "x", extra: "y" })).toBe("Look at x.\n\nextra: y");
	});
});

describe("goal-based delegation definitions", () => {
	it("renders the goal without needing a parameters declaration", () => {
		expect(renderGoal(parse("name: a\nlabel: A"), "Do it")).toBe("Do it");
		expect(renderGoal(parse("name: a\nlabel: A\ntaskTemplate: 'Verify {goal}'"), "the parser")).toBe("Verify the parser");
	});

	it("keeps static template instructions and substitutes every goal literally", () => {
		expect(renderGoal(parse("name: a\nlabel: A\ntaskTemplate: Never edit tests"), "Fix the parser")).toBe("Never edit tests\n\nFix the parser");
		expect(renderGoal(parse("name: a\nlabel: A\ntaskTemplate: '{goal} then {goal}'"), "$&")).toBe("$& then $&");
	});

	it("diagnoses incompatible legacy declarations without breaking their renderer", () => {
		const legacy = parse("name: a\nlabel: A\nparameters:\n  - name: topic\ntaskTemplate: 'Inspect {topic}'");
		expect(delegationProblem(legacy)).toMatch(/needs migration.*only `goal`.*topic/);
		expect(() => renderGoal(legacy, "Inspect the parser")).toThrow(/rewrite taskTemplate to use \{goal\}/);
		expect(renderTask(legacy, { topic: "the parser" })).toBe("Inspect the parser");
		expect(delegationProblem(parse("name: a\nlabel: A\ntaskTemplate: '{unknown}'"))).toMatch(/unknown/);
		expect(delegationProblem(parse("name: a\nlabel: A\nparameters:\n  - name: goal\ntaskTemplate: '{goal}'"))).toBeNull();
	});

	it("loads extra agent directories before user and project definitions", () => {
		const shared = mkdtempSync(join(tmpdir(), "taskforce-shared-"));
		const user = mkdtempSync(join(tmpdir(), "taskforce-user-"));
		const project = mkdtempSync(join(tmpdir(), "taskforce-project-"));
		try {
			writeFileSync(join(shared, "scout.yml"), "name: scout\nlabel: Shared Scout");
			writeFileSync(join(shared, "research.yml"), "name: research\nlabel: Shared Research");
			writeFileSync(join(user, "scout.yml"), "name: scout\nlabel: User Scout");
			writeFileSync(join(project, "scout.yml"), "name: scout\nlabel: Project Scout");
			const catalog = loadCatalog(user, project, [shared]);
			expect(catalog.failures).toEqual([]);
			expect(catalog.byName.get("research")?.label).toBe("Shared Research");
			expect(catalog.byName.get("scout")?.label).toBe("Project Scout");
			writeFileSync(join(project, "scout.yml"), "name: scout\nlabel: Disabled\nenabled: false");
			expect(loadCatalog(user, project, [shared]).byName.has("scout")).toBe(false);
		} finally {
			rmSync(shared, { recursive: true, force: true });
			rmSync(user, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});

	it("provides general in an empty catalog, honors overrides and explicit disablement", () => {
		const user = mkdtempSync(join(tmpdir(), "taskforce-user-"));
		const project = mkdtempSync(join(tmpdir(), "taskforce-project-"));
		try {
			const fallback = loadCatalog(user, project).byName.get("general");
			expect(fallback?.path).toBe("<built-in general>");
			expect(fallback?.tools).toEqual([]);
			expect(renderGoal(fallback!, "Do it")).toBe("Do it");
			writeFileSync(join(user, "general.yml"), "name: general\nlabel: Custom\nmodel: custom-model");
			expect(loadCatalog(user, project).byName.get("general")?.model).toBe("custom-model");
			writeFileSync(join(project, "general.yml"), "name: general\nlabel: Disabled\nenabled: false");
			expect(loadCatalog(user, project).byName.has("general")).toBe(false);
		} finally {
			rmSync(user, { recursive: true, force: true });
			rmSync(project, { recursive: true, force: true });
		}
	});
});

describe("§8 what a forked child is started with", () => {
	it("passes on this process's own extension flags, and nothing else", async () => {
		const { ownExtensionFlags } = await import("../extensions/agents/supervisor.js");
		expect(
			ownExtensionFlags(["node", "pi", "--mode", "rpc", "-ne", "-e", "/x/index.ts", "--model", "m"]),
		).toEqual(["--no-extensions", "-e", "/x/index.ts"]);
		expect(ownExtensionFlags(["node", "pi", "--model", "m"])).toEqual([]);
		expect(ownExtensionFlags(["node", "pi", "--extension", "/a.ts", "--extension", "/b.ts"])).toEqual([
			"-e",
			"/a.ts",
			"-e",
			"/b.ts",
		]);
	});
});
