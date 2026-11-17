/**
 * §12. The answer to an ask is the result of the call that asked, not new user
 * input. A process can stop while that call is open, so the answer is written
 * as a canonical custom message and this hook puts it back where the model
 * expects it: the tool result adjacent to the original call.
 *
 * The projection is structural. The answer carries the tool call id it belongs
 * to; nothing here matches prompts, question text or position. A compaction can
 * remove the call, and then the answer stays an ordinary custom message rather
 * than being dropped. A real result already on the branch wins, except for this
 * extension's own suspended placeholder, which is the one thing the answer is
 * allowed to replace. A cancellation is a real result too.
 *
 * A queued custom message is provisional until this projection runs and the
 * request boundary sees the result in the actual request. Throwing from a
 * `context` handler is swallowed by Pi; the boundary uses the public
 * `ctx.abort()` to stop the provider.
 */

import { ANSWER_ENTRY, WAKE_ENTRY, contentText } from "./journal.js";

export interface ContextMessage {
	role?: string;
	customType?: string;
	content?: unknown;
	details?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	timestamp?: number;
	[key: string]: unknown;
}

interface Canonical {
	askId: string;
	toolCallId: string;
	text: string;
}

function canonicalOf(message: ContextMessage): Canonical | null {
	if (message.role !== "custom" || message.customType !== ANSWER_ENTRY) return null;
	const details = message.details as { askId?: unknown; toolCallId?: unknown } | undefined;
	if (!details || typeof details.askId !== "string") return null;
	if (typeof details.toolCallId !== "string" || details.toolCallId.length === 0) return null;
	return { askId: details.askId, toolCallId: details.toolCallId, text: contentText(message.content) };
}

function callsIn(message: ContextMessage): Array<{ id: string; name: string }> {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	const out: Array<{ id: string; name: string }> = [];
	for (const part of message.content) {
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: unknown; id?: unknown; name?: unknown };
		if (block.type === "toolCall" && typeof block.id === "string") {
			out.push({ id: block.id, name: typeof block.name === "string" ? block.name : "ask" });
		}
	}
	return out;
}

function isSuspended(message: ContextMessage, callId: string): boolean {
	if (message.role !== "toolResult" || message.toolCallId !== callId) return false;
	const details = message.details as { taskforceSuspended?: unknown } | undefined;
	return details?.taskforceSuspended === true;
}

/**
 * §12. Returns the messages to send for one model request. With no canonical
 * answer nothing changes. Wake messages are display-only triggers and never
 * reach the model.
 */
export function projectAskAnswers<T extends ContextMessage>(messages: readonly T[]): T[] {
	const visible = messages.filter(
		(message) => !(message.role === "custom" && message.customType === WAKE_ENTRY),
	);
	const answers = new Map<string, Canonical>();
	const duplicateAnswers = new Set<number>();
	const answerAt = new Map<number, Canonical>();
	for (let i = 0; i < visible.length; i++) {
		const canonical = canonicalOf(visible[i]!);
		if (!canonical) continue;
		answerAt.set(i, canonical);
		answers.set(canonical.toolCallId, canonical);
	}
	if (answers.size === 0) return visible;

	// The last answer for one call is the one that counts; an earlier one is a
	// duplicate representation, whichever way the call is finally represented.
	const seen = new Set<string>();
	for (let i = visible.length - 1; i >= 0; i--) {
		const canonical = answerAt.get(i);
		if (!canonical) continue;
		if (seen.has(canonical.toolCallId)) duplicateAnswers.add(i);
		seen.add(canonical.toolCallId);
	}

	const realResults = new Map<string, number>();
	for (let i = 0; i < visible.length; i++) {
		const message = visible[i]!;
		if (message.role === "toolResult" && typeof message.toolCallId === "string") {
			realResults.set(message.toolCallId, i);
		}
	}

	// Where a missing result goes: after the assistant message's whole run of
	// tool results, so siblings in a parallel batch keep their order.
	const insertAfter = new Map<number, Array<{ callId: string; name: string; text: string; askId: string }>>();
	for (let i = 0; i < visible.length; i++) {
		const calls = callsIn(visible[i]!);
		if (calls.length === 0) continue;
		let end = i;
		while (end + 1 < visible.length && visible[end + 1]!.role === "toolResult") end++;
		for (const call of calls) {
			const canonical = answers.get(call.id);
			if (!canonical) continue;
			const existing = realResults.get(call.id);
			if (existing !== undefined && !isSuspended(visible[existing]!, call.id)) continue;
			if (existing !== undefined) continue; // replaced in place below
			const list = insertAfter.get(end) ?? [];
			list.push({ callId: call.id, name: call.name, text: canonical.text, askId: canonical.askId });
			insertAfter.set(end, list);
		}
	}

	const output: T[] = [];
	for (let i = 0; i < visible.length; i++) {
		const message = visible[i]!;
		if (answerAt.has(i)) {
			const canonical = answerAt.get(i)!;
			const existing = realResults.get(canonical.toolCallId);
			const callPresent = visible.some((candidate) =>
				callsIn(candidate).some((call) => call.id === canonical.toolCallId),
			);
			// Represented once. With the call gone (compaction or a context edit),
			// the canonical answer stays as ordinary context so the answer is not lost.
			if (!duplicateAnswers.has(i) && !existing && !callPresent) output.push(message);
			continue;
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			isSuspended(message, message.toolCallId)
		) {
			const canonical = answers.get(message.toolCallId);
			if (canonical && !duplicateAnswers.has(i)) {
				const details = message.details && typeof message.details === "object" ? message.details : {};
				const { taskforceSuspended: _suspended, ...rest } = details as Record<string, unknown>;
				output.push({
					...message,
					content: [{ type: "text", text: canonical.text }],
					isError: false,
					details: { ...rest, recoveredFrom: canonical.askId },
				} as T);
				continue;
			}
		}
		output.push(message);
		for (const synthetic of insertAfter.get(i) ?? []) {
			output.push({
				role: "toolResult",
				toolCallId: synthetic.callId,
				toolName: synthetic.name,
				content: [{ type: "text", text: synthetic.text }],
				isError: false,
				details: { taskforceRecovered: true, askId: synthetic.askId },
				timestamp: Date.now(),
			} as T);
		}
	}
	return output;
}
