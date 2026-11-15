/**
 * §3, §6. Whether this project's own configuration is read: its agent
 * definitions in `<project>/.pi/agents` and its `<project>/.pi/pi-taskforce.json`.
 *
 * pi keeps a project's `.pi/extensions` and `.pi/settings.json` behind project
 * trust, but it does not know these files, and a folder holding none of the files
 * it knows counts as trusted without a prompt. A project agent definition can load
 * an extension into a child process, so it is code, and it is read only when the
 * project was trusted on purpose: `--approve` on the command line, a saved trust
 * decision for the folder or one above it, or `defaultProjectTrust: "always"`.
 *
 * The decision is made when the extension loads, before pi has resolved trust for
 * the session, so a "this session only" decision is not seen. The project's files
 * are then skipped, and the user is told how to allow them.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import * as piAgent from "@earendil-works/pi-coding-agent";

export interface TrustInputs {
	/** The command line this process was started with. */
	argv: readonly string[];
	/** pi's saved decision for the folder or its nearest ancestor, or `null` when none is saved. */
	savedDecision: () => boolean | null;
	/** pi's global `defaultProjectTrust` setting. */
	defaultProjectTrust: () => string | undefined;
}

export function decideProjectTrust(inputs: TrustInputs): boolean {
	let override: boolean | undefined;
	try {
		override = parsePiArgs(inputs.argv).projectTrustOverride;
	} catch {
		// A command line pi itself cannot read trusts nothing.
		return false;
	}
	if (override !== undefined) return override;
	try {
		const saved = inputs.savedDecision();
		if (saved !== null) return saved;
		return inputs.defaultProjectTrust() === "always";
	} catch {
		// An unreadable trust store or settings file trusts nothing.
		return false;
	}
}

/**
 * pi's own reading of a command line, so a flag means here exactly what it means
 * to pi: nothing after `--` is a flag, and a flag's value is not one either.
 * `argv` is the whole `process.argv`, runtime and script first.
 */
export function parsePiArgs(argv: readonly string[]): piAgent.Args {
	return piAgent.parseArgs(argv.slice(2));
}

/** The decision for a root session, read from pi's own trust store and settings. */
export function projectConfigTrusted(cwd: string, argv: readonly string[] = process.argv): boolean {
	const agentDir = piAgent.getAgentDir();
	return decideProjectTrust({
		argv,
		savedDecision: () => {
			const Store = (piAgent as { ProjectTrustStore?: new (dir: string) => { get(cwd: string): boolean | null } })
				.ProjectTrustStore;
			// A pi without a trust store gives no way to know, so nothing is trusted.
			return Store ? new Store(agentDir).get(cwd) : false;
		},
		defaultProjectTrust: () => {
			const path = join(agentDir, "settings.json");
			if (!existsSync(path)) return undefined;
			const parsed = JSON.parse(readFileSync(path, "utf8")) as {
				defaultProjectTrust?: unknown;
			};
			return typeof parsed.defaultProjectTrust === "string" ? parsed.defaultProjectTrust : undefined;
		},
	});
}

/** The project files this extension would read, so a skipped one can be named. */
export function projectConfigFiles(cwd: string, configDirName = ".pi"): string[] {
	const found: string[] = [];
	const agents = join(cwd, configDirName, "agents");
	try {
		if (readdirSync(agents).some((entry) => /\.ya?ml$/i.test(entry))) found.push(agents);
	} catch {
		// No agents directory.
	}
	const settings = join(cwd, configDirName, "pi-taskforce.json");
	if (existsSync(settings)) found.push(settings);
	return found;
}
