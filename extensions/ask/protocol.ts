/**
 * §13. Where a question goes.
 *
 * A subagent has no terminal of its own, so its ask is delivered whole to the
 * agent that spawned it. The only synchronous round trip between a child pi
 * process and its host is the extension UI protocol, so an ask travels as one
 * `input` dialog whose title carries the ask, and the answer comes back as that
 * dialog's value. Any other dialog a child extension opens is declined, because
 * only an ask has somewhere to go.
 */

import type { Ask, AskResult } from "./schema.js";

/** Marks a dialog request as a taskforce ask rather than an ordinary dialog. */
export const ASK_MARKER = "\u0000pi-taskforce/ask\u0000";

export interface AskEnvelope {
	/** The agent the question came from, which the TUI names (§13). */
	from: { agentId: string; agentType: string; depth: number };
	/**
	 * The agents a relayed question passed through, nearest the receiver first.
	 * Set by the receiving parent from its own records, never trusted as sent.
	 */
	via?: Array<{ agentId: string; agentType: string; depth: number }>;
	/** True when every spawn on the path from the root used `fork: true` (§13). */
	asksUserDirectly: boolean;
	ask: Ask;
}

export function encodeAsk(envelope: AskEnvelope): string {
	return ASK_MARKER + JSON.stringify(envelope);
}

export function decodeAsk(title: unknown): AskEnvelope | null {
	if (typeof title !== "string" || !title.startsWith(ASK_MARKER)) return null;
	try {
		const parsed = JSON.parse(title.slice(ASK_MARKER.length)) as AskEnvelope;
		if (!parsed || typeof parsed !== "object" || !parsed.ask) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function encodeAskResult(result: AskResult): string {
	return JSON.stringify(result);
}

export function decodeAskResult(value: unknown): AskResult | null {
	if (typeof value !== "string") return null;
	try {
		const parsed = JSON.parse(value) as AskResult;
		if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.answers)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** An ask nobody could render, or whose run has ended, is answered as cancelled (§13). */
export const CANCELLED_RESULT: AskResult = { outcome: "cancelled", answers: [] };
export const UNATTENDED_RESULT: AskResult = { outcome: "unattended", answers: [] };
