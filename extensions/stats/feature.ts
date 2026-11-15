/**
 * `/stats` and the read-only snapshot channel. The snapshot is built on demand
 * from live runtime state; it is never written to a transcript.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { CostFeature } from "../costs/feature.js";
import type { Taskforce } from "../runtime.js";
import type { TodoWatcher } from "../todos/watcher.js";
import { buildStatsSnapshot, type StatsInput } from "./build.js";
import {
	type SessionStatsSnapshot,
	STATS_REQUEST_CHANNEL,
	STATS_RESPONSE_CHANNEL,
	STATS_VERSION,
	type StatsRequest,
	type StatsResponse,
} from "./contract.js";

export interface StatsFeatureOptions {
	tf: Taskforce;
	costs: CostFeature;
	todos: TodoWatcher | null;
	/** Injectable for tests. */
	now?: () => number;
}

export class StatsFeature {
	private ctx: ExtensionContext | null = null;
	private sessionId: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	/** Read once per command/request, not on every redraw. */
	private startedAt: number | null = null;
	private lastActivityAt: number | null = null;

	constructor(private readonly options: StatsFeatureOptions) {
		this.now = options.now ?? Date.now;
	}

	register(pi: ExtensionAPI): void {
		pi.registerCommand("stats", {
			description: "Show session stats, including subagents and TODO lists",
			handler: async (_args, ctx) => {
				this.bind(ctx);
				this.refresh();
				const { openStats } = await import("../ui/stats.js");
				await openStats(this, ctx);
			},
		});
	}

	/** Called at factory time, before any session can answer a request. */
	start(pi: ExtensionAPI): void {
		if (this.unsubscribe) return;
		try {
			this.unsubscribe = pi.events.on(STATS_REQUEST_CHANNEL, (data) => {
				void this.answer(pi, data);
			});
		} catch {
			this.unsubscribe = null;
		}
	}

	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId() ?? null;
		this.readSessionTimes(ctx);
	}

	refresh(): void {
		if (this.ctx) this.readSessionTimes(this.ctx);
		this.options.costs.refresh();
		this.options.todos?.refresh();
		this.touch();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Redraw when the cost cache changes, without exposing the monitor. */
	subscribeCosts(listener: () => void): () => void {
		return this.options.costs.monitor.subscribe(listener);
	}

	/** Requests a redraw without making a scan synchronous. */
	touch(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// A closed panel is not a reason to fail a turn.
			}
		}
	}

	/** A synchronous view from the current cost cache and live runtime. */
	snapshot(): SessionStatsSnapshot {
		if (!this.ctx) throw new Error("the session has not started");
		return this.from(this.ctx);
	}

	/** Waits for the cost read, then returns the snapshot. */
	async snapshotNow(): Promise<SessionStatsSnapshot> {
		if (!this.ctx) throw new Error("the session has not started");
		await this.options.costs.monitor.refreshNow();
		this.options.todos?.refresh();
		if (!this.ctx) throw new Error("the session has ended");
		this.readSessionTimes(this.ctx);
		return this.from(this.ctx);
	}

	dispose(): void {
		try {
			this.unsubscribe?.();
		} catch {
			// Already gone.
		}
		this.unsubscribe = null;
		this.listeners.clear();
		this.ctx = null;
		this.sessionId = null;
		this.startedAt = null;
		this.lastActivityAt = null;
	}

	private from(ctx: ExtensionContext): SessionStatsSnapshot {
		return buildStatsSnapshot(this.input(ctx));
	}

	private readSessionTimes(ctx: ExtensionContext): void {
		try {
			const header = ctx.sessionManager.getHeader();
			const started = header ? Date.parse(header.timestamp) : Number.NaN;
			const last = ctx.sessionManager.getEntries().at(-1);
			const lastAt = last ? Date.parse(last.timestamp) : Number.NaN;
			this.startedAt = Number.isFinite(started) ? started : null;
			this.lastActivityAt = Number.isFinite(lastAt) ? lastAt : null;
		} catch {
			this.startedAt = null;
			this.lastActivityAt = null;
		}
	}

	private input(ctx: ExtensionContext): StatsInput {
		const manager = ctx.sessionManager;
		const now = this.now();
		let idle = true;
		let context: ReturnType<ExtensionContext["getContextUsage"]>;
		let activeBranch: readonly unknown[] | null = null;
		try {
			idle = ctx.isIdle();
			context = ctx.getContextUsage();
		} catch {
			// A replaced context is not answered; the caller checks the identity again.
			throw new Error("the session context is no longer current");
		}
		try {
			// This follows the real live leaf, including branch()/resetLeaf()
			// navigation that has not appended a new transcript entry yet.
			activeBranch = manager.getBranch();
		} catch {
			activeBranch = null;
		}
		return {
			session: {
				id: manager.getSessionId(),
				file: manager.getSessionFile() ?? null,
				cwd: ctx.cwd,
				idle,
				model: ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : null,
				context,
				activeBranch,
				sessionAgeMs: this.startedAt === null ? null : Math.max(0, now - this.startedAt),
				lastActivityAt: this.lastActivityAt,
			},
			costs: this.options.costs.monitor.view(),
			records: this.options.tf.children.all(),
			supervisor: this.options.tf.supervisor,
			definitions: this.options.tf.catalog.byName,
			todos: this.options.todos?.files ?? [],
		};
	}

	private async answer(pi: ExtensionAPI, data: unknown): Promise<void> {
		const request = readRequest(data);
		if (!request) return;
		const ctx = this.ctx;
		if (!ctx || !this.sessionId || this.sessionId !== request.sessionId) return;
		if (ctx.sessionManager.getSessionId() !== request.sessionId) return;

		await this.options.costs.monitor.refreshNow();
		this.options.todos?.refresh();
		if (this.ctx) this.readSessionTimes(this.ctx);

		// The session may have been replaced while the transcript was read.
		if (!this.ctx || !this.sessionId || this.sessionId !== request.sessionId) return;
		if (this.ctx.sessionManager.getSessionId() !== request.sessionId) return;

		let snapshot: SessionStatsSnapshot;
		try {
			snapshot = this.from(this.ctx);
		} catch {
			return;
		}
		const response: StatsResponse = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			version: STATS_VERSION,
			snapshot,
		};
		try {
			pi.events.emit(STATS_RESPONSE_CHANNEL, response);
		} catch {
			// A listener's failure is not the session's.
		}
	}
}

function readRequest(data: unknown): StatsRequest | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	if (typeof raw.requestId !== "string" || raw.requestId.length === 0) return null;
	if (typeof raw.sessionId !== "string" || raw.sessionId.length === 0) return null;
	return { requestId: raw.requestId, sessionId: raw.sessionId };
}
