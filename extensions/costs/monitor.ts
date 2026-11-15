/**
 * The cached cost view. Transcripts are read off the render path, scans are
 * coalesced, and a failed scan keeps the last good answer marked stale rather
 * than showing a complete zero.
 */

import type { Cost, CostView } from "./scan.js";
import { readCost } from "./scan.js";

/** Longest a caller waits for a fresh read before it gets the cached view. */
export const REFRESH_NOW_TIMEOUT_MS = 1_500;

export interface CostMonitorOptions {
	/** Reads one root transcript and its descendants. Injectable for tests. */
	read?: (path: string) => Promise<Cost>;
	/** Whether descendants may still be writing, so a background refresh is useful. */
	getLive?: () => boolean;
	/** Bounded refresh interval while `getLive` is true. */
	pollMs?: number;
	/** Called after every state change, including the initial pending state. */
	onState?: () => void;
}

export class CostMonitor {
	private readonly read: (path: string) => Promise<Cost>;
	private readonly getLive: () => boolean;
	private readonly pollMs: number;
	private readonly onState: (() => void) | undefined;

	private rootFile: string | null = null;
	private snapshot: Cost | null = null;
	private scanning = false;
	private error: string | null = null;
	private stale = false;
	private generation = 0;
	private queued = false;
	private disposed = false;
	private inflight: Promise<void> | null = null;
	private timer: ReturnType<typeof setInterval> | null = null;
	private readonly listeners = new Set<() => void>();

	constructor(options: CostMonitorOptions = {}) {
		this.read = options.read ?? readCost;
		this.getLive = options.getLive ?? (() => false);
		this.pollMs = options.pollMs ?? 3_000;
		this.onState = options.onState;
	}

	view(): CostView {
		return { cost: this.snapshot, scanning: this.scanning, error: this.error, stale: this.stale };
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Points the monitor at a session, discarding anything read for the previous one. */
	bind(sessionFile: string | null): void {
		this.generation++;
		this.clearTimer();
		this.disposed = false;
		this.rootFile = sessionFile;
		this.snapshot = null;
		this.scanning = false;
		this.error = null;
		this.stale = false;
		this.queued = false;
		this.inflight = null;
		this.startTimer();
		if (sessionFile) this.refresh();
		else this.notify();
	}

	refresh(): void {
		if (this.disposed || !this.rootFile) return;
		if (this.scanning) {
			this.queued = true;
			return;
		}
		this.scanning = true;
		this.notify();

		const generation = this.generation;
		const rootFile = this.rootFile;
		const task = (async () => {
			try {
				const cost = await this.read(rootFile);
				if (generation !== this.generation || rootFile !== this.rootFile) return;
				this.snapshot = cost;
				this.error = null;
				this.stale = false;
			} catch (cause) {
				if (generation !== this.generation || rootFile !== this.rootFile) return;
				this.error = cause instanceof Error ? cause.message : String(cause);
				this.stale = true;
			} finally {
				if (generation !== this.generation || rootFile !== this.rootFile) return;
				this.scanning = false;
				this.inflight = null;
				this.notify();
				if (this.queued) {
					this.queued = false;
					this.refresh();
				}
			}
		})();
		this.inflight = task;
		void task;
	}

	/**
	 * Waits at most `timeoutMs` for the read that is current now. A scan queued
	 * after this call is not part of the wait: a continuous stream of updates
	 * must not keep a snapshot request pending indefinitely.
	 */
	async refreshNow(timeoutMs = REFRESH_NOW_TIMEOUT_MS): Promise<void> {
		if (!this.rootFile || this.disposed) return;
		if (!this.scanning && !this.inflight) this.refresh();
		const current = this.inflight;
		if (!current) return;
		await waitAtMost(current, timeoutMs);
	}

	dispose(): void {
		this.generation++;
		this.disposed = true;
		this.clearTimer();
		this.rootFile = null;
		this.snapshot = null;
		this.scanning = false;
		this.error = null;
		this.stale = false;
		this.queued = false;
		this.inflight = null;
		this.notify();
		this.listeners.clear();
	}

	private startTimer(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			if (!this.disposed && this.getLive()) this.refresh();
		}, this.pollMs);
		// A cached cost view must not hold the process open.
		this.timer.unref?.();
	}

	private clearTimer(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	private notify(): void {
		try {
			this.onState?.();
		} catch {
			// A status surface that has gone away is not a reason to stop a scan.
		}
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// One closed panel must not stop the others.
			}
		}
	}
}


function waitAtMost(promise: Promise<void>, timeoutMs: number): Promise<void> {
	if (timeoutMs <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		let done = false;
		const finish = () => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(finish, timeoutMs);
		timer.unref?.();
		void promise.then(finish, finish);
	});
}
