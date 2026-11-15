/**
 * `/stats`: the read-only session dashboard on the existing scroller. In a
 * non-TUI mode the same lines go to a notification.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { statsLines } from "../stats/format.js";
import type { StatsFeature } from "../stats/feature.js";
import { createScroller } from "./scroller.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export async function openStats(stats: StatsFeature, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(statsLines(await stats.snapshotNow(), plainTheme).join("\n"), "info");
		return;
	}

	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		let unsubscribeRun = () => {};
		let unsubscribeStats = () => {};
		const scroller = createScroller({
			title: "Session stats",
			theme,
			tui,
			body: () => {
				try {
					return statsLines(stats.snapshot(), theme);
				} catch {
					return [theme.fg("warning", "Session stats are unavailable because the session changed or closed.")];
				}
			},
			help: () => "↑↓ scroll • Esc close",
			// The custom view shares the dock with the transcript, todo widget and
			// footer. Leave six rows for those so the hint and border stay visible.
			maxHeight: (terminalRows) => Math.max(1, terminalRows - 6),
			done: (value) => {
				unsubscribeRun();
				unsubscribeStats();
				done(value);
			},
		});
		const refresh = () => {
			scroller.invalidate();
			tui.requestRender();
		};
		unsubscribeRun = stats.subscribeCosts(refresh);
		unsubscribeStats = stats.subscribe(refresh);
		return scroller;
	});
}
