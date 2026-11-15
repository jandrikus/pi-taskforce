/**
 * A read-only, scrollable page of lines, live while things are running.
 *
 * The subagent panel (§14) is this shape: a title, a body somebody else
 * produces, and a key map that only moves the view.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, type TUI, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export interface ScrollerOptions {
	title: string;
	theme: Theme;
	tui: TUI;
	/** Re-read on every render, so the page is live while agents work (§14). */
	body: () => string[];
	/** Extra keys, tried before scrolling. Return true when the key was handled. */
	onKey?: (data: string) => boolean;
	/** The help line under the body. */
	help?: () => string;
	/**
	 * Maximum total height in rows, given the terminal height. The custom
	 * editor shares the screen with the transcript and footer, so callers that
	 * draw a full page pass a value below the terminal height. Existing panels
	 * that leave it unset keep their old sizing.
	 */
	maxHeight?: (terminalRows: number) => number;
	done: (value: null) => void;
}

export interface Scroller {
	render(width: number): string[];
	invalidate(): void;
	handleInput(data: string): void;
	scrollTo(line: number): void;
}

export function createScroller(options: ScrollerOptions): Scroller {
	const { theme, tui, done } = options;
	let offset = 0;
	let cached: string[] | undefined;
	let lastPage = 20;

	const refresh = (): void => {
		cached = undefined;
		tui.requestRender();
	};

	return {
		scrollTo(line: number): void {
			offset = Math.max(0, line);
			refresh();
		},
		invalidate(): void {
			cached = undefined;
		},
		handleInput(data: string): void {
			if (options.onKey?.(data)) {
				refresh();
				return;
			}
			if (matchesKey(data, Key.escape) || data === "q") {
				done(null);
				return;
			}
			if (matchesKey(data, Key.up)) {
				offset = Math.max(0, offset - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				offset += 1;
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageUp)) {
				offset = Math.max(0, offset - lastPage);
				refresh();
				return;
			}
			if (matchesKey(data, Key.pageDown)) {
				offset += lastPage;
				refresh();
			}
		},
		render(width: number): string[] {
			if (cached) return cached;
			const renderWidth = Math.max(1, width);
			const wrapped: string[] = [];
			for (const line of options.body()) {
				if (line.length === 0) wrapped.push("");
				else wrapped.push(...wrapTextWithAnsi(line, renderWidth - 1).map((part) => ` ${part}`));
			}

			const budget = options.maxHeight?.(tui.terminal.rows);
			const rows =
				budget === undefined
					? Math.max(6, Math.min(wrapped.length, Math.max(6, tui.terminal.rows - 8)))
					: Math.max(1, Math.min(wrapped.length, Math.max(1, Math.floor(budget) - 8)));
			lastPage = rows;
			if (offset > Math.max(0, wrapped.length - rows)) {
				offset = Math.max(0, wrapped.length - rows);
			}

			const lines: string[] = [];
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			lines.push(` ${theme.fg("accent", theme.bold(options.title))}`);
			lines.push("");
			lines.push(...wrapped.slice(offset, offset + rows));
			if (wrapped.length > rows) {
				lines.push("");
				lines.push(
					` ${theme.fg("dim", `showing ${offset + 1}–${Math.min(wrapped.length, offset + rows)} of ${wrapped.length}`)}`,
				);
			}
			lines.push("");
			lines.push(` ${theme.fg("dim", options.help?.() ?? "↑↓ scroll • Esc close")}`);
			lines.push(theme.fg("accent", "─".repeat(renderWidth)));
			cached = lines;
			return lines;
		},
	};
}
