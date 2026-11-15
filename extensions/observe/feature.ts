/**
 * The read-only agent observation bridge: an on-demand snapshot of this
 * process's direct children, plus live activity events for them.
 *
 * It never writes to a transcript, never touches a run, and answers only for
 * the session this context currently shows. A request that names another
 * session is dropped, so a rebound context cannot be read through an old id.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { ChildActivity } from "../agents/child.js";
import { ENV } from "../agents/env.js";
import type { Taskforce } from "../runtime.js";
import { ObserveChannel, ObserveClient, observeSocketPath } from "./channel.js";
import {
	type AgentsEvent,
	AGENTS_EVENT_CHANNEL,
	AGENTS_REQUEST_CHANNEL,
	AGENTS_RESPONSE_CHANNEL,
	AGENTS_VERSION,
	type AgentsRequest,
	type AgentsResponse,
	type AgentsSnapshot,
	type ObservedAgent,
	type ObservedAgentStatus,
} from "./contract.js";

export interface ObserveFeatureOptions {
	tf: Taskforce;
	now?: () => number;
	/** Test seam: a fixed socket path for a nested channel. */
	socketPath?: string;
}

export class ObserveFeature {
	private ctx: ExtensionContext | null = null;
	private sessionId: string | null = null;
	private pi: ExtensionAPI | null = null;
	private unsubscribe: (() => void) | null = null;
	private readonly now: () => number;
	private channel: ObserveChannel | null = null;
	private channelPath: string | null = null;
	private client: ObserveClient | null = null;
	private readonly root: boolean;

	constructor(private readonly options: ObserveFeatureOptions) {
		this.now = options.now ?? Date.now;
		// Runtime always says; a test double that omits it is a root.
		this.root = options.tf.isRoot !== false;
	}

