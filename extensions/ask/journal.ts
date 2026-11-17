/**
 * §12. The journal that makes a question outlive the process that asked it.
 *
 * The journal entries carry everything that has to survive a restart:
 *
 *   pi-taskforce-ask-pending        the question and the call that asked it,
 *                                   written before it is shown
 *   pi-taskforce-ask-draft          what the user has picked and typed so far
 *   pi-taskforce-ask-submit         the answers the user sent, written first
 *   pi-taskforce-ask-send-attempt   the canonical answer is about to be written
 *   pi-taskforce-ask-wake-attempt   one continuation request
 *   pi-taskforce-ask-visible        the answer was in a request the model received
 *   pi-taskforce-ask-done           the question is finished
 *
 * The answer itself is not a custom entry: it is a custom *message*
 * (`pi-taskforce-ask-answer`) carrying the original tool call id, so the model
 * sees it as that call's result instead of new user input. A wake message is a
 * display-only trigger and never reaches the model.
 *
 * Entries are appended to the session, never to a side file, so a fork copies
 * them and the branch rule is the session's own: a question is restored only on
 * the branch and in the session that wrote it. A `done` entry removes an ask from
 * the offerable-question list once its canonical answer or real tool result is
 * also on the branch, but the completed canonical answer remains in the journal
 * inventory: it still owns a request result and, if unconsumed, a continuation.
 * A done marker written before a deferred canonical message does not discard the
 * submit WAL; the next scan keeps the question until the answer is observed. A v1
 * journal with no call id cannot be put back in the right place; its draft is kept
 * and it stays available through /questions for editing and copying, but it is
 * not offered as a live question.
 *
 * Effects are write-ahead too. A canonical message is preceded by
 * `pi-taskforce-ask-send-attempt`, and a wake by `pi-taskforce-ask-wake-attempt`.
 * Both carry the process identity: a `/reload` keeps it, a new process gets a
 * new one. An attempt from this process that is not observed is guarded, not
 * repeated; a new process may reapply it because the old one cannot deliver.
 * `pi-taskforce-ask-visible` records that a request actually projected the
 * answer. Proofs for answers in the same request share a request id, so one
 * answer's marker is not mistaken for a new request. Only an assistant response
 * after a proof consumes the answer. A recovered
 * child's request boundary checks the actual projected result before the
 * provider; a queued custom message is provisional until then.
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
export const DONE_ENTRY = "pi-taskforce-ask-done";
/** Written before the canonical message: this process is attempting the write. */
export const SEND_ATTEMPT_ENTRY = "pi-taskforce-ask-send-attempt";
/** The canonical answer was part of a real model request on this branch. */
export const VISIBLE_ENTRY = "pi-taskforce-ask-visible";
/**
 * §12. The canonical answer is a custom message, not a custom entry: it is the
 * answer the model reads. It carries the structural link back to the call that
 * asked, so a restart projects it as that call's tool result instead of adding
 * new user input.
 */
export const ANSWER_ENTRY = "pi-taskforce-ask-answer";
/** A custom message that starts the continuation turn; it carries no answer. */
export const WAKE_ENTRY = "pi-taskforce-ask-wake";
/** One continuation attempt for one ask on one branch. */
export const WAKE_ATTEMPT_ENTRY = "pi-taskforce-ask-wake-attempt";

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
	/** 2 carries the original call; 1 is a journal written before answers could be linked. */
	v: 1 | 2;
	id: string;
	sessionId: string | null;
	createdAt: number;
	ask: Ask;
	from: AskEnvelope["from"];
	via?: AskEnvelope["via"];
	attribution: string | null;
	/** The `ask` tool call this question belongs to; absent on a legacy journal. */
	toolCallId: string | null;
	/** The assistant entry that made the call, so a fork cannot claim it. */
	assistantEntryId: string | null;
}

/** A canonical answer as it is read back from a custom message entry. */
export interface CanonicalAnswer {
	askId: string;
	outcome: AskResult["outcome"];
	toolCallId: string | null;
	assistantEntryId: string | null;
	sessionId: string | null;
	from: AskEnvelope["from"] | null;
	text: string;
	entryId: string | null;
	at: number;
}

export interface DoneAskRecord {
	v: 1;
	id: string;
	at: number;
	how: "answered" | "cancelled" | "unattended" | "recovered" | "discarded";
}

export interface SubmitAskRecord {
	/** 2 carries a stable submission identity; 1 is an older journal. */
	v: 1 | 2;
	id: string;
	at: number;
	by: "terminal" | "remote";
	result: AskResult;
	sessionId?: string | null;
	/** The immutable payload identity: a generated id, or the entry id for v1. */
	submitId?: string;
}

