import { describe, expect, it, vi } from "vitest";

import { costStatusText } from "../extensions/costs/format.js";
import { CostMonitor } from "../extensions/costs/monitor.js";
import type { Cost } from "../extensions/costs/scan.js";

function sample(cost: number): Cost {
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost };
	return {
		total: usage,
		own: usage,
		descendants: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		models: [],
		agents: [],
		incomplete: false,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((ok, fail) => {
		resolve = ok;
		reject = fail;
	});
	return { promise, resolve, reject };
}

describe("cost monitor", () => {
	it("shows a pending read as scanning, never as a complete zero", async () => {
		const pending = deferred<Cost>();
		const monitor = new CostMonitor({ read: () => pending.promise });
		monitor.bind("/root.jsonl");
		expect(monitor.view()).toMatchObject({ cost: null, scanning: true, error: null });
		expect(costStatusText(monitor.view())).toBe("Total incl. agents: scanning…");
		expect(costStatusText(monitor.view())).not.toContain("$0.000");

		pending.resolve(sample(0.25));
		await monitor.refreshNow();
		expect(monitor.view().cost?.total.cost).toBeCloseTo(0.25);
		expect(costStatusText(monitor.view())).toBe("Total incl. agents: $0.250");
		monitor.dispose();
	});

	it("keeps the last good snapshot on failure and marks it stale", async () => {
		let call = 0;
		const monitor = new CostMonitor({
			read: async () => {
				call++;
				if (call === 1) return sample(0.4);
				throw new Error("disk went away");
			},
		});
		monitor.bind("/root.jsonl");
		await monitor.refreshNow();
		monitor.refresh();
		await monitor.refreshNow();
		const view = monitor.view();
		expect(view.cost?.total.cost).toBeCloseTo(0.4);
		expect(view.error).toMatch(/disk went away/);
		expect(view.stale).toBe(true);
		expect(costStatusText(view)).toContain("(stale)");
		monitor.dispose();
	});

	it("coalesces refresh requests made while a read is running", async () => {
		const first = deferred<Cost>();
		const second = deferred<Cost>();
		let reads = 0;
		const monitor = new CostMonitor({
			read: async () => {
				reads++;
				return reads === 1 ? first.promise : second.promise;
			},
		});
		monitor.bind("/root.jsonl");
		monitor.refresh();
		monitor.refresh();
		expect(reads).toBe(1);
		first.resolve(sample(0.1));
		await monitor.refreshNow();
		expect(reads).toBe(2);
		// The queued scan started, but waiting for it is a separate request.
		expect(monitor.view().cost?.total.cost).toBeCloseTo(0.1);
		second.resolve(sample(0.2));
		await monitor.refreshNow();
		expect(monitor.view().cost?.total.cost).toBeCloseTo(0.2);
		monitor.dispose();
	});

	it("bounds refreshNow when updates keep queuing scans", async () => {
		const gates: Array<() => void> = [];
		const monitor = new CostMonitor({
			read: () =>
				new Promise<Cost>((resolve) => {
					gates.push(() => resolve(sample(0.1)));
				}),
		});
		monitor.bind("/root.jsonl");
		expect(gates).toHaveLength(1);
		for (let i = 0; i < 25; i++) monitor.refresh();

		const started = Date.now();
		await monitor.refreshNow(40);
		expect(Date.now() - started).toBeLessThan(500);
		expect(gates).toHaveLength(1);

		gates[0]!();
		await Promise.resolve();
		monitor.dispose();
	});

	it("shares one bounded wait between concurrent callers", async () => {
		const gate = deferred<Cost>();
		const monitor = new CostMonitor({ read: () => gate.promise });
		monitor.bind("/root.jsonl");

		await Promise.all([monitor.refreshNow(30), monitor.refreshNow(30)]);
		const started = Date.now();
		await monitor.refreshNow(30);
		expect(Date.now() - started).toBeLessThan(500);
		gate.resolve(sample(0.1));
		monitor.dispose();
	});

	it("does not leave refreshNow waiting after disposal or rebind", async () => {
		const old = deferred<Cost>();
		const monitor = new CostMonitor({ read: () => old.promise });
		monitor.bind("/old.jsonl");
		const waiting = monitor.refreshNow(30);
		monitor.bind("/new.jsonl");
		await waiting;
		expect(monitor.view().cost).toBeNull();
		monitor.dispose();
	});

	it("discards a read that belonged to the replaced session", async () => {
		const old = deferred<Cost>();
		const current = deferred<Cost>();
		const monitor = new CostMonitor({
			read: (path) => (path === "/old.jsonl" ? old.promise : current.promise),
		});
		monitor.bind("/old.jsonl");
		monitor.bind("/new.jsonl");
		current.resolve(sample(0.7));
		await monitor.refreshNow();
		old.resolve(sample(0.1));
		await Promise.resolve();
		expect(monitor.view().cost?.total.cost).toBeCloseTo(0.7);
		monitor.dispose();
	});

	it("polls only while descendants are live and clears its timer", async () => {
		vi.useFakeTimers();
		let live = false;
		let reads = 0;
		const monitor = new CostMonitor({
			read: async () => {
				reads++;
				return sample(0.1);
			},
			getLive: () => live,
			pollMs: 1_000,
		});
		monitor.bind("/root.jsonl");
		await vi.advanceTimersByTimeAsync(0);
		expect(reads).toBe(1);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(reads).toBe(1);
		live = true;
		await vi.advanceTimersByTimeAsync(1_000);
		expect(reads).toBe(2);
		monitor.dispose();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(reads).toBe(2);
		vi.useRealTimers();
	});

	it("notifies subscribers for a panel redraw and stops after disposal", async () => {
		const seen = vi.fn();
		const monitor = new CostMonitor({ read: async () => sample(0.1) });
		const unsubscribe = monitor.subscribe(seen);
		monitor.bind("/root.jsonl");
		expect(seen).toHaveBeenCalled();
		await monitor.refreshNow();
		const before = seen.mock.calls.length;
		monitor.dispose();
		expect(seen.mock.calls.length).toBeGreaterThan(before);
		unsubscribe();
	});
});
