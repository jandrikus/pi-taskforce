/**
 * The stable, read-only agent observation contract shared with Pilot.
 *
 * This module is the contract: callers use these types and the channel names,
 * not the internal supervisor. Nothing here is persisted, and nothing here can
 * start, stop, steer or answer an agent. The snapshot describes the direct
 * children of this process; descendants recorded in a child's own transcript
 * are discovered by the reader, not by this process.
 */

export const AGENTS_VERSION = 1 as const;
export const AGENTS_REQUEST_CHANNEL = "taskforce:agents:request";
export const AGENTS_RESPONSE_CHANNEL = "taskforce:agents:response";
export const AGENTS_EVENT_CHANNEL = "taskforce:agents:event";

/**
 * Live status only from a run in this process. A record without a run here is
 * `unknown`: this process cannot claim what another process is doing.
 */
export type ObservedAgentStatus = "running" | "compacting" | "idle" | "unknown";

export interface ObservedAgent {
	uuid: string;
	parentUuid: string | null;
	depth: number;
	type: string | null;
	status: ObservedAgentStatus;
	/** Recorded outcome of the last run, independent of the live status. */
	storedFailure: boolean;
	/** The child has an ask open and waits for an answer. */
	waiting: boolean;
	/** What the child is doing now; empty without a run in this process. */
	activity: string;
	/** Live run duration, including waits. Null without a run here. */
	runElapsedMs: number | null;
	/** The last few tool names, newest last. */
	recentTools: string[];
	/** The transcript the child reported, or null when none was recorded. */
	sessionFile: string | null;
}

export interface AgentsSnapshot {
	at: number;
	sessionId: string;
	agents: ObservedAgent[];
}

export interface AgentsRequest {
	requestId: string;
	sessionId: string;
}

export interface AgentsResponse {
	requestId: string;
	sessionId: string;
	version: typeof AGENTS_VERSION;
	snapshot: AgentsSnapshot;
}

/**
 * One live activity of one child. Text is delta-only, so a reader never needs
 * the whole message again; the durable entry arrives through the transcript.
 */
export type ObservedAgentEvent =
	| { kind: "status"; status: ObservedAgentStatus; activity: string; waiting: boolean; runElapsedMs: number | null }
	| { kind: "message_start" }
	| { kind: "message_end" }
	| { kind: "delta"; index: number; channel: "text" | "thinking"; delta: string }
	| { kind: "tool_start"; toolCallId: string; name: string; args: string }
	| { kind: "tool_update"; toolCallId: string; output: string }
	| { kind: "tool_end"; toolCallId: string; isError: boolean };

export interface AgentsEvent {
	version: typeof AGENTS_VERSION;
	sessionId: string;
	agentId: string;
	at: number;
	event: ObservedAgentEvent;
}
