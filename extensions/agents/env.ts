/**
 * §8. The environment is the only channel that exists before a child's first
 * turn, so it carries who the child is, where it sits, and what is switched on.
 */

export const ENV = {
	agentId: "PI_TASKFORCE_AGENT_ID",
	parentId: "PI_TASKFORCE_PARENT_ID",
	agentType: "PI_TASKFORCE_AGENT_TYPE",
	depth: "PI_TASKFORCE_DEPTH",
	maxDepth: "PI_TASKFORCE_MAX_DEPTH",
	maxRunning: "PI_TASKFORCE_MAX_RUNNING",
	silenceTimeoutMs: "PI_TASKFORCE_SILENCE_TIMEOUT_MS",
	features: "PI_TASKFORCE_FEATURES",
	forked: "PI_TASKFORCE_FORKED",
	/** §13. Every spawn from the root down to this child used `fork: true`. */
	forkPath: "PI_TASKFORCE_FORK_PATH",
	/** §6. The agent types this child may spawn; absent means all of them. */
	spawnable: "PI_TASKFORCE_SPAWNABLE",
	/** §6. The root read this project's own agent definitions, so the child does too. */
	projectTrusted: "PI_TASKFORCE_PROJECT_TRUSTED",
	/** §8. A forked child's tool allowlist, enforced per call because its prompt must stay its parent's. */
	tools: "PI_TASKFORCE_TOOLS",
	/** The root's nested-activity socket, passed down to every descendant. */
	observe: "PI_TASKFORCE_OBSERVE",
} as const;

/** Every variable this extension owns starts with this. */
export const ENV_PREFIX = "PI_TASKFORCE_";

/**
 * §8. A child's environment is its parent's with every taskforce variable taken
 * out, so nothing the parent was told about itself leaks into the child: the
 * child is told only what its own launch sets.
 */
export function withoutTaskforceEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (!key.startsWith(ENV_PREFIX)) out[key] = value;
	}
	return out;
}

/** §8. The tool allowlist a forked child enforces on itself, or `null` for none. */
export function readToolAllowlist(source: NodeJS.ProcessEnv = process.env): string[] | null {
	return readStringList(source[ENV.tools]);
}

export interface FeatureSwitches {
	todos: boolean;
	subagents: boolean;
	ask: boolean;
}

export interface ChildIdentity {
	agentId: string;
	parentId: string;
	agentType: string;
	depth: number;
	maxDepth: number;
	maxRunning: number;
	silenceTimeoutMs: number;
	features: FeatureSwitches;
	forked: boolean;
	forkPath: boolean;
	spawnable: string[] | null;
	projectTrusted: boolean;
	tools: string[] | null;
}

export function buildChildEnv(identity: ChildIdentity): Record<string, string> {
	const env: Record<string, string> = {
		[ENV.agentId]: identity.agentId,
		[ENV.parentId]: identity.parentId,
		[ENV.agentType]: identity.agentType,
		[ENV.depth]: String(identity.depth),
		[ENV.maxDepth]: String(identity.maxDepth),
		[ENV.maxRunning]: String(identity.maxRunning),
		[ENV.silenceTimeoutMs]: String(identity.silenceTimeoutMs),
		[ENV.features]: JSON.stringify(identity.features),
	};
	if (identity.forked) env[ENV.forked] = "1";
	if (identity.forkPath) env[ENV.forkPath] = "1";
	if (identity.spawnable) env[ENV.spawnable] = JSON.stringify(identity.spawnable);
	if (identity.projectTrusted) env[ENV.projectTrusted] = "1";
	if (identity.tools) env[ENV.tools] = JSON.stringify(identity.tools);
	// The root owns this path and started listening before it could spawn.
	// Every descendant inherits it so a grandchild's activity also reaches it.
	const observe = process.env[ENV.observe];
	if (observe) env[ENV.observe] = observe;
	return env;
}

/** Reads the identity back in the child's own process. `null` in a root session. */
export function readChildIdentity(source: NodeJS.ProcessEnv = process.env): ChildIdentity | null {
	const agentId = source[ENV.agentId];
	const parentId = source[ENV.parentId];
	if (!agentId || !parentId) return null;
	return {
		agentId,
		parentId,
		agentType: source[ENV.agentType] ?? "subagent",
		depth: int(source[ENV.depth], 2),
		maxDepth: int(source[ENV.maxDepth], 3),
		maxRunning: int(source[ENV.maxRunning], 8),
		silenceTimeoutMs: int(source[ENV.silenceTimeoutMs], 600_000),
		features: readFeatures(source[ENV.features]),
		forked: source[ENV.forked] === "1",
		forkPath: source[ENV.forkPath] === "1",
		spawnable: readStringList(source[ENV.spawnable]),
		projectTrusted: source[ENV.projectTrusted] === "1",
		tools: readToolAllowlist(source),
	};
}

function readFeatures(raw: string | undefined): FeatureSwitches {
	const fallback: FeatureSwitches = { todos: true, subagents: true, ask: true };
	if (!raw) return fallback;
	try {
		const parsed = JSON.parse(raw) as Partial<FeatureSwitches>;
		return {
			todos: parsed.todos !== false,
			subagents: parsed.subagents !== false,
			ask: parsed.ask !== false,
		};
	} catch {
		return fallback;
	}
}

function readStringList(raw: string | undefined): string[] | null {
	if (!raw) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : null;
	} catch {
		return null;
	}
}

function int(raw: string | undefined, fallback: number): number {
	const parsed = Number.parseInt(raw ?? "", 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}
