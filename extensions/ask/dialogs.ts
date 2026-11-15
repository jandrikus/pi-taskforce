/**
 * §12. The rpc surface: the host's own dialogs, one question at a time.
 *
 * Notes are not offered here. A note would cost a second modal per question, and
 * asking the user twice for every answer is worse than not having notes.
 *
 * Dismissing any one dialog cancels the whole ask, because dismissing is the
 * user stopping the work rather than passing a question on.
 */

import type { Ask, Answer, AskResult, Question } from "./schema.js";

/** The slice of `ctx.ui` this surface uses, narrow on purpose so it is testable. */
export interface DialogUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

const OTHER = "Type my own answer…";
const DONE = "Done";
const SKIP = "Skip, let the agent decide";
const YES = "Yes";
const NO = "No";

export async function runDialogs(ui: DialogUI, ask: Ask): Promise<AskResult> {
	const answers: Answer[] = [];
	for (const question of ask.questions) {
		const answer = await askOne(ui, question, ask.questions.length > 1 ? `${question.label}: ` : "");
		if (answer === null) return { outcome: "cancelled", answers: [] };
		answers.push(answer);
	}
	return { outcome: "answered", answers };
}

async function askOne(ui: DialogUI, question: Question, lead: string): Promise<Answer | null> {
	const title = lead + question.prompt;
	switch (question.type) {
		case "confirm": {
			// A select rather than the host's confirm: a dismissed confirm reads as
			// No, and dismissing has to cancel (§12).
			const picked = await ui.select(title, [YES, NO, SKIP]);
			if (picked === undefined) return null;
			if (picked === SKIP) return omitted(question);
			return picked === YES ? answer(question, ["yes"], ["Yes"]) : answer(question, ["no"], ["No"]);
		}
		case "text": {
			const value = await ui.input(title, question.default ?? "Leave empty to skip");
			if (value === undefined) return null;
			const trimmed = value.trim();
			if (!trimmed) return omitted(question);
			return answer(question, [trimmed], [trimmed], true);
		}
		case "select": {
			const rows = [...question.options.map((option) => option.label), ...(question.allowOther ? [OTHER] : []), SKIP];
			const picked = await ui.select(title, rows);
			if (picked === undefined) return null;
			if (picked === SKIP) return omitted(question);
			if (picked === OTHER) {
				const typed = await ui.input(title, "Leave empty to skip");
				if (typed === undefined) return null;
				const trimmed = typed.trim();
				if (!trimmed) return omitted(question);
				return answer(question, [trimmed], [trimmed], true);
			}
			const option = question.options.find((candidate) => candidate.label === picked);
			return answer(question, [option?.value ?? picked], [picked]);
		}
		case "multiselect": {
			const checked = new Set<string>(question.default ? [question.default] : []);
			const typed: string[] = [];
			const mark = (on: boolean) => (on ? "[x] " : "[ ] ");
			for (;;) {
				const optionRows = question.options.map((option) => mark(checked.has(option.value)) + option.label);
				const typedRows = typed.map((value) => mark(true) + value);
				const rows = [...optionRows, ...typedRows, ...(question.allowOther ? [OTHER] : []), DONE, SKIP];
				const picked = await ui.select(`${title} (pick to toggle, then Done)`, rows);
				if (picked === undefined) return null;
				if (picked === SKIP) return omitted(question);
				if (picked === DONE) {
					const values = question.options.map((option) => option.value).filter((value) => checked.has(value));
					if (values.length === 0 && typed.length === 0) return omitted(question);
					const labels = values.map((value) => question.options.find((option) => option.value === value)!.label);
					return answer(question, [...values, ...typed], [...labels, ...typed], typed.length > 0);
				}
				if (picked === OTHER) {
					const value = await ui.input(title);
					if (value === undefined) return null;
					const trimmed = value.trim();
					if (trimmed && !typed.includes(trimmed)) typed.push(trimmed);
					continue;
				}
				const optionIndex = optionRows.indexOf(picked);
				if (optionIndex !== -1) {
					const value = question.options[optionIndex]!.value;
					if (checked.has(value)) checked.delete(value);
					else checked.add(value);
					continue;
				}
				const typedIndex = typedRows.indexOf(picked);
				if (typedIndex !== -1) typed.splice(typedIndex, 1);
			}
		}
	}
}

function answer(question: Question, values: string[], labels: string[], typed = false): Answer {
	return { id: question.id, values, labels, typed, omitted: false, note: null };
}

function omitted(question: Question): Answer {
	return { id: question.id, values: [], labels: [], typed: false, omitted: true, note: null };
}
