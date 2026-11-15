/**
 * §5. The TODO widget above the input, and the `/todos` printout. Both only
 * read what the watcher found; neither sends the agent anything.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { isOpen } from "../todos/parse.js";
import type { TodoFile, TodoWatcher } from "../todos/watcher.js";

export const TODO_WIDGET_KEY = "pi-taskforce-todos";
const SHOWN = 3;

export class TodoWidget {
	private lastDrawn: string | null = null;

	constructor(
		private readonly watcher: TodoWatcher,
		private visible: boolean,
	) {}

	toggle(ctx: ExtensionContext): void {
		this.visible = !this.visible;
		this.refresh(ctx);
	}

	refresh(ctx: ExtensionContext | null): void {
		if (!ctx?.hasUI) return;
		const open = this.visible ? this.watcher.files.filter(isOpen) : [];
		const lines = open.length > 0 ? widgetLines(open) : null;
		const drawn = lines ? lines.join("\n") : null;
		if (drawn === this.lastDrawn) return;
		this.lastDrawn = drawn;
		if (!lines) {
			ctx.ui.setWidget(TODO_WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		ctx.ui.setWidget(TODO_WIDGET_KEY, [
			theme.fg("dim", "── todos ──"),
			...lines.map((line, index) =>
				index < Math.min(open.length, SHOWN) ? theme.fg("muted", line) : theme.fg("dim", line),
			),
		]);
	}
}

/** One line per open list, most recently changed first, then a count of the rest. */
export function widgetLines(open: readonly TodoFile[]): string[] {
	const lines = open.slice(0, SHOWN).map((file) => `${file.title} ${file.done}/${file.total} · ${file.next ?? ""}`);
	const rest = open.length - SHOWN;
	if (rest > 0) lines.push(`+${rest} more open`);
	return lines;
}

/** `/todos`: every list in the directory, open ones first. */
export function listingText(dir: string, files: readonly TodoFile[]): string {
	if (files.length === 0) return `No TODO lists yet in ${dir}`;
	const open = files.filter(isOpen);
	const finished = files.filter((file) => !isOpen(file));
	const lines = [`TODO lists in ${dir}`];
	for (const file of open) {
		lines.push(`  [ ] ${file.title}  ${file.done}/${file.total}  next: ${file.next}`);
		lines.push(`      ${file.name}`);
	}
	for (const file of finished) {
		lines.push(`  [x] ${file.title}  ${file.done}/${file.total}`);
		lines.push(`      ${file.name}`);
	}
	return lines.join("\n");
}
