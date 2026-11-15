import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { CostFeature } from "../extensions/costs/feature.js";
import { costLines, costStatusText } from "../extensions/costs/format.js";
import type { Cost } from "../extensions/costs/scan.js";
import {
	appendSession,
	assistant,
	childFile,
	childRecord,
	cleanup,
	ROOT_ID,
	usage,
	type Fixture,
	makeFixture,
	writeSession,
} from "./costs/fixture.js";

const plain = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function sample(incomplete = false): Cost {
	const amount = (cost: number) => ({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost });
	return {
		total: amount(0.6),
		own: amount(0.1),
		descendants: amount(0.5),
		models: [{ key: "deepseek/deepseek-flash", usage: amount(0.6) }],
		agents: [
			{
				uuid: ROOT_ID, parentUuid: null, type: null, depth: 1, forked: false, failed: false,
				status: "ok", note: "", own: amount(0.1), known: true, subtree: amount(0.6), subtreeKnown: !incomplete,
				models: [],
			},
			{
				uuid: "missing-child", parentUuid: ROOT_ID, type: "scout", depth: 2, forked: false, failed: false,
				status: "missing", note: "the recorded transcript is not on disk", own: amount(0), known: false,
				subtree: amount(0), subtreeKnown: false, models: [],
			},
		],
		incomplete,
	};
}

describe("cost view", () => {
	it("keeps the status label short and marks an incomplete known total", () => {
		const view = { cost: sample(true), scanning: false, error: null, stale: false };
		expect(costStatusText(view)).toBe("Total incl. agents: $0.600 (incomplete)");
	});

	it("lists own and descendant totals, models and every agent row", () => {
		const lines = costLines({ cost: sample(true), scanning: false, error: null, stale: false }, plain).join("\n");
		expect(lines).toContain("Total incl. agents   $0.600");
		expect(lines).toContain("this session");
		expect(lines).toContain("subagents (known)");
		expect(lines).toContain("By model");
		expect(lines).toContain("deepseek/deepseek-flash");
		expect(lines).toContain("Agents");
		expect(lines).toContain("missing-child");
		expect(lines).toContain("unknown");
		expect(lines).toContain("Incomplete");
		expect(lines).toContain("/session");
	});

	it("does not show a zero total before the first read", () => {
		const lines = costLines({ cost: null, scanning: true, error: null, stale: false }, plain).join("\n");
		expect(lines).toContain("Reading");
		expect(lines).not.toContain("$0.000");
	});
});

describe("cost feature on supported extension APIs", () => {
	it("registers /cost and its /costs alias, then reports through setStatus and notify", async () => {
		let fixture: Fixture | null = makeFixture();
		try {
			const child = childFile(fixture, "child");
			writeSession(child, "child-session", [assistant("ca", usage(1, 1, 0, 0, 0.25))]);
			appendSession(fixture.rootFile, [
				assistant("ra", usage(1, 1, 0, 0, 0.1)),
				childRecord("rc", { uuid: "child", parentUuid: ROOT_ID, sessionFile: child }),
			]);

			const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
			const pi = {
				registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) =>
					commands.set(name, command),
			} as unknown as ExtensionAPI;
			const statuses: Array<string | undefined> = [];
			const notices: string[] = [];
			const ctx = {
				mode: "rpc",
				hasUI: true,
				sessionManager: { getSessionFile: () => fixture!.rootFile },
				ui: {
					setStatus: (_key: string, text: string | undefined) => statuses.push(text),
					notify: (text: string) => notices.push(text),
				},
			} as unknown as ExtensionContext;

			const feature = new CostFeature({ getLive: () => false });
			feature.register(pi);
			expect(commands.get("cost")?.handler).toBe(commands.get("costs")?.handler);

			feature.bind(ctx);
			await feature.monitor.refreshNow();
			expect(statuses).toContain("Total incl. agents: scanning…");
			expect(statuses.at(-1)).toBe("Total incl. agents: $0.350");

			await commands.get("cost")!.handler("", ctx);
			expect(notices.at(-1)).toContain("Total incl. agents");
			expect(notices.at(-1)).toContain("$0.350");
			expect(notices.at(-1)).toContain("built-in /session");

			feature.dispose();
			expect(statuses.at(-1)).toBeUndefined();
		} finally {
			if (fixture) cleanup(fixture);
			fixture = null;
		}
	});
});
