/**
 * The stable, read-only session snapshot shared with Pilot.
 *
 * This module is the contract: callers should import these types and the two
 * event-channel names, not the internal cost/supervisor modules. The snapshot
 * is built on demand and never persisted.
 */

export const STATS_VERSION = 1 as const;
export const STATS_REQUEST_CHANNEL = "taskforce:stats:request";
export const STATS_RESPONSE_CHANNEL = "taskforce:stats:response";

export interface StatsUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface StatsModelUsage {
	key: string;
	usage: StatsUsage;
}

/** Cost status is about the transcript read, never about live agent activity. */
export type StatsCostStatus = "ok" | "missing" | "error" | "outside" | "cycle" | "duplicate";

export interface StatsCostAgent {
	known: boolean;
	own: StatsUsage;
	subtree: StatsUsage;
	subtreeKnown: boolean;
	status: StatsCostStatus;
	note: string;
}

export interface StatsCosts {
	/** False while a first read is pending, or when no transcript could be read. */
	available: boolean;
	/** Null when unavailable; never a zero that could be mistaken for "no spend". */
	total: StatsUsage | null;
	own: StatsUsage | null;
	descendants: StatsUsage | null;
	models: StatsModelUsage[];
	incomplete: boolean;
	scanning: boolean;
	error: string | null;
	stale: boolean;
}

export interface StatsContext {
	known: boolean;
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	stale: boolean;
	source: "root" | "run" | "transcript" | "none";
	/** When a historical request-input measurement was recorded. */
	observedAt?: number | null;
	/** What the reading is: live context usage or a historical request input. */
	measurement?: "live" | "request-input" | "none";
	/** Historical provenance, including an invalidating boundary after the request. */
	provenance?: "live" | "assistant-usage" | "before-compaction" | "before-context-edit" | "none";
	/** Model associated with the recorded request, never a guessed window. */
	requestModel?: StatsRootModel | null;
	/** active only for root evidence from the actual live leaf. */
	branch?: "active" | "last-recorded" | null;
}

export interface StatsRootModel {
	known: boolean;
	provider: string | null;
	id: string | null;
}

/** Last assistant model seen on the relevant transcript branch. */
export interface StatsObservedModel {
	known: boolean;
	provider: string | null;
	id: string | null;
	observedAt: number | null;
	/** response-model is provider-reported; message is the recorded message model. */
	evidence: "response-model" | "message" | "none";
	/** active only when read from the actual live leaf. */
	branch?: "active" | "last-recorded";
}

export interface StatsSession {
	id: string;
	file: string | null;
	cwd: string;
	/** `ctx.isIdle()` for this session. */
	status: "running" | "idle";
	model: StatsRootModel;
	/** Historical fallback, separate from the current selected model. */
	observedModel?: StatsObservedModel | null;
	/**
	 * True when `activeBranch` was supplied, including a known empty branch.
	 * Consumers must not replace a missing active-branch observation with
	 * durable last-recorded history. False/absent means branch availability is
	 * unknown, so the durable fallback is allowed.
	 */
	activeBranchKnown?: boolean;
	context: StatsContext;
	/** Time since the session header timestamp; not execution time. */
	sessionAgeMs: number | null;
	/** Timestamp of the last transcript entry. Null when there are none. */
	lastActivityAt: number | null;
}

export interface StatsAgent {
	uuid: string;
	parentUuid: string | null;
	depth: number;
	type: string | null;
	/**
	 * Live status only from a supervised, running ChildRun. A child with no
	 * current run is `unknown`; its recorded failure is kept separately.
	 */
	status: "running" | "compacting" | "idle" | "unknown";
	statusEvidence: "live-run" | "none";
	/** Recorded outcome of the last run, independent of the live status. */
	storedFailure: boolean | null;
	/** Live ChildRun.durationMs, which includes waits. Null without a current run. */
	runElapsedMs: number | null;
	/** Configured `model` from the agent definition, never the observed model. */
	configuredModel: string | null;
	/** Last assistant model from the agent's transcript, if one exists. */
	observedModel?: StatsObservedModel | null;
	context: StatsContext;
	transcript: {
		available: boolean;
		note: string;
	};
	cost: StatsCostAgent | null;
}

export interface StatsTodoItem {
	text: string;
	done: boolean;
}

export interface StatsTodo {
	name: string;
	title: string;
	path: string;
	changedAt: number;
	total: number;
	done: number;
	remaining: number;
	items: StatsTodoItem[];
	/** TODO lists are session-owned; there is no per-agent ownership metadata. */
	owner: { kind: "session"; sessionId: string };
}

export interface SessionStatsSnapshot {
	at: number;
	session: StatsSession;
	costs: StatsCosts;
	agents: StatsAgent[];
	todos: StatsTodo[];
	problems: string[];
}

export interface StatsRequest {
	requestId: string;
	sessionId: string;
}

export interface StatsResponse {
	requestId: string;
	sessionId: string;
	version: typeof STATS_VERSION;
	snapshot: SessionStatsSnapshot;
}
