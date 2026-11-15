/**
 * §5. What the extension reads out of a TODO list: a title, the item counts and
 * the first unticked item. Pure, so it is testable without a file system.
 */

export interface TodoItem {
	text: string;
	done: boolean;
}

export interface TodoSummary {
	title: string;
	total: number;
	done: number;
	/** The first unticked item, or `null` when every item is ticked. */
	next: string | null;
	/** Every checklist item in file order. */
	items: TodoItem[];
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\[( |x|X)\]\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#\s+(.+?)\s*#*\s*$/;

export function parseTodo(text: string, fallbackTitle: string): TodoSummary {
	let title: string | null = null;
	let total = 0;
	let done = 0;
	let next: string | null = null;
	const items: TodoItem[] = [];
	let fence: string | null = null;

	for (const line of text.split(/\r?\n/)) {
		const fenceMatch = FENCE.exec(line);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			if (fence === null) fence = marker;
			else if (fence === marker) fence = null;
			continue;
		}
		if (fence !== null) continue;

		if (title === null) {
			const heading = HEADING.exec(line);
			if (heading?.[1]) {
				title = heading[1];
				continue;
			}
		}

		const item = ITEM.exec(line);
		if (!item) continue;
		const text = (item[2] ?? "").trim();
		const completed = item[1] !== " ";
		total++;
		items.push({ text, done: completed });
		if (!completed) {
			if (next === null) next = text;
		} else {
			done++;
		}
	}

	return { title: title ?? fallbackTitle, total, done, next, items };
}

export function isOpen(summary: TodoSummary): boolean {
	return summary.next !== null;
}
