/**
 * §12. The journal that makes a question outlive the process that asked it.
 *
 * Three custom entries carry everything that has to survive a restart:
 *
 *   pi-taskforce-ask-pending   the question, written before it is shown
 *   pi-taskforce-ask-draft     what the user has picked and typed so far
 *   pi-taskforce-ask-submit    the answers the user sent, written before the send
 *   pi-taskforce-ask-dispatch  the process that called sendUserMessage, written
 *                              immediately before the call
 *   pi-taskforce-ask-done      the question is finished, because it was answered,
 *                              cancelled on purpose, or recovered into a new turn
 *
 * Entries are appended to the session, never to a side file, so a fork copies
 * them and the branch rule is the session's own: a question is restored only on
 * the branch and in the session that wrote it. A `done` entry ends an ask for
 * good: a later scan cannot resurrect it, and the old entries stay readable as
 * history instead of warning again.
 *
 * What a restart loses is bounded by the draft debounce: a graceful close flushes
 * every draft, and an abrupt kill can lose at most the last second of typing.
 */

import type { AskEnvelope } from "./protocol.js";
import type { Ask, AskResult } from "./schema.js";
import { validateAsk } from "./schema.js";

export const PENDING_ENTRY = "pi-taskforce-ask-pending";
export const DRAFT_ENTRY = "pi-taskforce-ask-draft";
export const SUBMIT_ENTRY = "pi-taskforce-ask-submit";
export const DISPATCH_ENTRY = "pi-taskforce-ask-dispatch";
export const DONE_ENTRY = "pi-taskforce-ask-done";

/** How long typing may wait before it reaches the session, at most. */
export const DRAFT_DEBOUNCE_MS = 1000;

export interface DraftAnswer {
	/** Text typed into a text question, or into an option question's own field. */
	typed?: string;
	/** Option values picked for a select or multiselect question. */
	picked?: string[];
	/** Values typed into a multiselect question, next to the picked options. */
	extras?: string[];
	/** The user chose to let the agent decide. */
	skipped?: boolean;
	note?: string;
}

export interface AskDraft {
	/** The question on screen: a question position, or the review position. */
	index: number;
	at: number;
	answers: Record<string, DraftAnswer>;
}

export interface PendingAskRecord {
	v: 1;
	id: string;
	sessionId: string | null;
	createdAt: number;
	ask: Ask;
	from: AskEnvelope["from"];
	via?: AskEnvelope["via"];
	attribution: string | null;
}

export interface DoneAskRecord {
	v: 1;
	id: string;
	at: number;
	how: "answered" | "cancelled" | "unattended" | "recovered" | "discarded";
}

export interface SubmitAskRecord {
	v: 1;
	id: string;
	at: number;
	by: "terminal" | "remote";
	result: AskResult;
	sessionId?: string | null;
}

/**
 * The moment a recovered answer leaves the process. Written before
 * `sendUserMessage()` is called, so an unconfirmed delivery is never mistaken
 * for one that never happened. `token` identifies the process (see process.ts):
 * the same token after a reload means the message may still arrive.
 */
export interface DispatchAskRecord {
	v: 1;
	id: string;
	sessionId: string | null;
	at: number;
	token: string;
}

export interface RecoveredAsk {
	pending: PendingAskRecord;
	draft: AskDraft | null;
	/** Answers the user already sent, kept so a lost delivery loses nothing. */
	submitted: SubmitAskRecord | null;
	/** The process that dispatched those answers, when one did. */
	dispatch: DispatchAskRecord | null;
}

/**
 * The line every recovered message carries. It is the only proof that the
 * message reached the session: `pi.sendUserMessage()` returns void and reports
 * failures elsewhere, so the entry itself is the acknowledgement.
 */
export function recoveryMarker(id: string): string {
	return `pi-taskforce-recovery:${id}`;
}

/** Asks whose recovered answers are already a user message on this branch. */
export function deliveredRecoveries(entries: readonly EntryLike[]): Set<string> {
	const delivered = new Set<string>();
	const pattern = /pi-taskforce-recovery:(ask-[0-9a-zA-Z-]+)/g;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
		if (!message || message.role !== "user") continue;
		const text = messageText(message.content);
		if (!text.includes("pi-taskforce-recovery:")) continue;
		for (const match of text.matchAll(pattern)) delivered.add(match[1]!);
	}
	return delivered;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" ? String((part as { text?: unknown }).text ?? "") : ""))
		.join("\n");
}

export interface AskJournalScan {
	/** Pending asks in the order they were asked, latest draft attached. */
	pending: RecoveredAsk[];
	/** Every ask this branch finished, by id. */
	done: Map<string, DoneAskRecord>;
}

export interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
}

/** Reads the ask entries of one branch, in branch order. */
export function scanAsks(entries: readonly EntryLike[]): AskJournalScan {
	const open = new Map<string, RecoveredAsk>();
	const done = new Map<string, DoneAskRecord>();

	for (const entry of entries) {
		if (entry.type !== "custom") continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (!data || data.v !== 1 || typeof data.id !== "string") continue;

		if (entry.customType === PENDING_ENTRY) {
			const pending = pendingRecord(data);
			if (pending) open.set(pending.id, { pending, draft: null, submitted: null, dispatch: null });
			continue;
		}
		if (entry.customType === DRAFT_ENTRY) {
			const draft = draftRecord(data);
			const current = open.get(data.id);
			if (!draft || !current) continue;
			// Entries are append-only, so the last one read is the newest.
			if (!current.draft || draft.at >= current.draft.at) current.draft = draft;
			continue;
		}
		if (entry.customType === SUBMIT_ENTRY) {
			const submit = submitRecord(data);
			const current = open.get(data.id);
			if (!submit || !current) continue;
			// The send may have failed: the answers it carried are still the newest
			// state of the question, and they are what a restart gets back.
			current.submitted = submit;
			const draft = draftFromSubmit(submit, current.pending.ask);
			if (!current.draft || draft.at >= current.draft.at) current.draft = draft;
			continue;
		}
		if (entry.customType === DISPATCH_ENTRY) {
			const dispatch = dispatchRecord(data);
			const current = open.get(data.id);
			if (!dispatch || !current) continue;
			// A dispatch record is only ever appended once per send; the last one
			// read is the attempt that may still be in flight.
			current.dispatch = dispatch;
			continue;
		}
		if (entry.customType === DONE_ENTRY) {
			const record = doneRecord(data);
			if (!record) continue;
			done.set(record.id, record);
			open.delete(record.id);
		}
	}

	return { pending: [...open.values()].sort((a, b) => a.pending.createdAt - b.pending.createdAt), done };
}

/**
 * §12. Only this session's own questions come back. A fork copies the parent's
 * entries, and those belong to the parent's session: its question is not asked
 * again in a branch that merely starts from the same conversation.
 */
export function recoverableAsks(entries: readonly EntryLike[], sessionId: string | null): RecoveredAsk[] {
	const scan = scanAsks(entries);
	return scan.pending.filter((ask) => sessionId !== null && ask.pending.sessionId === sessionId);
}

function pendingRecord(data: Record<string, unknown>): PendingAskRecord | null {
	const raw = data.ask as { context?: unknown; questions?: unknown } | undefined;
	const checked = validateAsk(raw?.context, raw?.questions);
	if (!checked.ok) return null;
	const from = data.from as Partial<AskEnvelope["from"]> | undefined;
	if (!from || typeof from.agentId !== "string" || typeof from.agentType !== "string" || typeof from.depth !== "number") {
		return null;
	}
	return {
		v: 1,
		id: data.id as string,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
		ask: checked.ask,
		from: { agentId: from.agentId, agentType: from.agentType, depth: from.depth },
		via: Array.isArray(data.via) ? (data.via as AskEnvelope["via"]) : [],
		attribution: typeof data.attribution === "string" ? data.attribution : null,
	};
}

function draftRecord(data: Record<string, unknown>): AskDraft | null {
	if (typeof data.at !== "number" || typeof data.index !== "number") return null;
	const answers: Record<string, DraftAnswer> = {};
	const raw = data.answers;
	if (raw && typeof raw === "object") {
		for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
			if (!value || typeof value !== "object") continue;
			const answer = value as Record<string, unknown>;
			answers[id] = {
				typed: typeof answer.typed === "string" ? answer.typed : undefined,
				picked: Array.isArray(answer.picked) ? answer.picked.filter((v) => typeof v === "string") : undefined,
				extras: Array.isArray(answer.extras) ? answer.extras.filter((v) => typeof v === "string") : undefined,
				skipped: answer.skipped === true,
				note: typeof answer.note === "string" ? answer.note : undefined,
			};
		}
	}
	return { index: Math.max(0, Math.floor(data.index)), at: data.at, answers };
}

