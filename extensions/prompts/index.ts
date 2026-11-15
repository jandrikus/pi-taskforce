/**
 * §15. What the agent reads: prompt blocks, tool descriptions and snippets.
 *
 * The tone is a colleague's, not a contract's. A TODO list is the agent's own
 * file, delegation is a tool it reaches for when it pays, and nothing here tells
 * it to stop, wait or account for itself.
 */

// ------------------------------------------------------------------- todos

/**
 * §5. The TODO block. It names the directory and the convention and never the
 * files, so it stays byte-identical for the whole session.
 */
export function todoBlock(dir: string): string {
	return `## TODO lists

For work with several steps, keep a checklist in a Markdown file in ${dir}/.
Name it YYYY-MM-DD-<slug>.md, start it with a "# " title, and write one "- [ ]" item per step.
Tick an item "- [x]" when it is done, and put notes in plain text under the item they belong to.
New work gets a new file; a finished list stays as the record of that work.
When picking up earlier work, list the directory and continue the matching file instead of starting another.
Edit the file with your ordinary file tools. The user may edit it too, so read it again before you change it.
Skip the list for quick, single-step work.`;
}

// --------------------------------------------------------------- subagents

/**
 * §15. How a launch is named to a reader: the child that runs on it, and the
 * parent reading a report. One wording, so nobody has to go and look it up.
 */
export function describeLaunch(
	model: { provider: string; id: string } | null,
	thinking: string | null,
): string | null {
	if (!model) return null;
	const level = thinking ? ` at thinking level \`${thinking}\`` : "";
	return `\`${model.provider}/${model.id}\`${level}`;
}

export const ORCHESTRATION_BLOCK = `## Subagents

Use delegate to start a subagent with its own context. Give it a goal and optionally a type; the default
type is general. Unless you fork, it knows only what you put in the goal, so say what to do, where, and
what a good result looks like. Its final message comes back to you as its report.

Keep investigation, implementation and verification in one agent loop by default.
Use compaction for long work when available; size, file count and context length alone do not justify delegation.
Delegate for independent judgment, a bounded investigation whose raw detail need not enter this conversation,
or independent work with a clear time benefit after coordination and integration. Keep coupled implementation together.
If repeated clarification or shared-file reconciliation consumes that benefit, stop the child and bring the work back.
Parallel tool calls, task tracking and user questions do not require delegation.

Delegation takes three optional controls; omitted controls use the selected type's defaults:
- \`background\`: false waits for the report. true returns at once and the report arrives later as a
  message; meanwhile you can keep working, start others, or end your turn. A report never cuts into a
  turn: it waits until your turn ends, so do not poll or sleep for it.
- \`fork\`: true starts the child with a copy of your conversation. Use it when your context matters, and
  leave it off for a clean, cheaper start.
- \`thinking\`: how hard the child thinks.

A subagent keeps no TODO list of its own. If its work belongs to one of yours, tick that item when its
report is in.

Follow up or steer with messageSubagent; a finished child picks up again from its own transcript. Stop one
with closeSubagent, and find them again with listSubagents. You address only the subagents you started.`;

export const SUBAGENT_TOOL_SNIPPETS = {
	listSubagents: "List the subagents you have started, with their status and context use",
	messageSubagent: "Steer a subagent or ask it a follow-up, waking it if it has finished",
	closeSubagent: "Stop a subagent and everything below it",
} as const;

export const SUBAGENT_GUIDELINES: string[] = [
	"Read a subagent's report critically before you build on it. If something is missing or wrong, ask it with messageSubagent rather than redoing its work.",
	"Close a subagent with closeSubagent when you no longer need its work, or when you decide to do the work yourself.",
];

// --------------------------------------------------------------------- ask

export const ASK_DESCRIPTION = `Ask for a decision you cannot make yourself.

Put every question into one call: one ask is one interruption. A question can be a select, a multiselect,
free text or a yes/no confirm; leave the type out and it is inferred from whether you gave options.

At the top the user answers. Inside a subagent, the agent that started you reads the question and
answers it, or asks the user itself.

An omitted or unanswered question is not an error: carry on with your best judgment and say what you
assumed.`;

export const ASK_SNIPPET = "Ask the user, or the agent that started you, for a decision you cannot make yourself";

export const ASK_GUIDELINES: string[] = [
	"Use ask when a decision is not yours to make and a wrong guess would waste real work. Do not use it to confirm things you can check yourself.",
	"When ask comes back omitted or unanswered, carry on with your best judgment and state the assumption.",
];

export const ANSWER_SUBAGENT_DESCRIPTION = `Answer a question one of your subagents asked you.

Take the reference from the question message and give one answer per question. If the answer is the
user's to give, call ask yourself first; if you can find it out, find it out and then answer. The
subagent stays paused until you do.`;

// ------------------------------------------------------------- placement

/**
 * §15. The last block appended to the system prompt: it is the block most likely
 * to differ between two runs of the same agent, and keeping it last leaves the
 * longest identical prefix for the provider's cache.
 */
export function placementBlock(options: {
	depth: number;
	maxDepth: number;
	parentUuid: string | null;
	canSpawn: boolean;
}): string {
	const lines: string[] = [];
	if (options.parentUuid) {
		lines.push("## Your report");
		lines.push(
			`Another agent (\`${options.parentUuid}\`) started you for this work. When you stop, your final ` +
				"message is your report to it, and it is the only part of your work it reads. Put the whole result " +
				"there: what you found or changed, how you checked it, and anything left open or uncertain. A " +
				"partial result is fine when you say what is missing.",
		);
	}
	if (!options.canSpawn && options.depth >= options.maxDepth) {
		lines.push(`You are at the maximum subagent depth (${options.maxDepth}), so you do this work yourself.`);
	}
	return lines.join("\n\n");
}

// ---------------------------------------------------------------- resuming

/** §9. A restarted child is asked to read back over its restored context before acting. */
export function continueMessage(): string {
	return [
		"You are being resumed from your own transcript. Read back over it before you act: some of what you",
		"were doing may already be done.",
	].join("\n");
}
