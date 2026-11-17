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

import type { AskDraft, DraftAnswer } from "./journal.js";
import type { AskEnvelope } from "./protocol.js";
import type { Answer, AskResult, Question } from "./schema.js";

/** Keys that arrive this soon after the overlay opens were meant for whatever was there before. */
export const INPUT_GRACE_MS = 350;
/** How long a first Esc waits for the second one. */
export const CANCEL_ARM_MS = 2000;

const DIRECT_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

type Row =
	| { kind: "option"; value: string; label: string; description: string | null }
	| { kind: "extra"; value: string }
	| { kind: "other" }
	| { kind: "skip" }
	| { kind: "submit" };

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
	/** Replaces the default "Question from …" line, e.g. for a recovered ask. */
	heading?: string | null;
	done: (result: AskResult) => void;
	/**
	 * Sends an answered ask and resolves when the answer was accepted. A returned
	 * error keeps the overlay open, with every answer, for another try. Without
	 * this the answer is accepted as soon as it is derived.
	 */
	submit?: (result: AskResult) => Promise<string | null> | string | null;
	/** How many more asks wait for the screen after this one. */
	queued?: () => number;
	/**
	 * §12. Put the ask away without answering it, so the transcript behind it can
	 * be read and scrolled. The ask stays open, and the same instance is shown
	 * again with every answer and position it had.
	 */
	hide?: () => void;
	/**
	 * §12. A saved draft to open with: the question position, and every answer,
	 * typed value and note that was there before the process stopped.
	 */
	initial?: AskDraft | null;
	/**
	 * §12. Called whenever what the user has filled in changes. `immediate` is set
	 * for a boundary that must reach the session now, such as hiding or moving to
	 * another question; ordinary typing is written after a short debounce.
	 */
	onDraft?: (draft: AskDraft, immediate: boolean) => void;
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
	/** Waiting for `submit` to accept the answers; no key may change them meanwhile. */
	let sending = false;
	let submitError: string | null = null;
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

	if (options.initial) restoreDraft(options.initial);

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

	/** Puts a saved draft back into the question states, before anything renders. */
	function restoreDraft(draft: AskDraft): void {
		tab = Math.min(reviewTab, Math.max(0, draft.index));
		if (tab === reviewTab) reviewCursor = questions.length;
		for (const question of questions) {
			const saved = draft.answers[question.id];
			if (!saved) continue;
			const s = state(question);
			s.note = saved.note ?? null;
			if (question.type === "text") {
				if (saved.typed) {
					s.text?.setText(saved.typed);
					s.answer = picked(question, [], [saved.typed]);
				}
			} else if (question.type === "multiselect") {
				s.checked = new Set((saved.picked ?? []).filter((value) => question.options.some((o) => o.value === value)));
				s.extras = (saved.extras ?? []).filter((value) => value.trim().length > 0);
				if (saved.typed) s.other.setValue(saved.typed);
				if (s.checked.size > 0 || s.extras.length > 0) s.answer = picked(question, [...s.checked], [...s.extras]);
			} else {
				const value = saved.typed || saved.picked?.[0];
				if (value) {
					if (question.options.some((option) => option.value === value)) {
						s.answer = picked(question, [value], []);
					} else {
						s.other.setValue(value);
						s.answer = picked(question, [], [value]);
					}
				}
			}
			if (saved.skipped) s.answer = skipped(question);
		}
	}

	/** What the user has filled in, in the shape the journal stores. */
	function snapshot(): AskDraft {
		const answers: Record<string, DraftAnswer> = {};
		for (const question of questions) {
			const s = state(question);
			const saved: DraftAnswer = {};
			if (question.type === "text") {
				const typed = s.text?.getText().trim() ?? "";
				if (typed) saved.typed = typed;
			} else {
				const typed = s.other.getValue().trim();
				if (typed) saved.typed = typed;
				const chosen = question.options.map((option) => option.value).filter((value) => s.checked.has(value));
				if (chosen.length > 0) saved.picked = chosen;
				if (s.extras.length > 0) saved.extras = [...s.extras];
				// A select question answered by choosing a row keeps no check mark.
				if (question.type === "select" && !typed && s.answer && !s.answer.typed) saved.picked = [...s.answer.values];
			}
			if (s.answer?.omitted) saved.skipped = true;
			// A note that is still being typed is part of the draft, so hiding or
			// a kill cannot lose it either.
			const note = noting && question === current() ? noteEditor.getText().trim() : s.note?.trim();
			if (note) saved.note = note;
			if (Object.keys(saved).length > 0) answers[question.id] = saved;
		}
		return { index: tab, at: now(), answers };
	}

	let lastPublished = "";

	/** Declares the draft, when it differs from the one already declared. */
	function publish(immediate = false): void {
		if (!options.onDraft || finished) return;
		const draft = snapshot();
		const key = JSON.stringify({ index: draft.index, answers: draft.answers });
		if (key === lastPublished) {
			// An immediate boundary still has to reach the session, even when the
			// same state was already declared by the debounced write.
			if (immediate) options.onDraft(draft, true);
			return;
		}
		lastPublished = key;
		options.onDraft(draft, immediate);
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
		// A single option question has no review step, so it gets a visible send
		// row. Picking never submits, and neither does Enter on an option.
		if (!isMulti) rows.push({ kind: "submit" });
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

	/**
	 * §12. The answer as the fields stand right now, not as some earlier Enter
	 * left it. This is what review, the journal and the submitted result all read:
	 * text typed on an earlier question is not lost, and an answer the user has
	 * since edited cannot come back from a stale recorded value.
	 *
	 * Returns null when nothing was given and no skip was chosen.
	 */
	function derived(question: Question): Answer | null {
		const s = state(question);
		if (question.type === "text") {
			const typed = s.text?.getText().trim() ?? "";
			return typed ? picked(question, [], [typed]) : s.answer?.omitted ? skipped(question) : null;
		}
		const typed = s.other.getValue().trim();
		if (question.type === "multiselect") {
			const values = question.options.map((option) => option.value).filter((value) => s.checked.has(value));
			const extras = [...s.extras];
			if (typed && !extras.includes(typed)) extras.push(typed);
			if (values.length > 0 || extras.length > 0) return picked(question, values, extras);
			return s.answer?.omitted ? skipped(question) : null;
		}
		// A typed own answer is the latest intent and wins over a row picked before.
		if (typed) return picked(question, [], [typed]);
		if (s.answer && !s.answer.omitted && !s.answer.typed) return { ...s.answer, note: null };
		return s.answer?.omitted ? skipped(question) : null;
	}

	/** The answer submitted for a question: what is there now, or a deliberate skip. */
	function settled(question: Question): Answer {
		return derived(question) ?? skipped(question);
	}

	function resultOf(): AskResult {
		// The note being typed right now counts, even before Enter.
		const active = noting ? current() : undefined;
		return {
			outcome: "answered",
			answers: questions.map((question) => ({
				...settled(question),
				note: question === active ? noteEditor.getText().trim() || null : state(question).note,
			})),
		};
	}

	/**
	 * Explicit submission only. Navigation, picking and hiding never call this.
	 * When the ask must be delivered somewhere (a recovered question), the
	 * overlay stays open until that delivery is accepted, so a failure leaves it
	 * answerable instead of finished.
	 */
	async function finish(outcome: "answered" | "cancelled"): Promise<void> {
		if (finished || sending) return;
		if (outcome === "cancelled") {
			finished = true;
			done({ outcome: "cancelled", answers: [] });
			return;
		}
		const result = resultOf();
		publish(true);
		if (!options.submit) {
			finished = true;
			done(result);
			return;
		}
		sending = true;
		submitError = null;
		refresh();
		let error: string | null;
		try {
			error = await options.submit(result);
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
		}
		sending = false;
		if (error) {
			// Still open, still holding every answer: the user can try again.
			submitError = error;
			refresh();
			return;
		}
		finished = true;
		done(result);
	}

	function record(question: Question, answer: Answer): void {
		state(question).answer = answer;
		// Moving to the next unanswered question is navigation, never submission.
		if (!isMulti) {
			refresh();
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
		// The editor clears itself on submit; keep the answer in it for a revisit.
		if (trimmed) state(question).text?.setText(trimmed);
		if (!isMulti) {
			// Enter in a single text field is an explicit send, not a selection.
			void finish("answered");
			return;
		}
		record(question, trimmed ? picked(question, [], [trimmed]) : skipped(question));
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
		if (row.kind === "submit") {
			void finish("answered");
			return;
		}
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
		publish(true);
		refresh();
	}

	/** Back and Next: one step, stopping at the first question and at Review. */
	function step(delta: number): void {
		tab = Math.min(reviewTab, Math.max(0, tab + delta));
		if (tab === reviewTab) reviewCursor = questions.length;
		publish(true);
		refresh();
	}

	/** Direct navigation to a question by its position. */
	function jump(position: number): void {
		if (!isMulti || position < 0 || position >= questions.length) return;
		tab = position;
		publish(true);
		refresh();
	}

	function handleInput(data: string): void {
		if (finished) return;
		if (now() - openedAt < graceMs) return;

		// Hiding is always available, even while typing a note or waiting for a
		// delivery, and answers nothing.
		if (matchesKey(data, Key.alt("h"))) {
			publish(true);
			options.hide?.();
			return;
		}
		if (sending) return;

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

		// Explicit submission from any question, one or several. Navigation and
		// picking never submit.
		if (matchesKey(data, Key.ctrl("enter"))) {
			void finish("answered");
			return;
		}
		if (isMulti) {
			// Back and Next reach the same place from a text field, so moving
			// between questions never depends on which field has the keys.
			if (matchesKey(data, Key.alt("left"))) return step(-1);
			if (matchesKey(data, Key.alt("right"))) return step(1);
			for (let position = 1; position <= Math.min(9, questions.length); position++) {
				if (matchesKey(data, Key.alt(DIRECT_KEYS[position - 1]!))) return jump(position - 1);
			}
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
			return step(matchesKey(data, Key.right) ? 1 : -1);
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
			// A digit is a pick, never a submit or a skip.
			if (!hit || hit.kind === "skip" || hit.kind === "submit") return;
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
			step(matchesKey(data, Key.right) ? 1 : -1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			if (reviewCursor === questions.length) void finish("answered");
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
			options.heading
				? theme.fg("warning", theme.bold(options.heading))
				: attribution
					? theme.fg("warning", theme.bold(`Question from ${attribution}`))
					: null,
			queued > 0 ? theme.fg("dim", `${queued} more ask${queued === 1 ? "" : "s"} waiting`) : null,
		].filter(Boolean);
		if (heading.length > 0) add(" ", heading.join(theme.fg("dim", " · ")));
		if (context) add(" ", theme.fg("muted", context));
		if (heading.length > 0 || context) lines.push("");

		if (isMulti) {
			lines.push(
				theme.fg(
					"muted",
					tab === reviewTab
						? `Review · ${questions.filter((question) => !derived(question)).length} without an answer`
						: `Question ${tab + 1} of ${questions.length}`,
				),
			);
			const tabs = questions.map((question, i) => {
				const answer = derived(question);
				const mark = !answer ? "○" : answer.omitted ? "–" : "✓";
				const label = ` ${i + 1} ${question.label} ${mark} `;
				if (i === tab) return theme.bg("selectedBg", theme.fg("text", label));
				return theme.fg(!answer ? "muted" : answer.omitted ? "dim" : "success", label);
			});
			const submit = " Review ";
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

		if (isMulti) {
			lines.push("");
			const back = tab > 0 ? theme.fg("accent", "‹ Back") : theme.fg("dim", "‹ Back");
			const next = tab < reviewTab ? theme.fg("accent", "Next ›") : theme.fg("dim", "Next ›");
			add(" ", `${back}   ${next}   ${theme.fg("dim", "Alt+←/→, Alt+1-9 jump")}`);
		}

		lines.push("");
		if (sending) {
			add(" ", theme.fg("warning", "Sending the answers… Alt+H puts the ask away; nothing else is accepted."));
		} else if (submitError) {
			add(" ", theme.fg("error", submitError));
			add(" ", theme.fg("dim", "Every answer is still here. Ctrl+Enter tries again."));
		} else if (cancelArmedAt !== null) {
			add(" ", theme.fg("warning", "Press Esc again to cancel the whole ask. The agent will stop."));
		} else {
			add(" ", theme.fg("dim", helpLine(question, fieldFocused)));
		}
		lines.push(theme.fg("accent", "─".repeat(w)));
		cached = lines;
		// Every state change ends in a render; the journal decides whether it is new.
		publish(false);
		return lines;
	}

	function renderReview(add: (prefix: string, body: string) => void, lines: string[]): void {
		const labelWidth = Math.max(...questions.map((question) => visibleWidth(question.label)));
		questions.forEach((question, i) => {
			const s = state(question);
			const answer = derived(question);
			const cursor = i === reviewCursor ? theme.fg("accent", "› ") : "  ";
			const label = theme.fg("muted", question.label.padEnd(labelWidth));
			const summary = !answer
				? theme.fg("warning", "not answered, will be skipped")
				: answer.omitted
					? theme.fg("dim", "skipped, the agent decides")
					: theme.fg("text", answer.labels.join(", "));
			add(` ${cursor}`, `${label}  ${summary}`);
			const note = noting && i === tab ? noteEditor.getText().trim() : s.note;
			if (note) add(`   ${" ".repeat(labelWidth)}  `, theme.fg("dim", `note: ${note}`));
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
		const number = row.kind === "skip" || row.kind === "submit" ? "   " : index < 9 ? `${index + 1}. ` : "   ";
		const box =
			question.type !== "multiselect" || row.kind === "skip" || row.kind === "other" || row.kind === "submit"
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
			case "submit":
				push(theme.fg(isCursor ? "accent" : "text", theme.bold("Send answer")), true);
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
		} else if (!isMulti && question?.type !== "text") {
			keys.push("↑↓ move");
			if (question?.type === "multiselect") keys.push("Space or 1-9 toggle");
			else keys.push("Enter or 1-9 pick");
			if (question?.allowOther) keys.push("type to answer");
			keys.push("Enter on Send answer or Ctrl+Enter send", "Ctrl+N note");
		} else if (question?.type === "text") {
			keys.push("Enter submit", "Shift+Enter new line");
			if (isMulti) keys.push("Alt+←/→ Back/Next");
			keys.push("Ctrl+N note");
		} else if (fieldFocused) {
			keys.push(question?.type === "multiselect" ? "Enter add" : "Enter submit", "↑↓ move", "Esc clear");
			if (isMulti) keys.push("Alt+←/→ Back/Next");
		} else {
			keys.push("↑↓ move");
			if (question?.type === "multiselect") keys.push("Space or 1-9 toggle", "Enter confirm");
			else keys.push("Enter or 1-9 pick");
			if (question?.allowOther) keys.push("type to answer");
			keys.push("Ctrl+N note");
			if (isMulti) keys.push("Alt+←/→ Back/Next");
		}
		if (isMulti) keys.push("Ctrl+Enter submit");
		keys.push("Alt+H hide");
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
