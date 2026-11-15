/**
 * §6. What an agent definition is.
 *
 * An agent type is one YAML file, and the file is the whole definition: no
 * registry, no code to write, nothing to list anywhere else. Definitions are
 * read from the extra directories in the settings, `~/.pi/agents` and
 * `<project>/.pi/agents` at every session start. Later directories override
 * earlier ones as whole files.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export interface AgentParameter {
	name: string;
	description: string;
	required: boolean;
}

export interface AgentDefinition {
	name: string;
	label: string;
	enabled: boolean;
	promptSnippet: string | null;
	promptGuidelines: string[];
	parameters: AgentParameter[];
	taskTemplate: string | null;
	/** The allowlist of **pi's own** tools. Empty or absent means unrestricted. */
	tools: string[];
	model: string | null;
	extensions: string[];
	identity: string | null;
	appendSystemPrompt: string | null;
	includeParentAppendSystemPrompt: boolean;
	piDocs: boolean;
	fork: boolean;
	background: boolean;
	thinking: ThinkingLevel | null;
	/** §6. The agent types this agent may spawn. `null` means all of them. */
	subagents: string[] | null;
	silenceTimeoutMs: number | null;
	timeoutMs: number;
	/** Where the definition was read from, for the control panel (§14). */
	path: string;
	scope: "user" | "project";
}

export interface DefinitionFailure {
	path: string;
	reason: string;
}

export interface Catalog {
	byName: Map<string, AgentDefinition>;
	failures: DefinitionFailure[];
}

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * §6. A file naming a prompt field this document does not define is refused,
 * and the refusal names the field to use instead. Silently ignoring one strips
 * an agent of its instructions and nobody notices.
 */
const PROMPT_FIELD_CORRECTIONS: Record<string, string> = {
	prompt: "taskTemplate",
	systemprompt: "identity or appendSystemPrompt",
	system: "identity or appendSystemPrompt",
	instructions: "taskTemplate",
	instruction: "taskTemplate",
	guidelines: "promptGuidelines",
	guideline: "promptGuidelines",
	rules: "promptGuidelines",
	description: "promptSnippet",
	whentouse: "promptSnippet",
	summary: "promptSnippet",
	template: "taskTemplate",
	prompttemplate: "taskTemplate",
	task: "taskTemplate",
	persona: "identity",
	role: "identity",
	appendsystemprompts: "appendSystemPrompt",
	promptsnippets: "promptSnippet",
};

const KNOWN_FIELDS = new Set([
	"name",
	"label",
	"enabled",
	"promptSnippet",
	"promptGuidelines",
	"parameters",
	"taskTemplate",
	"tools",
	"model",
	"extensions",
	"identity",
	"appendSystemPrompt",
	"includeParentAppendSystemPrompt",
	"piDocs",
	"fork",
	"background",
	"thinking",
	"subagents",
	"silenceTimeoutMs",
	"timeoutMs",
	// Read by earlier versions, and ignored now that a child's final message is its result.
	"submitReminders",
]);

export function loadCatalog(
	userAgentsDir: string,
	projectAgentsDir: string | null,
	extraAgentDirs: readonly string[] = [],
): Catalog {
	const failures: DefinitionFailure[] = [];
	// Merge the fallback first so YAML can customize it or explicitly disable it.
	const general = builtinGeneral();
	const byName = new Map<string, AgentDefinition>([[general.name, general]]);

	for (const [dir, scope] of [
		...extraAgentDirs.map((dir): [string, "user"] => [dir, "user"]),
		[userAgentsDir, "user"],
		[projectAgentsDir, "project"],
	] as Array<[string | null, "user" | "project"]>) {
		if (!dir) continue;
		for (const path of yamlFilesIn(dir)) {
			let definition: AgentDefinition;
			try {
				definition = parseDefinition(readFileSync(path, "utf8"), path, scope);
			} catch (error) {
				failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
				continue;
			}
			// A project definition wins over a global one of the same name, as a
			// whole file and not field by field (§6).
			byName.set(definition.name, definition);
		}
	}

	// `enabled: false` is how a project switches a global agent off, so the drop
	// happens after the merge (§6).
	for (const [name, definition] of [...byName]) {
		if (!definition.enabled) byName.delete(name);
	}

	return { byName, failures };
}

