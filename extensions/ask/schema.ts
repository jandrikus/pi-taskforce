/**
 * §12. Asking the user: the shape of a question, what the harness fills in, and
 * what it refuses.
 *
 * A question that cannot be rendered is a bug in the call, not something the
 * user should be shown, so every refusal here says exactly what to change.
 */

export type QuestionType = "select" | "multiselect" | "text" | "confirm";

export interface AskOption {
	value: string;
	label: string;
	description?: string | null;
}

/** A question exactly as an agent sends it. Everything optional is filled in below. */
export interface RawQuestion {
	id?: unknown;
	prompt?: unknown;
	type?: unknown;
	options?: unknown;
	label?: unknown;
	default?: unknown;
	optional?: unknown;
	allowOther?: unknown;
}

export interface Question {
	id: string;
	prompt: string;
	type: QuestionType;
	options: AskOption[];
	/** A short tab label; defaults to the question's position, `Q1`, `Q2`, … (§12). */
	label: string;
	default: string | null;
	optional: boolean;
	allowOther: boolean;
}

export interface Ask {
	/** An optional one line of context for the whole call. */
	context: string | null;
	questions: Question[];
}

export type ValidationResult = { ok: true; ask: Ask } | { ok: false; message: string };

const CONFIRM_OPTIONS: AskOption[] = [
	{ value: "yes", label: "Yes" },
	{ value: "no", label: "No" },
];

/**
 * §13. A question crossing the boundary from a child is untrusted input and is
 * validated again on arrival, which is why this is a plain function over plain
 * data rather than something bound to a call site.
 */
export function validateAsk(context: unknown, rawQuestions: unknown): ValidationResult {
	if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
		return fail("An ask needs at least one question. Add a `questions` list with one entry per thing you need to know.");
	}

	const questions: Question[] = [];
	const seen = new Set<string>();

	for (let i = 0; i < rawQuestions.length; i++) {
		const raw = (rawQuestions[i] ?? {}) as RawQuestion;
		const position = i + 1;

		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (id.length === 0) {
			return fail(`Question ${position} has no \`id\`. Give every question a short id you can read the answer back by.`);
		}
		if (seen.has(id)) {
			return fail(`Two questions in this call use the id \`${id}\`. Ids must be unique within one ask.`);
		}
		seen.add(id);

		const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
		if (prompt.length === 0) {
			return fail(`Question \`${id}\` has no \`prompt\`. Say what you are asking.`);
		}

		const declaredOptions = raw.options;
		const hasOptions = Array.isArray(declaredOptions) && declaredOptions.length > 0;

		// §12. An omitted type is inferred from the shape of the call: options
		// present means select, options absent means text.
		const type = normalizeType(raw.type) ?? (hasOptions ? "select" : "text");

		if ((type === "text" || type === "confirm") && Array.isArray(declaredOptions) && declaredOptions.length > 0) {
			return fail(
				`Question \`${id}\` is a ${type} question and declares options. Drop the options, or make it a select.`,
			);
		}
		if ((type === "select" || type === "multiselect") && !hasOptions) {
			return fail(`Question \`${id}\` is a ${type} and has no options. Give it the options to choose from.`);
		}

		let options: AskOption[] = [];
		if (type === "confirm") {
			// A confirm question is given its Yes and No options by the harness (§12).
			options = CONFIRM_OPTIONS.map((option) => ({ ...option }));
		} else if (hasOptions) {
			const parsed = parseOptions(declaredOptions as unknown[], id);
			if (typeof parsed === "string") return fail(parsed);
			options = parsed;
		}

		const fallback = raw.default === undefined || raw.default === null ? null : String(raw.default);
		if (fallback !== null && options.length > 0 && !options.some((option) => option.value === fallback)) {
			return fail(
				`Question \`${id}\` has a default of \`${fallback}\`, which is not one of its options: ` +
					`${options.map((option) => option.value).join(", ")}.`,
			);
		}

		questions.push({
			id,
			prompt,
			type,
			options,
			label: typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : `Q${position}`,
			default: fallback,
			optional: Boolean(raw.optional),
			// §12. `allowOther` defaults to on for the two option types, and means
			// nothing for text and confirm.
			allowOther:
				type === "select" || type === "multiselect"
					? raw.allowOther === undefined
						? true
						: Boolean(raw.allowOther)
					: false,
		});
	}

	return {
		ok: true,
		ask: {
			context: typeof context === "string" && context.trim() ? context.trim() : null,
			questions,
		},
	};
}