/** A canonical write this process tried, recorded before the effect. */
export interface SendAttemptRecord {
	v: 1;
	id: string;
	at: number;
	toolCallId: string;
	sessionId: string | null;
	process: string;
	submitId: string;
}

/** A continuation request. v1 records predate process identity. */
export interface WakeAttemptRecord {
	v: 1 | 2;
	id: string;
	at: number;
	toolCallId?: string | null;
	sessionId?: string | null;
	process?: string;
	canonicalEntryId?: string | null;
}

/** The answer was visible in a request the model actually received. */
export interface VisibleAnswerRecord {
	v: 1 | 2;
	id: string;
	at: number;
	toolCallId?: string | null;
	/** §12. The request this proof belongs to; several answers can share one. */
	request?: string;
}

export interface SeenAnswerRecord extends VisibleAnswerRecord {
	entryId: string | null;
}

export interface RecoveredAsk {
	pending: PendingAskRecord;
	draft: AskDraft | null;
	/** The done marker on this branch, if the question has one. */
	done: DoneAskRecord | null;
	/** Answers the user already sent, kept so a lost materialisation loses nothing. */
	submitted: SubmitAskRecord | null;
	/** The canonical answer already on the branch, when one is. */
	canonical: CanonicalAnswer | null;
	/** A real tool result for this call is on the branch; the live call finished. */
	realResult: boolean;
	/** The real tool result is this extension's own suspended placeholder. */
	suspended: boolean;
	/** The latest canonical-write attempt for this question on this branch. */
	sendAttempt: SendAttemptRecord | null;
	/** Continuation requests found on this branch. */
	wakeAttempts: WakeAttemptRecord[];
	/** An old v1 continuation record without process identity. */
	legacyWakeAttempt: boolean;
	/** The latest proof that the answer was visible to a model request. */
	seen: SeenAnswerRecord | null;
}

export interface AskJournalScan {
	/** Pending asks in the order they were asked, latest draft attached. */
	pending: RecoveredAsk[];
	/** Every ask named on this branch, including finished ones with an answer. */
	all: RecoveredAsk[];
	/** Every finished ask, by id. */
	done: Map<string, DoneAskRecord>;
}

export interface EntryLike {
	type?: string;
	customType?: string;
	data?: unknown;
	id?: string;
	message?: unknown;
	details?: unknown;
	content?: unknown;
	display?: boolean;
}

function recordVersion(data: Record<string, unknown>): 1 | 2 | null {
	return data.v === 1 || data.v === 2 ? data.v : null;
}

