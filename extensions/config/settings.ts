/**
 * §3. Configuration.
 *
 * The list below is exhaustive: the extension reads no setting that is not in
 * it. A project file overrides the global one field by field.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface TodosSettings {
	/** §3. The TODO block, the watcher and the widget. */
	enabled: boolean;
	/** §3. Whether the widget is shown at session start. */
	widget: boolean;
	/** §4. Replaces the base directory. Empty means `<agent dir>/todos`. */
	dir: string;
}

export interface SubagentsSettings {
	enabled: boolean;
	/** §3. Maximum nesting depth, the root counting as one. */
	maxDepth: number;
	/** §3, §7. How many children one agent may have running at once. */
	maxRunning: number;
	/** §3, §8. How long a child may send nothing mid-run before it is stopped. */
	silenceTimeoutMs: number;
	/** §16. Which number key opens the subagent panel with Alt. */
	panelKey: number;
	/** §6. More agent directories, read before `~/.pi/agents`. Global file only. */
	agentDirs: string[];
	/** Required infrastructure for every child. Global settings only. */
	sharedExtensions: string[];
	sharedTools: string[];
}

export interface AskSettings {
	enabled: boolean;
	/** §12. Ring the bell and post a desktop notification when a question shows. */
	notify: boolean;
}

export interface Settings {
	todos: TodosSettings;
	subagents: SubagentsSettings;
	ask: AskSettings;
}

export const DEFAULT_SETTINGS: Settings = {
	todos: { enabled: true, widget: true, dir: "" },
	subagents: {
		enabled: true, maxDepth: 3, maxRunning: 8, silenceTimeoutMs: 10 * 60 * 1000,
		panelKey: 1, agentDirs: [], sharedExtensions: [], sharedTools: [],
	},
	ask: { enabled: true, notify: true },
};

export const PROJECT_SETTINGS_FILE = "pi-taskforce.json";

export function globalSettingsPath(configDirName = ".pi"): string {
	return join(homedir(), configDirName, "config", "pi-taskforce", "settings.json");
}

export function projectSettingsPath(cwd: string, configDirName = ".pi"): string {
	return join(cwd, configDirName, PROJECT_SETTINGS_FILE);
}

type SettingsPatch = {
	todos?: Partial<TodosSettings>;
	subagents?: Partial<SubagentsSettings>;
	ask?: Partial<AskSettings>;
};

/** §3. The project file is read only for a trusted project (`config/trust.ts`). */
export function loadSettings(cwd: string, configDirName = ".pi", projectTrusted = true): Settings {
	const global = readPatch(globalSettingsPath(configDirName));
	const project = projectTrusted ? readPatch(projectSettingsPath(cwd, configDirName)) : {};
	// §6. Which folders hold agent definitions is the user's choice, never a project's.
	if (project.subagents && typeof project.subagents === "object") {
		delete project.subagents.agentDirs;
		delete project.subagents.sharedExtensions;
		delete project.subagents.sharedTools;
	}
	return normalize(merge(merge(DEFAULT_SETTINGS, global), project));
}

function readPatch(path: string): SettingsPatch {
	if (!existsSync(path)) return {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as SettingsPatch) : {};
	} catch {
		// §3. A file that does not parse leaves the defaults in place.
		return {};
	}
}

function merge(base: Settings, patch: SettingsPatch): Settings {
	return {
		todos: { ...base.todos, ...patch.todos },
		subagents: { ...base.subagents, ...patch.subagents },
		ask: { ...base.ask, ...patch.ask },
	};
}

/** Only known keys survive, and numbers are clamped (§3). */
function normalize(settings: Settings): Settings {
	return {
		todos: {
			enabled: Boolean(settings.todos.enabled),
			widget: Boolean(settings.todos.widget),
			dir: typeof settings.todos.dir === "string" ? settings.todos.dir : "",
		},
		subagents: {
			enabled: Boolean(settings.subagents.enabled),
			maxDepth: clampInt(settings.subagents.maxDepth, 1, 16, 3),
			maxRunning: clampInt(settings.subagents.maxRunning, 1, 64, 8),
			silenceTimeoutMs: clampInt(settings.subagents.silenceTimeoutMs, 10_000, 86_400_000, 600_000),
			panelKey: clampInt(settings.subagents.panelKey, 0, 9, 1),
			agentDirs: agentDirList(settings.subagents.agentDirs),
			sharedExtensions: stringList(settings.subagents.sharedExtensions),
			sharedTools: stringList(settings.subagents.sharedTools),
		},
		ask: { enabled: Boolean(settings.ask.enabled), notify: Boolean(settings.ask.notify) },
	};
}

/** §6. Absolute paths and `~/` paths; anything else is dropped. */
function agentDirList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const out: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const trimmed = entry.trim();
		const path = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
		if (isAbsolute(path) && !out.includes(path)) out.push(path);
	}
	return out;
}

function stringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return [...new Set(value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim()))];
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	const number = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
	return Math.min(max, Math.max(min, number));
}
