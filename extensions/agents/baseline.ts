import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ToolLimits } from "./supervisor.js";

/** User-owned infrastructure paths, never selected by a project or agent profile. */
export function baselineExtensions(references: readonly string[]): string[] {
	return [...new Set(references.map((reference) => {
		const path = reference.startsWith("~/") ? join(homedir(), reference.slice(2)) : reference;
		try {
			if (isAbsolute(path) && statSync(path).isFile()) return realpathSync(path);
		} catch { /* Report the required resource rather than silently skipping it. */ }
		throw new Error(`Required child extension is missing or not an absolute file: ${reference}`);
	}))];
}

export function assertBaselineTools(tools: readonly string[], limits: ToolLimits): void {
	const excludedAt = limits.restrictions.indexOf("--exclude-tools");
	const excluded = excludedAt < 0 ? [] : (limits.restrictions[excludedAt + 1] ?? "").split(",");
	for (const tool of tools) {
		if ((limits.allow !== null && !limits.allow.includes(tool)) ||
			(limits.enforced !== null && !limits.enforced.includes(tool)) || excluded.includes(tool) ||
			(limits.noBuiltinTools && ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].includes(tool))) {
			throw new Error(`Required child tool ${tool} is denied by the parent's restrictions; refusing the launch.`);
		}
	}
}

/** Explicit files preserve filtering and extension-discovered skills without loading their source extensions. */
export function skillFlags(paths: readonly string[] | undefined): string[] {
	return paths === undefined ? [] : ["--no-skills", ...[...new Set(paths)].flatMap((path) => ["--skill", path])];
}
