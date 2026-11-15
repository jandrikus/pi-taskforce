/**
 * §12. The terminal surface: one overlay carrying the whole ask.
 *
 * An option question is a list of rows. A text question is a text field that
 * takes keys as soon as it shows. Where a question offers a free-text answer,
 * typing on the list goes straight into that field, so an answer is never lost
 * to a mode the user did not know they had to enter first.
 *
 * Two rules keep the keys predictable. Enter always answers the question on
 * screen, and Space is the only toggle. Esc clears the field being typed in, and
 * otherwise needs a second press to cancel, because cancelling stops the agent's
 * work and one stray key should not do that.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	decodeKittyPrintable,
	Editor,
	type EditorTheme,
	Input,
	Key,
	type TUI,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

import type { AskEnvelope } from "./protocol.js";
import type { Answer, AskResult, Question } from "./schema.js";

/** Keys that arrive this soon after the overlay opens were meant for whatever was there before. */
export const INPUT_GRACE_MS = 350;
/** How long a first Esc waits for the second one. */
export const CANCEL_ARM_MS = 2000;

type Row =
	| { kind: "option"; value: string; label: string; description: string | null }
	| { kind: "extra"; value: string }
	| { kind: "other" }
	| { kind: "skip" };

interface QuestionState {
	cursor: number;
	/** Picked option values of a multiselect, in the order the options are listed. */
	checked: Set<string>;
	/** Answers typed into a multiselect's free-text row. */
	extras: string[];
	/** The free-text row of an option question. */
	other: Input;
	/** The field of a text question. */
	text: Editor | null;
	answer: Answer | null;
	note: string | null;
}

export interface OverlayOptions {
	envelope: AskEnvelope;
	theme: Theme;
	tui: TUI;
	/** Who the question came from, when it is not this agent's own (§13). */
	attribution: string | null;
	done: (result: AskResult) => void;
	/** How many more asks wait for the screen after this one. */
	queued?: () => number;
	/** Overrides INPUT_GRACE_MS, for tests. */
	graceMs?: number;
	now?: () => number;
}

