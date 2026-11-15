/**
 * §9. The tools an agent has for its children.
 *
 * They are registered in every agent while subagents are on, but their prompt
 * text is withheld from an agent that can have no children of its own (§15).
 * Registration stays, because a child spawned before a limit moved still has
 * to be closeable.
 */

import { existsSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Orchestration } from "../agents/orchestration.js";
import type { Taskforce } from "../runtime.js";
import * as prompts from "../prompts/index.js";

function text(body: string, details: Record<string, unknown> = {}) {
	return { content: [{ type: "text" as const, text: body }], details };
}

function refused(message: string) {
	return text(message, { refused: true });
}

export interface SubagentToolOptions {
	/** Whether this agent reads about managing children at all (§15). */
	withPromptText: boolean;
}

export function registerSubagentTools(
	pi: ExtensionAPI,
	tf: Taskforce,
	orchestration: Orchestration,
	options: SubagentToolOptions,
): void {
	const snippet = (key: keyof typeof prompts.SUBAGENT_TOOL_SNIPPETS): string | undefined =>
		options.withPromptText ? prompts.SUBAGENT_TOOL_SNIPPETS[key] : undefined;

	pi.registerTool({
		name: "listSubagents",
		label: "List subagents",
		description:
			"List the subagents you have started, with their uuid, type, status and context use.\n\n" +
			"A status is running, compacting, idle or failed. Idle means finished or closed; either kind " +
			"wakes up again when you message it. A child near the top of its context is better given a " +
			"fresh subagent than more work.\n\n" +
			"A finished background child whose report has not reached you yet is marked report queued. " +
			"The report arrives when your current turn ends, so end the turn instead of waiting for it.",
		promptSnippet: snippet("listSubagents"),
		promptGuidelines: options.withPromptText ? prompts.SUBAGENT_GUIDELINES : undefined,
		parameters: Type.Object({}),
		async execute() {
			const children = orchestration.children();
			if (children.length === 0) return text("You have started no subagents.");

			const lines = children.map((child) => {
				const status = orchestration.statusOf(child);
				let line = `- ${child.type ?? "subagent"} \`${child.uuid}\`: ${status}`;
				if (orchestration.hasQueuedReport(child.uuid)) line += ", report queued until your turn ends";
				const usage = tf.supervisor?.contextUsageOf(child.uuid);
				if (usage?.percent !== null && usage?.percent !== undefined) line += `, ${usage.percent}% context`;
				const reason = unusable(tf, child);
				if (reason) line += `. Cannot run again: ${reason}`;
				return line;
			});
			return text(lines.join("\n"), { count: children.length });
		},
	});

	pi.registerTool({
		name: "messageSubagent",
		label: "Message subagent",
		description:
			"Send a message to one of your subagents.\n\n" +
			"A running child reads it at its next step, so do not wait for it. A child that has stopped is " +
			"restarted from its own transcript first, and is asked to read back over its restored context " +
			"before it acts. This is how a child is steered, asked a follow-up, or woken after it was closed.",
		promptSnippet: snippet("messageSubagent"),
		parameters: Type.Object({
			subagent: Type.String({ description: "The child's uuid" }),
			message: Type.String({ description: "What to tell it" }),
		}),
		async execute(_id, params) {
			const child = orchestration.findChild(params.subagent);
			if (typeof child === "string") return refused(child);
			const running = tf.supervisor?.runFor(child.uuid)?.isRunning ?? false;
			const reason = running ? null : unusable(tf, child);
			if (reason) return refused(`\`${child.uuid}\` cannot be restarted: ${reason}. Start a new subagent instead.`);
			return text(await orchestration.message(child, params.message));
		},
	});

	pi.registerTool({
		name: "closeSubagent",
		label: "Close subagent",
		description:
			"Stop one of your subagents, and everything below it.\n\n" +
			"The child becomes idle and can still be woken later by messaging it.",
		promptSnippet: snippet("closeSubagent"),
		parameters: Type.Object({
			subagent: Type.String({ description: "The child's uuid" }),
			reason: Type.Optional(Type.String({ description: "Why it is being closed" })),
		}),
		async execute(_id, params) {
			const child = orchestration.findChild(params.subagent);
			if (typeof child === "string") return refused(child);
			// §9. Closing is never refused for a child that cannot run again.
			return text(await orchestration.close(child, params.reason ?? ""));
		},
	});
}

/** §9. Why a child can no longer be run, or `null` when it can. */
function unusable(tf: Taskforce, child: { sessionFile: string | null; depth: number; type: string | null }): string | null {
	const transcript = tf.supervisor
		? tf.supervisor.transcriptProblem(child.sessionFile)
		: !child.sessionFile || !existsSync(child.sessionFile)
			? "its transcript is no longer on disk"
			: null;
	if (transcript) return transcript;
	if (child.depth > tf.maxDepth) return `it sits at depth ${child.depth}, past the maximum of ${tf.maxDepth}`;
	if (child.type && !tf.catalog.byName.has(child.type)) {
		return `its type \`${child.type}\` is no longer in the catalog`;
	}
	return null;
}
