import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { baselineExtensions, assertBaselineTools, skillFlags } from "../extensions/agents/baseline.js";
import { ownToolLimits } from "../extensions/agents/supervisor.js";

const tools = ["recall", "search", "fetch"];

describe("shared child capabilities", () => {
	it("resolves and deduplicates required extensions, refusing missing files", () => {
		const dir = mkdtempSync(join(tmpdir(), "taskforce-baseline-"));
		try {
			const path = join(dir, "memory.ts");
			writeFileSync(path, "export default () => {};");
			expect(baselineExtensions([path, path])).toEqual([path]);
			expect(() => baselineExtensions([join(dir, "missing.ts")])).toThrow(/Required child extension/);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("never bypasses parent tool restrictions", () => {
		for (const args of [["--tools", "read"], ["--exclude-tools", "fetch"], ["--no-tools"]]) {
			expect(() => assertBaselineTools(tools, ownToolLimits(["bun", "pi", ...args], {}))).toThrow(/Required child tool/);
		}
		expect(() => assertBaselineTools(tools, ownToolLimits(["bun", "pi"], {}))).not.toThrow();
	});

	it("passes exactly the parent's discovered skill files, including an empty catalog", () => {
		expect(skillFlags(["/skills/a/SKILL.md", "/skills/a/SKILL.md"])).toEqual(["--no-skills", "--skill", "/skills/a/SKILL.md"]);
		expect(skillFlags([])).toEqual(["--no-skills"]);
		expect(skillFlags(undefined)).toEqual([]);
	});
});
