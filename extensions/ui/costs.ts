/**
 * `/cost`: the scrollable session cost page, on the same scroller as the
 * subagent panel. In a non-TUI mode the same lines go to a notification.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import { costLines } from "../costs/format.js";
import type { CostMonitor } from "../costs/monitor.js";
import { createScroller } from "./scroller.js";

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export async function openCosts(monitor: CostMonitor, ctx: ExtensionContext): Promise<void> {
	monitor.refresh();
	if (ctx.mode !== "tui") {
		await monitor.refreshNow();
		ctx.ui.notify(costLines(monitor.view(), plainTheme).join("\n"), "info");
		return;
	}

	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		let unsubscribe = () => {};
		const scroller = createScroller({
			title: "Session costs",
			theme,
			tui,
			body: () => costLines(monitor.view(), theme),
			help: () => "↑↓ scroll • Esc close",
			// The custom view shares the dock with the transcript, todo widget and
			// footer. Leave six rows for those so the hint and border stay visible.
			maxHeight: (terminalRows) => Math.max(1, terminalRows - 6),
			done: (value) => {
				unsubscribe();
				done(value);
			},
		});
		unsubscribe = monitor.subscribe(() => {
			scroller.invalidate();
			tui.requestRender();
		});
		return scroller;
	});
}