/** Reads the ask entries of one branch, in branch order. */
export function scanAsks(entries: readonly EntryLike[]): AskJournalScan {
	const open = new Map<string, RecoveredAsk>();
	const done = new Map<string, DoneAskRecord>();
	const canonical = new Map<string, CanonicalAnswer>();
	const sendAttempts = new Map<string, SendAttemptRecord>();
	const wakeAttempts = new Map<string, WakeAttemptRecord[]>();
	const legacyWake = new Set<string>();
	const seen = new Map<string, SeenAnswerRecord>();
	const results = new Map<string, { suspended: boolean }>();

	for (const entry of entries) {
		if (entry.type === "custom_message" && entry.customType === ANSWER_ENTRY) {
			const answer = canonicalRecord(entry);
			if (answer) {
				// Append-only: the last answer for one ask is the one that counts.
				canonical.set(answer.askId, answer);
				if (answer.toolCallId) canonical.set(`call:${answer.toolCallId}`, answer);
			}
			continue;
		}
		if (entry.type === "message") {
			const message = entry.message as
				| { role?: unknown; toolCallId?: unknown; details?: unknown }
				| undefined;
			if (message?.role !== "toolResult" || typeof message.toolCallId !== "string") continue;
			const details = message.details as { taskforceSuspended?: unknown } | undefined;
			results.set(message.toolCallId, { suspended: details?.taskforceSuspended === true });
			continue;
		}
		if (entry.type !== "custom") continue;
		const data = entry.data as Record<string, unknown> | undefined;
		if (!data || !recordVersion(data) || typeof data.id !== "string") continue;

		if (entry.customType === PENDING_ENTRY) {
			const pending = pendingRecord(data);
			if (pending) {
				open.set(pending.id, {
					pending,
					draft: null,
					done: null,
					submitted: null,
					canonical: null,
					realResult: false,
					suspended: false,
					sendAttempt: null,
					wakeAttempts: [],
					legacyWakeAttempt: false,
					seen: null,
				});
			}
			continue;
		}
		if (entry.customType === SEND_ATTEMPT_ENTRY) {
			const attempt = sendAttemptRecord(data, entry.id ?? null);
			if (attempt) sendAttempts.set(attempt.id, attempt);
			continue;
		}
		if (entry.customType === WAKE_ATTEMPT_ENTRY) {
			const attempt = wakeAttemptRecord(data, entry.id ?? null);
			if (!attempt) continue;
			const list = wakeAttempts.get(attempt.id) ?? [];
			list.push(attempt);
			wakeAttempts.set(attempt.id, list);
			if (!attempt.process) legacyWake.add(attempt.id);
			continue;
		}
		if (entry.customType === VISIBLE_ENTRY) {
			const visible = visibleRecord(data, entry.id ?? null);
			if (visible) seen.set(visible.id, visible);
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
			const submit = submitRecord(data, entry.id ?? null);
			const current = open.get(data.id);
			if (!submit || !current) continue;
			// The first submission fixes the payload. Later submissions cannot replace
			// what an effect may already have carried; an older v1 journal is still
			// read so its answers are not lost.
			if (!current.submitted) {
				current.submitted = submit;
				const draft = draftFromSubmit(submit, current.pending.ask);
				if (!current.draft || draft.at >= current.draft.at) current.draft = draft;
			}
			continue;
		}
		if (entry.customType === DONE_ENTRY) {
			const record = doneRecord(data);
			if (!record) continue;
			done.set(record.id, record);
		}
	}

	const all = new Map<string, RecoveredAsk>();
	for (const [id, recovered] of [...open]) {
		// An answer with no call id cannot be projected anywhere, so it is not
		// treated as the answer to this question.
		const answer =
			canonical.get(recovered.pending.id) ??
			(recovered.pending.toolCallId ? canonical.get(`call:${recovered.pending.toolCallId}`) : undefined);
		recovered.canonical = answer?.toolCallId ? answer : null;
		recovered.sendAttempt = sendAttempts.get(recovered.pending.id) ?? null;
		recovered.wakeAttempts = wakeAttempts.get(recovered.pending.id) ?? [];
		recovered.legacyWakeAttempt = legacyWake.has(recovered.pending.id);
		recovered.seen = seen.get(recovered.pending.id) ?? null;
		recovered.done = done.get(recovered.pending.id) ?? null;
		if (recovered.pending.toolCallId) {
			const result = results.get(recovered.pending.toolCallId);
			recovered.realResult = result !== undefined;
			recovered.suspended = result?.suspended === true;
		}
		all.set(id, recovered);
		const finished = recovered.canonical !== null || (recovered.realResult && !recovered.suspended);
		// A done marker can arrive before the canonical message during a deferred
		// send (or from a legacy write). With journalled answers but no result and
		// no cancellation evidence, the WAL still has work to finish; do not let
		// the marker discard it. A live tool result and an explicit canonical
		// cancellation are both real evidence that the call finished.
		if (done.has(id) && (finished || !recovered.submitted)) open.delete(id);
	}

	const byCreation = (a: RecoveredAsk, b: RecoveredAsk) => a.pending.createdAt - b.pending.createdAt;
	return { pending: [...open.values()].sort(byCreation), all: [...all.values()].sort(byCreation), done };
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

/** §12. Every ask named on this branch, finished or not, for request/continuation checks. */
export function journalAsks(entries: readonly EntryLike[], sessionId: string | null): RecoveredAsk[] {
	const scan = scanAsks(entries);
	return scan.all.filter((ask) => sessionId !== null && ask.pending.sessionId === sessionId);
}

/** §12. Old journals are preserved but cannot be linked to the call that asked. */
export function legacyAsks(entries: readonly EntryLike[], sessionId: string | null): RecoveredAsk[] {
	const scan = scanAsks(entries);
	return scan.pending.filter(
		(ask) =>
			sessionId !== null &&
			ask.pending.sessionId === sessionId &&
			ask.pending.toolCallId === null &&
			ask.pending.v === 1,
	);
}

/** A canonical answer entry, whichever process wrote it. */
function canonicalRecord(entry: EntryLike): CanonicalAnswer | null {
	const raw = entry.details as Record<string, unknown> | undefined;
	if (!raw || typeof raw.askId !== "string") return null;
	const from = raw.from as Partial<AskEnvelope["from"]> | undefined;
	return {
		askId: raw.askId,
		outcome:
			raw.outcome === "cancelled" || raw.outcome === "unattended" || raw.outcome === "answered"
				? raw.outcome
				: "answered",
		toolCallId: typeof raw.toolCallId === "string" ? raw.toolCallId : null,
		assistantEntryId: typeof raw.assistantEntryId === "string" ? raw.assistantEntryId : null,
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : null,
		from:
			from && typeof from.agentId === "string" && typeof from.agentType === "string" && typeof from.depth === "number"
				? { agentId: from.agentId, agentType: from.agentType, depth: from.depth }
				: null,
		text: contentText(entry.content),
		entryId: typeof entry.id === "string" ? entry.id : null,
		at: typeof raw.at === "number" ? raw.at : 0,
	};
}

/** The canonical answer for one ask, independent of whether a done marker came first. */
export function canonicalFor(
	entries: readonly EntryLike[],
	askId: string,
	toolCallId: string | null,
): CanonicalAnswer | null {
	let found: CanonicalAnswer | null = null;
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== ANSWER_ENTRY) continue;
		const answer = canonicalRecord(entry);
		if (!answer) continue;
		if (answer.askId === askId || (toolCallId !== null && answer.toolCallId === toolCallId)) found = answer;
	}
	return found;
}