function yamlFilesIn(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const entry of entries.sort()) {
		if (!/\.(ya?ml)$/i.test(entry)) continue;
		const path = join(dir, entry);
		try {
			// statSync follows symlinks, so a definition linked in from a dotfiles
			// repository is read like a file (§6).
			if (statSync(path).isFile()) out.push(path);
		} catch {
			// A dangling link is not a definition.
		}
	}
	return out;
}

export function parseDefinition(
	source: string,
	path: string,
	scope: "user" | "project",
): AgentDefinition {
	let raw: unknown;
	try {
		raw = parseYaml(source);
	} catch (error) {
		throw new Error(`YAML does not parse: ${error instanceof Error ? error.message : error}`);
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("the file does not hold a YAML mapping");
	}
	const doc = raw as Record<string, unknown>;

	for (const key of Object.keys(doc)) {
		if (KNOWN_FIELDS.has(key)) continue;
		const correction = PROMPT_FIELD_CORRECTIONS[key.toLowerCase()];
		if (correction) {
			throw new Error(`\`${key}\` is not a field of an agent definition; use \`${correction}\``);
		}
	}

	const name = typeof doc.name === "string" ? doc.name.trim() : "";
	if (!NAME_PATTERN.test(name)) {
		throw new Error(
			"`name` must be a tool-safe identifier: letters, digits, `-` and `_`, starting with a letter or a digit",
		);
	}
	const label = typeof doc.label === "string" ? doc.label.trim() : "";
	if (label.length === 0) throw new Error("`label` is required");

	return {
		name,
		label,
		enabled: doc.enabled === undefined ? true : Boolean(doc.enabled),
		promptSnippet: str(doc.promptSnippet),
		promptGuidelines: strList(doc.promptGuidelines),
		parameters: parseParameters(doc.parameters),
		taskTemplate: str(doc.taskTemplate),
		tools: strList(doc.tools),
		model: str(doc.model),
		extensions: strList(doc.extensions),
		identity: str(doc.identity),
		appendSystemPrompt: str(doc.appendSystemPrompt),
		includeParentAppendSystemPrompt:
			doc.includeParentAppendSystemPrompt === undefined
				? true
				: Boolean(doc.includeParentAppendSystemPrompt),
		piDocs: doc.piDocs === undefined ? false : Boolean(doc.piDocs),
		fork: Boolean(doc.fork),
		background: Boolean(doc.background),
		thinking: parseThinking(doc.thinking),
		subagents: parseSubagents(doc.subagents),
		// Floored whatever the file says (§6).
		silenceTimeoutMs: optionalInt(doc.silenceTimeoutMs, 10_000),
		timeoutMs: optionalInt(doc.timeoutMs, 0) ?? 0,
		path,
		scope,
	};
}

function parseParameters(value: unknown): AgentParameter[] {
	if (!Array.isArray(value)) return [];
	const out: AgentParameter[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const name = typeof record.name === "string" ? record.name.trim() : "";
		if (name.length === 0) throw new Error("every entry of `parameters` needs a `name`");
		out.push({
			name,
			description: str(record.description) ?? "",
			required: record.required === undefined ? true : Boolean(record.required),
		});
	}
	return out;
}

/**
 * §6. `subagents: none` is the literal way to say an agent may spawn nothing;
 * an absent field means it may spawn all of them. An empty list is not used for
 * this, because `tools: []` already means unrestricted.
 */
function parseSubagents(value: unknown): string[] | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") {
		return value.trim().toLowerCase() === "none" ? [] : [value.trim()];
	}
	if (Array.isArray(value)) {
		const names = value.filter((entry): entry is string => typeof entry === "string");
		if (names.length === 1 && names[0]?.trim().toLowerCase() === "none") return [];
		return names.map((entry) => entry.trim()).filter((entry) => entry.length > 0);
	}
	return null;
}