	/** Called at factory time, before any session can answer a request. */
	start(pi: ExtensionAPI): void {
		if (this.pi) return;
		this.pi = pi;
		if (!this.root) {
			// A child process has no reader; it only carries its own children's
			// activity to the root over the inherited channel.
			const path = this.options.socketPath ?? process.env[ENV.observe];
			if (path) this.client = new ObserveClient(path);
			return;
		}
		try {
			this.unsubscribe = pi.events.on(AGENTS_REQUEST_CHANNEL, (data) => this.answer(pi, data));
		} catch {
			// An older pi without an event bus has no reader to answer.
			this.unsubscribe = null;
		}
		const path = this.options.socketPath ?? observeSocketPath();
		if (!path) return;
		// Children inherit this path through their launch environment. A child
		// strips every taskforce variable first, so this is the only one it gets.
		process.env[ENV.observe] = path;
		const channel = new ObserveChannel(path, this.options.socketPath === undefined);
		channel.listen((payload) => this.forwarded(payload));
		this.channel = channel;
		this.channelPath = path;
	}

	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.sessionId = safeSessionId(ctx);
	}

	dispose(): void {
		try {
			this.unsubscribe?.();
		} catch {
			// Already gone.
		}
		this.unsubscribe = null;
		this.channel?.close();
		this.channel = null;
		this.client?.close();
		this.client = null;
		if (this.root && this.channelPath && process.env[ENV.observe] === this.channelPath) {
			delete process.env[ENV.observe];
		}
		this.channelPath = null;
		this.ctx = null;
		this.sessionId = null;
	}

	/** A live activity from one child of this process. Read-only by construction. */
	activity(agentId: string, event: ChildActivity): void {
		const pi = this.pi;
		if (!pi) return;
		if (!this.root) {
			if (!this.ctx) return;
			this.client?.send({ version: AGENTS_VERSION, agentId, at: this.now(), event });
			return;
		}
		if (!this.sessionId || !this.current()) return;
		publish(pi, {
			version: AGENTS_VERSION,
			sessionId: this.sessionId,
			agentId,
			at: this.now(),
			event,
		});
	}

	/** One descendant activity that arrived over the channel. */
	private forwarded(data: unknown): void {
		if (!this.root || !this.pi || !this.sessionId || !this.current()) return;
		const payload = readForwarded(data);
		if (!payload) return;
		publish(this.pi, {
			version: AGENTS_VERSION,
			sessionId: this.sessionId,
			agentId: payload.agentId,
			at: payload.at,
			event: payload.event as ChildActivity,
		});
	}

	private answer(pi: ExtensionAPI, data: unknown): void {
		const request = readRequest(data);
		if (!request) return;
		if (!this.ctx || !this.sessionId || this.sessionId !== request.sessionId) return;
		if (!this.current()) return;
		let snapshot: AgentsSnapshot;
		try {
			snapshot = this.snapshot(request.sessionId);
		} catch {
			return;
		}
		// The session may have been replaced while the snapshot was built.
		if (!this.current()) return;
		const response: AgentsResponse = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			version: AGENTS_VERSION,
			snapshot,
		};
		try {
			pi.events.emit(AGENTS_RESPONSE_CHANNEL, response);
		} catch {
			// A listener's failure is not the session's.
		}
	}

	private current(): boolean {
		const ctx = this.ctx;
		if (!ctx || !this.sessionId) return false;
		const id = safeSessionId(ctx);
		if (!id || id !== this.sessionId) {
			// This context now shows another session; stop claiming its children.
			this.ctx = null;
			this.sessionId = null;
			return false;
		}
		return true;
	}

	private snapshot(sessionId: string): AgentsSnapshot {
		const tf = this.options.tf;
		const agents: ObservedAgent[] = [];
		for (const record of tf.children.all()) {
			const run = tf.supervisor?.runFor(record.uuid);
			let status: ObservedAgentStatus = "unknown";
			let activity = "";
			let waiting = false;
			let runElapsedMs: number | null = null;
			let recentTools: string[] = [];
			if (run) {
				status = run.isRunning ? run.status : "idle";
				activity = run.isRunning ? run.activity : "idle";
				waiting = run.hasOpenQuestion;
				runElapsedMs = run.durationMs;
				recentTools = [...run.recentToolCalls];
			}
			agents.push({
				uuid: record.uuid,
				parentUuid: record.parentUuid,
				depth: record.depth,
				type: record.type,
				status,
				storedFailure: record.failed,
				waiting,
				activity,
				runElapsedMs,
				recentTools,
				sessionFile: record.sessionFile,
			});
		}
		return { at: this.now(), sessionId, agents };
	}
}

function publish(pi: ExtensionAPI, event: AgentsEvent): void {
	try {
		pi.events.emit(AGENTS_EVENT_CHANNEL, event);
	} catch {
		// A closed session must not be kept alive by a failed notification.
	}
}

function safeSessionId(ctx: ExtensionContext): string | null {
	try {
		return ctx.sessionManager.getSessionId() ?? null;
	} catch {
		return null;
	}
}

const FORWARDED_TYPES = new Set([
	"status",
	"message_start",
	"message_end",
	"delta",
	"tool_start",
	"tool_update",
	"tool_end",
]);

function readForwarded(data: unknown): { agentId: string; at: number; event: Record<string, unknown> } | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	if (raw.version !== AGENTS_VERSION) return null;
	if (typeof raw.agentId !== "string" || raw.agentId.length === 0 || raw.agentId.length > 128) return null;
	if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return null;
	const event = raw.event;
	if (!event || typeof event !== "object" || Array.isArray(event)) return null;
	const kind = (event as Record<string, unknown>).kind;
	if (typeof kind !== "string" || !FORWARDED_TYPES.has(kind)) return null;
	return { agentId: raw.agentId, at: raw.at, event: event as Record<string, unknown> };
}

function readRequest(data: unknown): AgentsRequest | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	if (typeof raw.requestId !== "string" || raw.requestId.length === 0) return null;
	if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
	return { requestId: raw.requestId, sessionId: raw.sessionId };
}