function submitRecord(data: Record<string, unknown>): SubmitAskRecord | null {
	if (typeof data.at !== "number") return null;
	if (data.by !== "terminal" && data.by !== "remote") return null;
	const raw = data.result as { outcome?: unknown; answers?: unknown } | undefined;
	if (!raw || (raw.outcome !== "answered" && raw.outcome !== "cancelled")) return null;
	if (!Array.isArray(raw.answers)) return null;
	const answers: AskResult["answers"] = [];
	for (const item of raw.answers) {
		if (!item || typeof item !== "object") return null;
		const answer = item as Record<string, unknown>;
		if (typeof answer.id !== "string") return null;
		const values = Array.isArray(answer.values) ? answer.values.filter((v) => typeof v === "string") : [];
		const labels = Array.isArray(answer.labels) ? answer.labels.filter((v) => typeof v === "string") : [];
		answers.push({
			id: answer.id,
			values: values as string[],
			labels: labels as string[],
			typed: answer.typed === true,
			omitted: answer.omitted === true,
			note: typeof answer.note === "string" ? answer.note : null,
		});
	}
	return {
		v: 1,
		id: data.id as string,
		at: data.at,
		by: data.by,
		result: { outcome: raw.outcome, answers },
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
	};
}

function dispatchRecord(data: Record<string, unknown>): DispatchAskRecord | null {
	if (typeof data.at !== "number") return null;
	if (typeof data.token !== "string" || data.token.length === 0) return null;
	return {
		v: 1,
		id: data.id as string,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		at: data.at,
		token: data.token,
	};
}

/**
 * The answers that were submitted become the draft a restart opens with. Values
 * that name an option are picks; anything else was typed by the user.
 */
export function draftFromSubmit(submit: SubmitAskRecord, ask: Ask): AskDraft {
	const answers: Record<string, DraftAnswer> = {};
	for (const question of ask.questions) {
		const answer = submit.result.answers.find((candidate) => candidate.id === question.id);
		if (!answer) continue;
		const draft: DraftAnswer = {};
		if (answer.omitted) draft.skipped = true;
		if (question.type === "multiselect") {
			const picked = answer.values.filter((value) => question.options.some((option) => option.value === value));
			const extras = answer.values.filter((value) => !question.options.some((option) => option.value === value));
			if (picked.length > 0) draft.picked = picked;
			if (extras.length > 0) draft.extras = extras;
		} else if (question.options.length > 0) {
			const picked = answer.values.filter((value) => question.options.some((option) => option.value === value));
			const typed = answer.values.filter((value) => !question.options.some((option) => option.value === value));
			if (picked.length > 0) draft.picked = picked;
			if (typed.length > 0) draft.typed = typed.join(", ");
		} else if (answer.values.length > 0) {
			draft.typed = answer.values.join("\n");
		}
		if (answer.note) draft.note = answer.note;
		answers[question.id] = draft;
	}
	// Review is the last position for a multi-question ask, where every answer is
	// on screen at once; a single question restores on itself.
	const index = ask.questions.length > 1 ? ask.questions.length : 0;
	return { index, at: submit.at, answers };
}

function doneRecord(data: Record<string, unknown>): DoneAskRecord | null {
	if (typeof data.at !== "number") return null;
	const how = data.how;
	if (how !== "answered" && how !== "cancelled" && how !== "unattended" && how !== "recovered" && how !== "discarded") {
		return null;
	}
	return { v: 1, id: data.id as string, at: data.at, how };
}

/**
 * §12. Recovered answers are new input for the root, not the answer to a call
 * that no longer exists. The message says what was asked, who asked it, what was
 * answered and what was left out, and that the original wait is gone.
 */
export function recoveredMessage(pending: PendingAskRecord, result: AskResult): string {
	const lines: string[] = [
		"Answers to questions recovered from the previous run",
		"",
		"pi stopped before this question was answered, so the call that asked it is no longer live.",
		"These answers are new input for this run, not the result of that old call.",
		"",
	];
	const from = pending.from;
	lines.push(`Asked by: ${from.agentType} (${from.agentId})`);
	if (pending.attribution) lines.push(`Path: ${pending.attribution}`);
	if (from.agentType !== "root" || (pending.via?.length ?? 0) > 0) {
		lines.push("The asker was a subagent and is not running any more. This answer goes to the root agent.");
	}
	if (pending.ask.context) lines.push("", pending.ask.context);
	lines.push("");

	const byId = new Map(result.answers.map((answer) => [answer.id, answer]));
	pending.ask.questions.forEach((question, i) => {
		const answer = byId.get(question.id);
		lines.push(`${i + 1}. ${question.prompt}`);
		if (!answer || answer.omitted || answer.values.length === 0) {
			lines.push("   Answer: skipped, the agent decides");
		} else {
			const labels = answer.labels.length > 0 ? answer.labels : answer.values;
			lines.push(`   Answer: ${labels.join(", ")}`);
		}
		if (answer?.note) lines.push(`   Note: ${answer.note}`);
	});
	lines.push("", `[${recoveryMarker(pending.id)}]`);
	return lines.join("\n");
}