function parseThinking(value: unknown): ThinkingLevel | null {
	if (typeof value !== "string") return null;
	const level = value.trim().toLowerCase() as ThinkingLevel;
	return THINKING_LEVELS.includes(level) ? level : null;
}

function str(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

function strList(value: unknown): string[] {
	if (typeof value === "string") return value.trim() ? [value.trim()] : [];
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function optionalInt(value: unknown, floor: number): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	return Math.max(floor, Math.trunc(value));
}

/** The general preset exists even when neither agents directory has definitions. */
export function builtinGeneral(): AgentDefinition {
	return parseDefinition(
		[
			"name: general",
			"label: General",
			"promptSnippet: Carry out a complete, self-contained task.",
			"identity: You are a general-purpose subagent. Complete the goal, verify your work, and report what changed and anything left open.",
		].join("\n"),
		"<built-in general>",
		"user",
	);
}

/** Legacy declarations remain readable for old child transcripts, but cannot lose inputs silently. */
export function delegationProblem(definition: AgentDefinition): string | null {
	const legacy = definition.parameters.filter((parameter) => parameter.name !== "goal");
	const placeholders = [...(definition.taskTemplate ?? "").matchAll(/\{([A-Za-z0-9_]+)\}/g)]
		.map((match) => match[1])
		.filter((name) => name !== "goal");
	if (legacy.length === 0 && placeholders.length === 0) return null;
	const incompatible = [...new Set([...legacy.map((parameter) => parameter.name), ...placeholders])];
	return (
		`Agent type \`${definition.name}\` in ${definition.path} needs migration for delegate: ` +
		`only \`goal\` is accepted, but its parameters or taskTemplate use ${incompatible.join(", ")}. ` +
		"Move those instructions into identity or appendSystemPrompt, remove the old parameters, and " +
		"rewrite taskTemplate to use {goal}. Its existing child transcripts can still be resumed."
	);
}

/** New delegation uses one goal. A static template is retained as instructions before it. */
export function renderGoal(definition: AgentDefinition, goal: string): string {
	const problem = delegationProblem(definition);
	if (problem) throw new Error(problem);
	const template = definition.taskTemplate;
	if (!template) return goal;
	if (template.includes("{goal}")) return template.replaceAll("{goal}", () => goal);
	return `${template}\n\n${goal}`;
}

/**
 * Legacy renderer for calls recorded before delegate. Each `{param}` is replaced by
 * its value, a supplied parameter with no placeholder is appended as
 * `Label: value`, and a line holding the placeholder of an omitted parameter is
 * dropped.
 */
export function renderTask(definition: AgentDefinition, args: Record<string, unknown>): string {
	const template = definition.taskTemplate ?? "";
	const supplied = new Map<string, string>();
	for (const parameter of definition.parameters) {
		const value = args[parameter.name];
		if (value === undefined || value === null || value === "") continue;
		supplied.set(parameter.name, String(value));
	}

	const used = new Set<string>();
	const lines = template.split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		const placeholders = [...line.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]);
		const omitted = placeholders.find(
			(placeholder) =>
				placeholder !== undefined &&
				definition.parameters.some((parameter) => parameter.name === placeholder) &&
				!supplied.has(placeholder),
		);
		if (omitted !== undefined) continue;
		kept.push(
			line.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key: string) => {
				const value = supplied.get(key);
				if (value === undefined) return match;
				used.add(key);
				return value;
			}),
		);
	}

	const extras: string[] = [];
	for (const parameter of definition.parameters) {
		const value = supplied.get(parameter.name);
		if (value === undefined || used.has(parameter.name)) continue;
		extras.push(`${parameter.name}: ${value}`);
	}

	const body = kept.join("\n").trim();
	return [body, ...extras].filter((part) => part.length > 0).join("\n\n");
}
