/**
 * §12. Answering an ask from somewhere other than this terminal.
 *
 * While the overlay shows, the ask is published on pi's shared event bus, so
 * another extension (a phone remote such as Pilot) can render it and answer it.
 * Whichever side answers first wins; the other side is told the ask closed.
 *
 *   ask:open   RemoteAsk    an ask is on screen and can be answered remotely
 *   ask:close  AskClosed    it is gone, answered here, remotely, or torn down
 *
 * A remote answer is untrusted input, so it is checked against the ask and
 * rebuilt the same way the overlay builds one: labels come from the options,
 * never from the sender.
 */

import type { Answer, Ask, AskResult, Question } from "./schema.js";

export const ASK_OPEN = "ask:open";
export const ASK_CLOSE = "ask:close";

/**
 * What a saved answer is doing right now. `saved` means the answers are in the
 * journal but the canonical answer is not written yet; `dispatched` means the
 * canonical answer was written and the question no longer needs a retry.
 */
export interface PendingDelivery {
	state: "saved" | "dispatched";
	message: string;
	/** Whether the user may send these answers again from here. */
	retry: boolean;
}

/**
 * What an answer callback returns. A string is a problem, `null` is success;
 * a pending object keeps the question open and is shown as a status, never as
 * a failure.
 */
export type AnswerReply = string | null | { pending: PendingDelivery };

export interface RemoteAsk {
	id: string;
	ask: Ask;
	/** Who the question came from, when it is not this agent's own (§13). */
	from: string | null;
	at: number;
	/**
	 * Answer the ask. Takes `{ outcome: "cancelled" }` or
	 * `{ outcome: "answered", answers: [{ id, values?, omitted?, note? }] }`.
	 * Returns null on success, or what is wrong with the answer.
	 */
	answer(input: unknown): AnswerReply;
	/** Delivery status of answers this card carries, when one is known. */
	status?: PendingDelivery | null;
}

export interface AskClosed {
	id: string;
	outcome: AskResult["outcome"];
	by: "terminal" | "remote";
}

/** Checks a remote answer against the ask and builds the result the overlay would have. */
export function normalizeRemoteAnswer(ask: Ask, input: unknown): AskResult | string {
	if (!input || typeof input !== "object") return "The answer is not an object.";
	const raw = input as { outcome?: unknown; answers?: unknown };
	if (raw.outcome === "cancelled") return { outcome: "cancelled", answers: [] };
	if (raw.outcome !== undefined && raw.outcome !== "answered") return `Unknown outcome ${String(raw.outcome)}.`;
	if (!Array.isArray(raw.answers)) return "The answer has no `answers` list.";

	const given = new Map<string, Record<string, unknown>>();
	for (const entry of raw.answers) {
		if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
			given.set((entry as { id: string }).id, entry as Record<string, unknown>);
		}
	}
	for (const id of given.keys()) {
		if (!ask.questions.some((question) => question.id === id)) return `There is no question \`${id}\`.`;
	}

	const answers: Answer[] = [];
	for (const question of ask.questions) {
		const entry = given.get(question.id);
		const note = typeof entry?.note === "string" && entry.note.trim() ? entry.note.trim() : null;
		const values = Array.isArray(entry?.values)
			? [...new Set(entry.values.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))]
			: [];
		if (!entry || entry.omitted === true || values.length === 0) {
			answers.push({ id: question.id, values: [], labels: [], typed: false, omitted: true, note });
			continue;
		}
		const built = build(question, values);
		if (typeof built === "string") return built;
		answers.push({ ...built, note });
	}
	return { outcome: "answered", answers };
}

function build(question: Question, values: string[]): Omit<Answer, "note"> | string {
	const isOption = (value: string) => question.options.some((option) => option.value === value);
	const labelOf = (value: string) => question.options.find((option) => option.value === value)?.label ?? value;
	const answer = (picked: string[], typed: string[]) => ({
		id: question.id,
		values: [...picked, ...typed],
		labels: [...picked.map(labelOf), ...typed],
		typed: typed.length > 0,
		omitted: false,
	});

	switch (question.type) {
		case "text":
			if (values.length > 1) return `Question \`${question.id}\` takes one answer.`;
			return answer([], values);
		case "confirm":
			if (values.length > 1 || !isOption(values[0]!)) return `Question \`${question.id}\` takes yes or no.`;
			return answer(values, []);
		case "select": {
			if (values.length > 1) return `Question \`${question.id}\` takes one answer.`;
			const value = values[0]!;
			if (isOption(value)) return answer([value], []);
			if (!question.allowOther) return `\`${value}\` is not an option of question \`${question.id}\`.`;
			return answer([], [value]);
		}
		case "multiselect": {
			const typed = values.filter((value) => !isOption(value));
			if (typed.length > 0 && !question.allowOther) {
				return `\`${typed[0]}\` is not an option of question \`${question.id}\`.`;
			}
			// In option order, then what was typed, as the overlay does.
			const picked = question.options.map((option) => option.value).filter((value) => values.includes(value));
			return answer(picked, typed);
		}
	}
}
