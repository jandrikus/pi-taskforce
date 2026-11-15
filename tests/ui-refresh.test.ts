import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import type { CostMonitor } from "../extensions/costs/monitor.js";
import type { Cost, CostView } from "../extensions/costs/scan.js";
import type { SessionStatsSnapshot, StatsUsage } from "../extensions/stats/contract.js";
import type { StatsFeature } from "../extensions/stats/feature.js";
import { openCosts } from "../extensions/ui/costs.js";
import { openStats } from "../extensions/ui/stats.js";

const plain = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function amount(cost: number): StatsUsage {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost };
}

function cost(costValue: number): Cost {
	return {
		total: amount(costValue),
		own: amount(costValue),
		descendants: amount(0),
		models: [{ key: "deepseek/deepseek-flash", usage: amount(costValue) }],
		agents: [],
		incomplete: false,
	};
}

function view(costValue: number): CostView {
	return { cost: cost(costValue), scanning: false, error: null, stale: false };
}

function snapshot(costValue: number): SessionStatsSnapshot {
	return {
		at: 0,
		session: {
			id: "root",
			file: "/tmp/root.jsonl",
			cwd: "/work",
			status: "idle",
			model: { known: true, provider: "deepseek", id: "deepseek-flash" },
			context: { known: true, tokens: 100, contextWindow: 1_000, percent: 10, stale: false, source: "root" },
			sessionAgeMs: 1_000,
			lastActivityAt: 2_000,
		},
		costs: {
			available: true,
			total: amount(costValue),
			own: amount(costValue),
			descendants: amount(0),
			models: [{ key: "deepseek/deepseek-flash", usage: amount(costValue) }],
			incomplete: false,
			scanning: false,
			error: null,
			stale: false,
		},
		agents: [],
		todos: [],
		problems: [],
	};
}

interface CustomCapture {
	component: {
		render(width: number): string[];
		handleInput(data: string): void;
	};
}

function fakeContext(): { ctx: ExtensionContext; capture: CustomCapture } {
	const capture: Partial<CustomCapture> = {};
	const tui = {
		terminal: { rows: 40, columns: 100 },
		requestRender: vi.fn(),
	};
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: {
			custom: (factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: null) => void) => CustomCapture["component"]) =>
				new Promise<null>((resolve) => {
					capture.component = factory(tui, plain, {}, (value) => resolve(value));
				}),
		},
	} as unknown as ExtensionContext;
	return { ctx, capture: capture as CustomCapture };
}

describe("open views refresh their cached scroller", () => {
	it("/cost invalidates the cached lines when the monitor changes", async () => {
		let current = view(0.1);
		const listeners = new Set<() => void>();
		const monitor = {
			refresh: vi.fn(),
			view: () => current,
			subscribe: (listener: () => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		} as unknown as CostMonitor;
		const { ctx, capture } = fakeContext();
		const opening = openCosts(monitor, ctx);
		expect(capture.component).toBeDefined();
		const before = capture.component.render(80).join("\n");
		expect(before).toContain("$0.100");

		current = view(0.9);
		for (const listener of listeners) listener();
		const after = capture.component.render(80).join("\n");
		expect(after).toContain("$0.900");
		expect(after).not.toBe(before);

		capture.component.handleInput("\x1b");
		await opening;
	});

	it("/stats invalidates the cached lines when its snapshot changes", async () => {
		let current = snapshot(0.1);
		const costListeners = new Set<() => void>();
		const stateListeners = new Set<() => void>();
		const stats = {
			subscribeCosts: (listener: () => void) => {
				costListeners.add(listener);
				return () => costListeners.delete(listener);
			},
			subscribe: (listener: () => void) => {
				stateListeners.add(listener);
				return () => stateListeners.delete(listener);
			},
			snapshot: () => current,
		} as unknown as StatsFeature;
		const { ctx, capture } = fakeContext();
		const opening = openStats(stats, ctx);
		expect(capture.component).toBeDefined();
		const before = capture.component.render(80).join("\n");
		expect(before).toContain("$0.100");

		current = snapshot(0.9);
		for (const listener of costListeners) listener();
		const afterCost = capture.component.render(80).join("\n");
		expect(afterCost).toContain("$0.900");
		expect(afterCost).not.toBe(before);

		current = snapshot(0.5);
		for (const listener of stateListeners) listener();
		expect(capture.component.render(80).join("\n")).toContain("$0.500");

		capture.component.handleInput("\x1b");
		await opening;
	});
});