/** The last real tool result for a call, or null. */
export function resultFor(entries: readonly EntryLike[], toolCallId: string): { suspended: boolean } | null {
	let found: { suspended: boolean } | null = null;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: unknown; toolCallId?: unknown; details?: unknown } | undefined;
		if (message?.role !== "toolResult" || message.toolCallId !== toolCallId) continue;
		const details = message.details as { taskforceSuspended?: unknown } | undefined;
		found = { suspended: details?.taskforceSuspended === true };
	}
	return found;
}

export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			part && typeof part === "object" && (part as { type?: unknown }).type === "text"
				? String((part as { text?: unknown }).text ?? "")
				: "",
		)
		.filter(Boolean)
		.join("\n");
}

export function pendingRecord(data: Record<string, unknown>): PendingAskRecord | null {
	const raw = data.ask as { context?: unknown; questions?: unknown } | undefined;
	const checked = validateAsk(raw?.context, raw?.questions);
	if (!checked.ok) return null;
	const from = data.from as Partial<AskEnvelope["from"]> | undefined;
	if (!from || typeof from.agentId !== "string" || typeof from.agentType !== "string" || typeof from.depth !== "number") {
		return null;
	}
	const version = recordVersion(data);
	if (!version) return null;
	return {
		v: version,
		id: data.id as string,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		createdAt: typeof data.createdAt === "number" ? data.createdAt : 0,
		ask: checked.ask,
		from: { agentId: from.agentId, agentType: from.agentType, depth: from.depth },
		via: Array.isArray(data.via) ? (data.via as AskEnvelope["via"]) : [],
		attribution: typeof data.attribution === "string" ? data.attribution : null,
		toolCallId: typeof data.toolCallId === "string" && data.toolCallId.length > 0 ? data.toolCallId : null,
		assistantEntryId:
			typeof data.assistantEntryId === "string" && data.assistantEntryId.length > 0 ? data.assistantEntryId : null,
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

function submitRecord(data: Record<string, unknown>, entryId: string | null): SubmitAskRecord | null {
	if (typeof data.at !== "number") return null;
	if (data.by !== "terminal" && data.by !== "remote") return null;
	const raw = data.result as { outcome?: unknown; answers?: unknown } | undefined;
	if (!raw || (raw.outcome !== "answered" && raw.outcome !== "cancelled" && raw.outcome !== "unattended")) {
		return null;
	}
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
		v: data.v === 2 ? 2 : 1,
		id: data.id as string,
		at: data.at,
		by: data.by,
		result: { outcome: raw.outcome, answers },
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		// A v1 journal never carried an identity; its persisted entry id is stable
		// and is not confused by two writes in the same millisecond.
		submitId:
			typeof data.submitId === "string" && data.submitId.length > 0
				? data.submitId
				: entryId ?? `at:${data.at}`,
	};
}

function sendAttemptRecord(data: Record<string, unknown>, _entryId: string | null): SendAttemptRecord | null {
	if (
		typeof data.id !== "string" ||
		typeof data.toolCallId !== "string" ||
		typeof data.process !== "string" ||
		typeof data.submitId !== "string"
	) {
		return null;
	}
	return {
		v: 1,
		id: data.id,
		at: typeof data.at === "number" ? data.at : 0,
		toolCallId: data.toolCallId,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		process: data.process,
		submitId: data.submitId,
	};
}

function wakeAttemptRecord(data: Record<string, unknown>, _entryId: string | null): WakeAttemptRecord | null {
	if (typeof data.id !== "string") return null;
	return {
		v: data.v === 2 ? 2 : 1,
		id: data.id,
		at: typeof data.at === "number" ? data.at : 0,
		toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
		sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
		process: typeof data.process === "string" && data.process.length > 0 ? data.process : undefined,
		canonicalEntryId: typeof data.canonicalEntryId === "string" ? data.canonicalEntryId : null,
	};
}

function visibleRecord(data: Record<string, unknown>, entryId: string | null): SeenAnswerRecord | null {
	if (typeof data.id !== "string") return null;
	return {
		v: data.v === 2 ? 2 : 1,
		id: data.id,
		at: typeof data.at === "number" ? data.at : 0,
		toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
		request: typeof data.request === "string" ? data.request : undefined,
		entryId,
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
