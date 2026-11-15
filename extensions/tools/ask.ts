/**
 * §12, §13. `ask` and `answer_subagent`.
 *
 * `answer_subagent` carries no prompt text and is registered in every agent, so
 * a forked child's prompt stays identical to its parent's; the model learns the
 * call from the question message, which is the only turn where knowing it is any
 * use.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

import type { AskBroker } from "../ask/broker.js";
import { renderAskResult, validateAsk } from "../ask/schema.js";
import type { AskResult } from "../ask/schema.js";
import * as prompts from "../prompts/index.js";

const Option = Type.Object({
	value: Type.String({ description: "The value the answer carries back" }),
	label: Type.String({ description: "What the user sees for this option" }),
	description: Type.Optional(Type.String({ description: "A line of detail under the label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "A short id you read the answer back by" }),
	prompt: Type.String({ description: "The question itself" }),
	type: Type.Optional(
		StringEnum(["select", "multiselect", "text", "confirm"] as const, {
			description: "Left out, it is inferred: options present means select, options absent means text",
		}),
	),
	options: Type.Optional(Type.Array(Option, { description: "The options to choose from" })),
	label: Type.Optional(Type.String({ description: "A short tab label; defaults to Q1, Q2, …" })),
	default: Type.Optional(Type.String({ description: "The option value to start on" })),
	optional: Type.Optional(Type.Boolean({ description: "The user may leave this one unanswered" })),
	allowOther: Type.Optional(
		Type.Boolean({ description: "Offer a free-text row beside the options; on by default" }),
	),
});

const AskParams = Type.Object({
	context: Type.Optional(Type.String({ description: "One line of context for the whole ask" })),
	questions: Type.Array(QuestionSchema, { description: "Everything you need to know, in one call" }),
});

const AnswerParams = Type.Object({
	reference: Type.String({ description: "The reference given in the question message" }),
	answers: Type.Array(
		Type.Object({
			id: Type.String({ description: "The question's id" }),
			value: Type.String({ description: "The answer, or values joined by a comma for a multiselect" }),
			note: Type.Optional(Type.String({ description: "Anything to add to this answer" })),
		}),
		{ description: "One answer per question the subagent asked" },
	),
});

function text(body: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: body }], details };
}

export function registerAskTools(pi: ExtensionAPI, broker: AskBroker, options: { ask: boolean }): void {
	// §3. With asking off there is no `ask`, but a child's question still has to
	// be answerable, so `answer_subagent` stays.
	if (options.ask) registerAsk(pi, broker);
	registerAnswer(pi, broker);
}

function registerAsk(pi: ExtensionAPI, broker: AskBroker): void {
	pi.registerTool({
		name: "ask",
		label: "Ask",
		description: prompts.ASK_DESCRIPTION,
		promptSnippet: prompts.ASK_SNIPPET,
		promptGuidelines: prompts.ASK_GUIDELINES,
		parameters: AskParams,
		// Both surfaces own the screen, and two of them would fight over the user (§12).
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const validated = validateAsk(params.context, params.questions);
			if (!validated.ok) return text(validated.message, { refused: true });

			const result = await broker.ask(validated.ask, ctx);
			return text(renderAskResult(validated.ask, result), result as unknown as Record<string, unknown>);
		},
		renderCall(args, theme) {
			const questions = Array.isArray(args.questions) ? args.questions : [];
			let body = theme.fg("toolTitle", theme.bold("ask "));
			body += theme.fg("muted", `${questions.length} question${questions.length === 1 ? "" : "s"}`);
			if (typeof args.context === "string" && args.context) {
				body += `\n${theme.fg("dim", `  ${args.context}`)}`;
			}
			return new Text(body, 0, 0);
		},
		renderResult(result, _options, theme, context) {
			const details = result.details as (AskResult & { refused?: boolean }) | undefined;
			const first = result.content[0];
			const body = first?.type === "text" ? first.text : "";
			if (details?.refused || !details?.outcome) return new Text(theme.fg("warning", body), 0, 0);
			if (details.outcome === "cancelled") return new Text(theme.fg("warning", "Cancelled by the user"), 0, 0);
			if (details.outcome === "unattended") {
				return new Text(theme.fg("dim", "Nobody to ask, so the agent decides on its own"), 0, 0);
			}
			// The user reads the question by its tab label and the answer by what
			// they picked; the agent's version, with ids, is in the content.
			const asked = Array.isArray(context.args?.questions)
				? (context.args.questions as Array<{ id?: string; label?: string; options?: unknown[] }>)
				: [];
			const lines = details.answers.map((answer, i) => {
				const question = asked.find((candidate) => candidate.id === answer.id);
				const label = theme.fg("muted", `${question?.label || (asked.length > 1 ? `Q${i + 1}` : "Answer")}: `);
				const value = answer.omitted
					? theme.fg("dim", "skipped")
					: theme.fg("text", answer.labels.join(", ")) + (answer.typed && question?.options?.length ? theme.fg("dim", " (typed)") : "");
				return label + value + (answer.note ? `\n${theme.fg("dim", `  note: ${answer.note}`)}` : "");
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}

function registerAnswer(pi: ExtensionAPI, broker: AskBroker): void {
	pi.registerTool({
		name: "answer_subagent",
		label: "Answer subagent",
		description: prompts.ANSWER_SUBAGENT_DESCRIPTION,
		// No promptSnippet and no guidelines: a snippet would put it in the roster,
		// and a forked child's prompt must stay byte-identical to its parent's (§8).
		parameters: AnswerParams,
		async execute(_id, params) {
			const problem = broker.answer(
				params.reference,
				params.answers.map((answer) => ({
					id: answer.id,
					value: answer.value,
					note: answer.note,
				})),
			);
			if (problem) return text(problem, { refused: true });
			return text("Answered. The subagent has been unblocked and carries on.");
		},
	});
}