function parseOptions(raw: unknown[], questionId: string): AskOption[] | string {
	const out: AskOption[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = raw[i];
		if (typeof entry === "string") {
			if (entry.trim().length === 0) {
				return `Option ${i + 1} of question \`${questionId}\` is empty. Every option needs a value and a label.`;
			}
			out.push({ value: entry.trim(), label: entry.trim() });
			continue;
		}
		if (!entry || typeof entry !== "object") {
			return `Option ${i + 1} of question \`${questionId}\` is not an option. Give it a \`value\` and a \`label\`.`;
		}
		const record = entry as Record<string, unknown>;
		const value = typeof record.value === "string" ? record.value.trim() : "";
		const label = typeof record.label === "string" ? record.label.trim() : "";
		if (value.length === 0) {
			return `Option ${i + 1} of question \`${questionId}\` is missing its \`value\`.`;
		}
		if (label.length === 0) {
			return `Option ${i + 1} of question \`${questionId}\` is missing its \`label\`.`;
		}
		out.push({
			value,
			label,
			description: typeof record.description === "string" ? record.description.trim() : null,
		});
	}
	return out;
}

function normalizeType(value: unknown): QuestionType | null {
	if (typeof value !== "string") return null;
	const type = value.trim().toLowerCase();
	if (type === "select" || type === "multiselect" || type === "text" || type === "confirm") {
		return type;
	}
	return null;
}

function fail(message: string): { ok: false; message: string } {
	return { ok: false, message };
}

// -------------------------------------------------------------------- answers

export type AskOutcome = "answered" | "omitted" | "cancelled" | "unattended";

export interface Answer {
	id: string;
	/** Empty when the question was omitted. */
	values: string[];
	/** The labels the user saw for those values. */
	labels: string[];
	/** True when the answer was typed rather than picked (§12). */
	typed: boolean;
	omitted: boolean;
	note: string | null;
}

export interface AskResult {
	outcome: AskOutcome;
	answers: Answer[];
}

/**
 * §12. Omitted and unattended are phrased to the agent as permission to proceed
 * on its own judgment and to state its assumptions, never as an error. An agent
 * told the call failed retries it, and the second attempt has exactly as little
 * chance of finding a user as the first.
 */
export function renderAskResult(ask: Ask, result: AskResult): string {
	if (result.outcome === "cancelled") {
		return [
			"The ask was cancelled: nobody answered, and the user stopped the work rather than passing the question on.",
			"Stop here rather than proceeding on assumptions.",
		].join("\n");
	}
	if (result.outcome === "unattended") {
		return [
			"There was no interactive user to answer, so the questions read as omitted.",
			"Proceed on your own judgment and state the assumptions you made.",
		].join("\n");
	}

	const lines: string[] = [];
	for (const question of ask.questions) {
		const answer = result.answers.find((candidate) => candidate.id === question.id);
		if (!answer || answer.omitted) {
			lines.push(
				`${question.id}: omitted. Proceed on your own judgment for this one and state your assumption.`,
			);
			continue;
		}
		const shown = answer.labels.length > 0 ? answer.labels : answer.values;
		let line = `${question.id}: ${shown.join(", ")}`;
		// A text question has nothing to pick from, so typed says nothing there.
		if (answer.typed && question.options.length > 0) line += " (typed, not picked from the options)";
		lines.push(line);
		if (answer.note) lines.push(`  note: ${answer.note}`);
	}
	return lines.join("\n");
}