export function createAskOverlay(options: OverlayOptions) {
	const { envelope, theme, tui, attribution, done } = options;
	const now = options.now ?? Date.now;
	const questions = envelope.ask.questions;
	const context = envelope.ask.context;
	const isMulti = questions.length > 1;
	/** The review tab exists only when there is more than one question (§12). */
	const reviewTab = questions.length;
	const openedAt = now();
	const graceMs = options.graceMs ?? INPUT_GRACE_MS;

	let tab = 0;
	let reviewCursor = questions.length;
	let noting = false;
	let cancelArmedAt: number | null = null;
	let finished = false;
	let focused = false;
	let cached: string[] | undefined;

	const editorTheme: EditorTheme = {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
	const noteEditor = new Editor(tui, editorTheme, { paddingX: 1 });

	const states = new Map<string, QuestionState>();
	for (const question of questions) {
		const rows = rowsFor(question, []);
		const start = question.default
			? Math.max(0, rows.findIndex((row) => row.kind === "option" && row.value === question.default))
			: 0;
		let text: Editor | null = null;
		if (question.type === "text") {
			text = new Editor(tui, editorTheme, { paddingX: 1 });
			if (question.default) text.setText(question.default);
			text.onSubmit = (value) => submitText(question, value);
		}
		states.set(question.id, {
			cursor: start,
			checked: new Set(question.type === "multiselect" && question.default ? [question.default] : []),
			extras: [],
			other: new Input({ prompt: "" }),
			text,
			answer: null,
			note: null,
		});
	}

	noteEditor.onSubmit = (value) => {
		const question = current();
		if (question) state(question).note = value.trim() || null;
		noting = false;
		refresh();
	};

	function state(question: Question): QuestionState {
		return states.get(question.id)!;
	}

	function current(): Question | undefined {
		return questions[tab];
	}

	function refresh(): void {
		cached = undefined;
		tui.requestRender();
	}

	function rowsFor(question: Question, extras: string[]): Row[] {
		const rows: Row[] = [];
		if (question.type === "text") return rows;
		for (const option of question.options) {
			rows.push({ kind: "option", value: option.value, label: option.label, description: option.description ?? null });
		}
		if (question.type === "multiselect") for (const value of extras) rows.push({ kind: "extra", value });
		if (question.allowOther) rows.push({ kind: "other" });
		// §12. Skipping is per question and always offered, unnumbered so that a
		// digit meant for an option can never land on it.
		rows.push({ kind: "skip" });
		return rows;
	}

	function rows(question: Question): Row[] {
		return rowsFor(question, state(question).extras);
	}

	function cursorRow(question: Question): Row | undefined {
		const list = rows(question);
		const s = state(question);
		s.cursor = Math.min(Math.max(0, s.cursor), list.length - 1);
		return list[s.cursor];
	}

	/** The text field that takes keys right now, if any. */
	function activeField(): { get(): string; clear(): void } | null {
		if (noting) return null;
		const question = current();
		if (!question) return null;
		const s = state(question);
		if (s.text) {
			const editor = s.text;
			return { get: () => editor.getText(), clear: () => editor.setText("") };
		}
		if (cursorRow(question)?.kind === "other") {
			return { get: () => s.other.getValue(), clear: () => s.other.setValue("") };
		}
		return null;
	}

	// ------------------------------------------------------------- answering

	function finish(outcome: "answered" | "cancelled"): void {
		if (finished) return;
		finished = true;
		if (outcome === "cancelled") {
			done({ outcome: "cancelled", answers: [] });
			return;
		}
		done({
			outcome: "answered",
			answers: questions.map((question) => {
				const s = state(question);
				// A question the user never answered reads as skipped (§12).
				const answer = s.answer ?? skipped(question);
				return { ...answer, note: s.note };
			}),
		});
	}

	function record(question: Question, answer: Answer): void {
		state(question).answer = answer;
		// A single-question ask closes as soon as it is answered (§12).
		if (!isMulti) {
			finish("answered");
			return;
		}
		const next = questions.findIndex((candidate, index) => index > tab && !state(candidate).answer);
		const earlier = questions.findIndex((candidate) => !state(candidate).answer);
		tab = next !== -1 ? next : earlier !== -1 ? earlier : reviewTab;
		if (tab === reviewTab) reviewCursor = questions.length;
		refresh();
	}

	function skipped(question: Question): Answer {
		return { id: question.id, values: [], labels: [], typed: false, omitted: true, note: null };
	}

	function picked(question: Question, values: string[], typed: string[]): Answer {
		const labels = values.map((value) => question.options.find((option) => option.value === value)?.label ?? value);
		return {
			id: question.id,
			values: [...values, ...typed],
			labels: [...labels, ...typed],
			typed: typed.length > 0,
			omitted: false,
			note: null,
		};
	}

	function submitText(question: Question, value: string): void {
		const trimmed = value.trim();
		if (!trimmed) {
			record(question, skipped(question));
			return;
		}
		// The editor clears itself on submit; keep the answer in it for a revisit.
		state(question).text?.setText(trimmed);
		record(question, picked(question, [], [trimmed]));
	}

	function commitMultiselect(question: Question): void {
		const s = state(question);
		const typed = s.other.getValue().trim();
		if (typed) addExtra(question, typed);
		const values = question.options.map((option) => option.value).filter((value) => s.checked.has(value));
		if (values.length === 0 && s.extras.length === 0) {
			// Enter on an option with nothing ticked means that option.
			const row = cursorRow(question);
			if (row?.kind === "option") {
				s.checked.add(row.value);
				commitMultiselect(question);
				return;
			}
			record(question, skipped(question));
			return;
		}
		record(question, picked(question, values, [...s.extras]));
	}

	function addExtra(question: Question, value: string): void {
		const s = state(question);
		s.other.setValue("");
		const option = question.options.find((candidate) => candidate.label.toLowerCase() === value.toLowerCase());
		if (option) s.checked.add(option.value);
		else if (!s.extras.includes(value)) s.extras.push(value);
		// The new row lands above the input row; the cursor stays on the input.
		const other = rows(question).findIndex((row) => row.kind === "other");
		if (other !== -1 && cursorRow(question)?.kind !== "option") s.cursor = other;
	}

	function toggle(question: Question, row: Row): void {
		const s = state(question);
		if (row.kind === "option") {
			if (s.checked.has(row.value)) s.checked.delete(row.value);
			else s.checked.add(row.value);
		} else if (row.kind === "extra") {
			s.extras = s.extras.filter((value) => value !== row.value);
		}
		refresh();
	}

	/** Enter, or a digit, on a row of an option question. */
	function choose(question: Question, row: Row): void {
		const s = state(question);
		if (row.kind === "skip") {
			record(question, skipped(question));
			return;
		}
		if (question.type === "multiselect") {
			if (row.kind === "other") {
				const typed = s.other.getValue().trim();
				if (typed) {
					addExtra(question, typed);
					refresh();
					return;
				}
			}
			commitMultiselect(question);
			return;
		}
		if (row.kind === "option") {
			record(question, picked(question, [row.value], []));
			return;
		}
		if (row.kind === "other") {
			const typed = s.other.getValue().trim();
			if (typed) record(question, picked(question, [], [typed]));
		}
	}

	// ----------------------------------------------------------------- keys

	function switchTab(delta: number): void {
		const count = reviewTab + 1;
		tab = (tab + delta + count) % count;
		if (tab === reviewTab) reviewCursor = questions.length;
		refresh();
	}

	function handleInput(data: string): void {
		if (finished) return;
		if (now() - openedAt < graceMs) return;

		if (noting) {
			if (matchesKey(data, Key.escape)) {
				noting = false;
				refresh();
				return;
			}
			noteEditor.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, Key.escape)) {
			const field = activeField();
			if (field && field.get().length > 0) {
				field.clear();
				cancelArmedAt = null;
				refresh();
				return;
			}
			if (cancelArmedAt !== null && now() - cancelArmedAt <= CANCEL_ARM_MS) {
				finish("cancelled");
				return;
			}
			cancelArmedAt = now();
			refresh();
			return;
		}
		if (cancelArmedAt !== null) {
			cancelArmedAt = null;
			cached = undefined;
		}

		if (isMulti && matchesKey(data, Key.tab)) return switchTab(1);
		if (isMulti && matchesKey(data, Key.shift("tab"))) return switchTab(-1);

		if (tab === reviewTab) return handleReview(data);

		const question = current();
		if (!question) return;
		const s = state(question);

		if (s.text) {
			s.text.handleInput(data);
			refresh();
			return;
		}

		if (isMulti && !activeField() && (matchesKey(data, Key.right) || matchesKey(data, Key.left))) {
			return switchTab(matchesKey(data, Key.right) ? 1 : -1);
		}

		const list = rows(question);
		const row = cursorRow(question);
		if (!row) return;

		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			const delta = matchesKey(data, Key.up) ? -1 : 1;
			s.cursor = (s.cursor + delta + list.length) % list.length;
			refresh();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			choose(question, row);
			return;
		}
		if (matchesKey(data, Key.ctrl("n"))) {
			noting = true;
			noteEditor.setText(s.note ?? "");
			refresh();
			return;
		}

		if (row.kind === "other") {
			s.other.handleInput(data);
			refresh();
			return;
		}

		if (matchesKey(data, Key.space) && question.type === "multiselect") {
			toggle(question, row);
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const target = Number(data) - 1;
			const hit = list[target];
			if (!hit || hit.kind === "skip") return;
			s.cursor = target;
			if (hit.kind === "other") refresh();
			else if (question.type === "multiselect") toggle(question, hit);
			else choose(question, hit);
			return;
		}

		// Typing on the list starts a typed answer, when the question takes one.
		const printable = printableOf(data);
		if (printable && question.allowOther) {
			s.cursor = list.findIndex((candidate) => candidate.kind === "other");
			s.other.handleInput(data);
			refresh();
		}
	}

	function handleReview(data: string): void {
		const count = questions.length + 1;
		if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
			reviewCursor = (reviewCursor + (matchesKey(data, Key.up) ? -1 : 1) + count) % count;
			refresh();
			return;
		}
		if (matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			switchTab(matchesKey(data, Key.right) ? 1 : -1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (reviewCursor === questions.length) finish("answered");
			else {
				tab = reviewCursor;
				refresh();
			}
		}
	}

	// --------------------------------------------------------------- render

	function render(width: number): string[] {
		if (cached) return cached;
		const w = Math.max(1, width);
		const lines: string[] = [];
		const add = (prefix: string, body: string): void => {
			const prefixWidth = visibleWidth(prefix);
			if (prefixWidth >= w) {
				lines.push(...wrapTextWithAnsi(prefix + body, w));
				return;
			}
			const pad = " ".repeat(prefixWidth);
			wrapTextWithAnsi(body, w - prefixWidth).forEach((line, i) => lines.push((i === 0 ? prefix : pad) + line));
		};

		lines.push(theme.fg("accent", "─".repeat(w)));
		const queued = options.queued?.() ?? 0;
		const heading = [
			attribution ? theme.fg("warning", theme.bold(`Question from ${attribution}`)) : null,
			queued > 0 ? theme.fg("dim", `${queued} more ask${queued === 1 ? "" : "s"} waiting`) : null,
		].filter(Boolean);
		if (heading.length > 0) add(" ", heading.join(theme.fg("dim", " · ")));
		if (context) add(" ", theme.fg("muted", context));
		if (heading.length > 0 || context) lines.push("");

		if (isMulti) {
			const tabs = questions.map((question, i) => {
				const answer = state(question).answer;
				const mark = !answer ? "○" : answer.omitted ? "–" : "✓";
				const label = ` ${mark} ${question.label} `;
				if (i === tab) return theme.bg("selectedBg", theme.fg("text", label));
				return theme.fg(!answer ? "muted" : answer.omitted ? "dim" : "success", label);
			});
			const submit = " Submit ";
			tabs.push(tab === reviewTab ? theme.bg("selectedBg", theme.fg("text", submit)) : theme.fg("muted", submit));
			add(" ", tabs.join(theme.fg("dim", "│")));
			lines.push("");
		}

		const question = current();
		let fieldFocused = false;
		if (tab === reviewTab) {
			renderReview(add, lines);
		} else if (question) {
			fieldFocused = renderQuestion(question, w, add, lines);
		}

		lines.push("");
		if (cancelArmedAt !== null) {
			add(" ", theme.fg("warning", "Press Esc again to cancel the whole ask. The agent will stop."));
		} else {
			add(" ", theme.fg("dim", helpLine(question, fieldFocused)));
		}
		lines.push(theme.fg("accent", "─".repeat(w)));
		cached = lines;
		return lines;
	}

	function renderReview(add: (prefix: string, body: string) => void, lines: string[]): void {
		const labelWidth = Math.max(...questions.map((question) => visibleWidth(question.label)));
		questions.forEach((question, i) => {
			const s = state(question);
			const cursor = i === reviewCursor ? theme.fg("accent", "› ") : "  ";
			const label = theme.fg("muted", question.label.padEnd(labelWidth));
			const summary = !s.answer
				? theme.fg("warning", "not answered, will be skipped")
				: s.answer.omitted
					? theme.fg("dim", "skipped, the agent decides")
					: theme.fg("text", s.answer.labels.join(", "));
			add(` ${cursor}`, `${label}  ${summary}`);
			if (s.note) add(`   ${" ".repeat(labelWidth)}  `, theme.fg("dim", `note: ${s.note}`));
		});
		lines.push("");
		const onSubmit = reviewCursor === questions.length;
		add(
			` ${onSubmit ? theme.fg("accent", "› ") : "  "}`,
			onSubmit ? theme.fg("accent", theme.bold("Submit answers")) : theme.fg("text", "Submit answers"),
		);
	}

	/** Returns whether a text field has the keys. */
	function renderQuestion(
		question: Question,
		width: number,
		add: (prefix: string, body: string) => void,
		lines: string[],
	): boolean {
		const s = state(question);
		add(" ", theme.fg("text", theme.bold(question.prompt)) + (question.optional ? theme.fg("dim", "  (optional)") : ""));
		if (question.type === "multiselect") add(" ", theme.fg("dim", "Pick any number."));
		lines.push("");

		if (s.text) {
			const editor = s.text;
			editor.focused = focused && !noting;
			for (const line of editor.render(Math.max(1, width - 2))) lines.push(` ${line}`);
			if (!editor.getText()) add(" ", theme.fg("dim", "Leave it empty and press Enter to skip."));
			renderNote(s, width, add, lines);
			return !noting;
		}

		const list = rows(question);
		const cursorIndex = s.cursor;
		const blocks: string[][] = list.map((row, i) => renderRow(question, row, i, i === cursorIndex && !noting, width));
		// Long lists are windowed around the cursor so the overlay fits the terminal.
		const budget = Math.max(6, (tui.terminal?.rows ?? 40) - 14);
		const total = blocks.reduce((sum, block) => sum + block.length, 0);
		let from = 0;
		let to = blocks.length;
		if (total > budget) {
			from = cursorIndex;
			to = cursorIndex + 1;
			let used = blocks[cursorIndex]!.length;
			while (true) {
				const below = to < blocks.length ? blocks[to]!.length : Infinity;
				const above = from > 0 ? blocks[from - 1]!.length : Infinity;
				if (below <= above && used + below <= budget - 2) {
					used += below;
					to++;
				} else if (above < Infinity && used + above <= budget - 2) {
					used += above;
					from--;
				} else break;
			}
		}
		if (from > 0) add("   ", theme.fg("dim", `↑ ${from} more`));
		for (const block of blocks.slice(from, to)) lines.push(...block);
		if (to < blocks.length) add("   ", theme.fg("dim", `↓ ${blocks.length - to} more`));

		renderNote(s, width, add, lines);
		const onOther = list[cursorIndex]?.kind === "other" && !noting;
		s.other.focused = focused && onOther;
		return onOther;
	}

	function renderRow(question: Question, row: Row, index: number, isCursor: boolean, width: number): string[] {
		const s = state(question);
		const out: string[] = [];
		const pointer = isCursor ? theme.fg("accent", "› ") : "  ";
		const number = row.kind === "skip" ? "   " : index < 9 ? `${index + 1}. ` : "   ";
		const box =
			question.type !== "multiselect" || row.kind === "skip" || row.kind === "other"
				? ""
				: row.kind === "extra" || s.checked.has(row.value)
					? theme.fg("success", "[x] ")
					: "[ ] ";
		const prefix = ` ${pointer}${theme.fg("dim", number)}${box}`;
		const prefixWidth = visibleWidth(prefix);
		const bodyWidth = Math.max(1, width - prefixWidth);
		const push = (body: string, first: boolean) => {
			wrapTextWithAnsi(body, bodyWidth).forEach((line, i) =>
				out.push((first && i === 0 ? prefix : " ".repeat(prefixWidth)) + line),
			);
		};
		const color = isCursor ? "accent" : "text";

		switch (row.kind) {
			case "option": {
				const chosen = question.type !== "multiselect" && s.answer?.values.includes(row.value) && !s.answer.typed;
				push(theme.fg(color, row.label) + (chosen ? theme.fg("success", "  ✓") : ""), true);
				if (row.description) push(theme.fg("muted", row.description), false);
				break;
			}
			case "extra":
				push(theme.fg(color, row.value) + theme.fg("dim", "  (typed)"), true);
				break;
			case "other": {
				const value = s.other.getValue();
				if (isCursor) {
					const label = theme.fg("accent", "Answer: ");
					const field = s.other.render(Math.max(1, bodyWidth - visibleWidth(label)))[0] ?? "";
					out.push(prefix + label + field);
				} else if (value) {
					push(theme.fg("muted", "Answer: ") + theme.fg("text", value), true);
				} else {
					const typedAnswer = question.type === "select" && s.answer?.typed ? s.answer.labels[0] : null;
					push(
						typedAnswer
							? theme.fg("text", typedAnswer) + theme.fg("success", "  ✓")
							: theme.fg("muted", "Type your own answer…"),
						true,
					);
				}
				break;
			}
			case "skip":
				push(theme.fg(isCursor ? "accent" : "dim", "Skip, let the agent decide"), true);
				break;
		}
		return out.map((line) => truncateToWidth(line, width));
	}

	function renderNote(
		s: QuestionState,
		width: number,
		add: (prefix: string, body: string) => void,
		lines: string[],
	): void {
		if (noting) {
			lines.push("");
			add(" ", theme.fg("muted", "Note for the agent:"));
			noteEditor.focused = focused;
			for (const line of noteEditor.render(Math.max(1, width - 2))) lines.push(` ${line}`);
			return;
		}
		if (s.note) {
			lines.push("");
			add(" ", theme.fg("dim", `note: ${s.note}`));
		}
	}

	function helpLine(question: Question | undefined, fieldFocused: boolean): string {
		const keys: string[] = [];
		if (noting) return "Enter save note • Shift+Enter new line • Esc discard";
		if (tab === reviewTab) {
			keys.push("↑↓ move", "Enter open or submit", "Tab switch");
		} else if (question?.type === "text") {
			keys.push("Enter submit", "Shift+Enter new line");
			if (isMulti) keys.push("Tab next");
			keys.push("Ctrl+N note");
		} else if (fieldFocused) {
			keys.push(question?.type === "multiselect" ? "Enter add" : "Enter submit", "↑↓ move", "Esc clear");
			if (isMulti) keys.push("Tab next");
		} else {
			keys.push("↑↓ move");
			if (question?.type === "multiselect") keys.push("Space or 1-9 toggle", "Enter confirm");
			else keys.push("Enter or 1-9 pick");
			if (question?.allowOther) keys.push("type to answer");
			keys.push("Ctrl+N note");
			if (isMulti) keys.push("Tab next");
		}
		if (!fieldFocused || question?.type === "text") keys.push("Esc Esc cancel");
		return keys.join(" • ");
	}

	return {
		render,
		invalidate: (): void => {
			cached = undefined;
		},
		handleInput,
		get focused(): boolean {
			return focused;
		},
		set focused(value: boolean) {
			focused = value;
			cached = undefined;
		},
	};
}

function printableOf(data: string): string | undefined {
	if (data.length === 1) {
		const code = data.charCodeAt(0);
		return code >= 32 && code !== 127 ? data : undefined;
	}
	return decodeKittyPrintable(data);
}
