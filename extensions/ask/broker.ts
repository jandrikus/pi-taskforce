/**
 * §12, §13. Asking, and where a question goes.
 *
 * One broker per process. It owns three things: this agent's own asks, the asks
 * its children send it, and the single screen or single parent both of them have
 * to share, because two asks running at once would fight over the user.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";

import type { PendingAsk } from "../agents/child.js";
import type { AgentId } from "../agents/records.js";
import type { Taskforce } from "../runtime.js";
import { type AskEnvelope, CANCELLED_RESULT, UNATTENDED_RESULT, decodeAskResult, encodeAsk } from "./protocol.js";
import type { Ask, AskResult, Question } from "./schema.js";
import { renderAskResult, validateAsk } from "./schema.js";
import { runDialogs } from "./dialogs.js";
import {
	ANSWER_ENTRY,
	type AskDraft,
	type CanonicalAnswer,
	type EntryLike,
	DRAFT_DEBOUNCE_MS,
	DRAFT_ENTRY,
	DONE_ENTRY,
	PENDING_ENTRY,
	type PendingAskRecord,
	SEND_ATTEMPT_ENTRY,
	type SendAttemptRecord,
	SUBMIT_ENTRY,
	type SubmitAskRecord,
	VISIBLE_ENTRY,
	type WakeAttemptRecord,
	WAKE_ATTEMPT_ENTRY,
	WAKE_ENTRY,
	canonicalFor,
	draftFromSubmit,
	journalAsks,
	legacyAsks,
	pendingRecord,
	recoverableAsks,
} from "./journal.js";
import { processId } from "./process.js";
import { type ContextMessage } from "./recovery.js";
import { createAskOverlay } from "./overlay.js";
import {
	ASK_CLOSE,
	ASK_OPEN,
	type AnswerReply,
	type AskClosed,
	type PendingDelivery,
	type RemoteAsk,
	normalizeRemoteAnswer,
} from "./remote.js";

/** A child's question this agent has to handle itself (§13). */
export interface WaitingQuestion {
	reference: string;
	agentId: AgentId;
	envelope: AskEnvelope;
	arrivedAt: number;
	resolve(result: AskResult): void;
}

export interface BrokerHooks {
	/** Delivers the question to this agent as a follow-up, like a report (§13). */
	wake(message: string): void;
	/** Something changed, so the panel and the status line redraw (§14). */
	onChange(): void;
}

/** An ask that is on screen, or put away, and still waiting for an answer. */
interface OpenAsk {
	id: string;
	envelope: AskEnvelope;
	handle: OverlayHandle | null;
	/** Put away so the terminal behind it can be read and scrolled. */
	hidden: boolean;
	/** Who asked, as the overlay names them. */
	attribution: string | null;
	/** The session this ask belongs to, fixed when it was first shown. */
	sessionId: string | null;
	/** Closes the overlay without treating it as an explicit cancel. */
	close: (() => void) | null;
	/** The run was aborted; the pending journal and the question stay. */
	suspended: boolean;
}

/** A question from an earlier process that is readable, answerable and not live. */
interface Recovered {
	pending: PendingAskRecord;
	draft: AskDraft | null;
	/**
	 * The branch this question was restored from moved away, or the session
	 * changed. The callback must refuse, and no later event may finish it.
	 */
	withdrawn: boolean;
	/** The terminal copy, when one is on screen. */
	handle: OverlayHandle | null;
	hidden: boolean;
	/** Resolves the terminal copy, whichever side answers first. */
	close: ((result: AskResult) => void) | null;
	/** The answers the user already sent, so a lost materialisation loses nothing. */
	submitted: SubmitAskRecord | null;
	/** A canonical answer is on the branch. */
	canonical: CanonicalAnswer | null;
	/** The latest canonical write this branch records. */
	sendAttempt: SendAttemptRecord | null;
	/** Continuation requests on this branch. */
	wakeAttempts: WakeAttemptRecord[];
	/** An old v1 continuation record without process identity. */
	legacyWakeAttempt: boolean;
	/** Proof that the canonical answer was visible to a model request. */
	seen: import("./journal.js").SeenAnswerRecord | null;
	/** This is a legacy question with no call to link an answer to. */
	legacy: boolean;
	/** Why the last attempt did not finish, as the user is told. */
	lastError: string | null;
}

/** What the ask tool gets back: an answer, or a stopped run with the ask kept. */
export type AskReturn =
	| { result: AskResult; suspended: false; askId: string }
	| { result: AskResult; suspended: true; askId: string };

/** What the ask tool passes about the call that is asking. */
export interface AskOrigin {
	toolCallId: string | null;
	assistantEntryId: string | null;
	signal?: AbortSignal;
}

interface ContinuationView {
	canonical: CanonicalAnswer;
	/** A successful assistant response followed the visible answer. */
	consumed: boolean;
	/** The response that followed the visible answer ended in error or abort. */
	retryableFailure: "error" | "aborted" | null;
	currentAttempt: WakeAttemptRecord | null;
	legacyAttempt: boolean;
}

type WakeOutcome = "none" | "sent" | "deferred" | "guarded" | "failed" | "consumed";

export interface RecoveryGate {
	ok: boolean;
	reason: string | null;
}

export class AskBroker {
	/** Child questions waiting on this agent's own answer, in arrival order. */
	private readonly waiting = new Map<string, WaitingQuestion>();
	/** §12. Two asks never run at once; a second one waits for the first. */
	private screen: Promise<void> = Promise.resolve();
	private nextReference = 1;
	/** Asks waiting for the screen behind the one showing. */
	private queuedRenders = 0;
	/** Every ask still waiting for an answer, shown or put away (§12). */
	private readonly open = new Map<string, OpenAsk>();
	/** Questions from a previous process that no live tool is waiting on any more. */
	private readonly recovered = new Map<string, Recovered>();
	/** Drafts written at most once per second, and never lost on a clean boundary. */
	private readonly draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
	/** The first unsaved change: continuous typing may not push this deadline out. */
	private readonly draftDeadlines = new Map<string, number>();
	private readonly draftValues = new Map<string, AskDraft>();
	private readonly draftWritten = new Map<string, string>();
	/** A done marker that could not be written yet, retried at the next boundary. */
	private readonly pendingDone = new Map<string, "answered" | "cancelled" | "unattended" | "recovered" | "discarded">();
	/** A broken session is reported once, not on every keystroke. */
	private journalWarned = false;
	/** The pending record for each ask, so a submission carries the whole link. */
	private readonly pendingRecords = new Map<string, PendingAskRecord>();
	/** Asks whose answer is durable but whose continuation waits for an idle session. */
	private readonly deferredWake = new Map<string, Recovered>();
	/** Child ask ids this instance already re-sent upward. */
	private readonly resumed = new Set<string>();
	/** Recovered child asks still waiting for their upward answer. */
	private readonly recovering = new Map<string, Promise<void>>();
	/** The first reason a child must not run its recovered task. */
	private recoveryFailure: string | null = null;
	/** Completed continuations already reported to this process's UI. */
	private readonly completedNotices = new Set<string>();
	/** Old journals whose draft is preserved but cannot be linked to a call. */
	legacyCount = 0;
	private ctx: ExtensionContext | null = null;
	/**
	 * §13. A question from a foreground run travels in that call's own result,
	 * because that result is the parent's very next input. Waking the parent with a
	 * separate message as well would have it told twice.
	 */
	private readonly foreground = new Set<AgentId>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly tf: Taskforce,
		private readonly hooks: BrokerHooks,
	) {}

	useContext(ctx: ExtensionContext): void {
		this.ctx = ctx;
	}

	/** Marks the next question from this child as one the spawn call will carry. */
	expectForegroundQuestion(agentId: AgentId): void {
		this.foreground.add(agentId);
	}

	/** The question waiting on this agent from that child, if there is one. */
	waitingFor(agentId: AgentId): WaitingQuestion | null {
		return this.waitingQuestions.find((question) => question.agentId === agentId) ?? null;
	}

	get waitingQuestions(): WaitingQuestion[] {
		return [...this.waiting.values()].sort((a, b) => a.arrivedAt - b.arrivedAt);
	}

	get waitingCount(): number {
		return this.waiting.size;
	}

	// -------------------------------------------------------- this agent asks

	/**
	 * §13. This agent's own ask. At the root it reaches the user; anywhere else it
	 * goes to the agent that spawned this one.
	 */
	async ask(ask: Ask, ctx: ExtensionContext, origin: AskOrigin = { toolCallId: null, assistantEntryId: null }): Promise<AskReturn> {
		this.ctx = ctx;
		const self = this.tf.self;
		const envelope: AskEnvelope = {
			from: { agentId: self.uuid, agentType: self.type ?? "root", depth: this.tf.depth },
			asksUserDirectly: this.tf.asksUserDirectly,
			ask,
		};
		const id = `ask-${randomUUID()}`;
		const attribution = attributionOf(envelope, self.uuid);
		if (!this.tf.isRoot) {
			// A child writes the question before it leaves this process, so a child
			// restart can re-send the same request and the answer can be put back.
			this.writePendingRecord(id, envelope, this.sessionId(), attribution, origin);
			const run = this.relayUpward(envelope, ctx, id, origin);
			return this.guard(run, id, origin.signal);
		}
		this.writePendingRecord(id, envelope, this.sessionId(), attribution, origin);
		const run = this.render(envelope, ctx, id, origin).then((result) => ({
			result,
			suspended: false,
		}));
		return this.guard(run, id, origin.signal);
	}

	/**
	 * §12. Stop keeps the question. The overlay is closed without a done marker,
	 * and the tool returns our own suspended placeholder, which is the only real
	 * result a recovered answer may replace.
	 */
	private async guard(
		run: Promise<{ result: AskResult; suspended: boolean }>,
		id: string,
		signal: AbortSignal | undefined,
	): Promise<AskReturn> {
		if (!signal) {
			const outcome = await run;
			return { result: outcome.result, suspended: outcome.suspended, askId: id };
		}
		let onAbort: (() => void) | null = null;
		const aborted = new Promise<{ aborted: true }>((resolve) => {
			onAbort = () => resolve({ aborted: true });
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		const outcome = await Promise.race([run, aborted]);
		if (onAbort) signal.removeEventListener("abort", onAbort);
		if ("aborted" in outcome) {
			this.suspendOpen(id);
			return { result: { outcome: "cancelled", answers: [] }, suspended: true, askId: id };
		}
		return { result: outcome.result, suspended: outcome.suspended, askId: id };
	}

	private suspendOpen(id: string): void {
		const open = this.open.get(id);
		if (!open) return;
		open.suspended = true;
		try {
			open.close?.();
		} catch {
			// A disposed overlay is already gone.
		}
	}

	// ------------------------------------------------------- a child asks us

	/**
	 * §13. A question arrived from a child. A forked child on an unbroken fork path
	 * asks the user directly, so it is passed on rather than put to this agent's
	 * model; anything else is this agent's to handle.
	 */
	onChildAsk(agentId: AgentId, pending: PendingAsk): void {
		const envelope = this.verify(agentId, pending.envelope);
		if (!envelope) {
			pending.answer(CANCELLED_RESULT);
			return;
		}

		if (envelope.asksUserDirectly) {
			const ctx = this.ctx;
			if (!ctx) {
				pending.answer(UNATTENDED_RESULT);
				return;
			}
			const id = `ask-${randomUUID()}`;
			const origin: AskOrigin = { toolCallId: null, assistantEntryId: null };
			const run = this.tf.isRoot
				? this.render(envelope, ctx, id, origin)
				: this.relayUpward(envelope, ctx, id, origin).then((outcome) => outcome.result);
			void run.then((result) => pending.answer(result)).catch(() => pending.answer(CANCELLED_RESULT));
			return;
		}

		const reference = `ref-${this.nextReference++}`;
		const entry: WaitingQuestion = {
			reference,
			agentId,
			envelope,
			arrivedAt: Date.now(),
			resolve: (result) => {
				this.waiting.delete(reference);
				pending.answer(result);
				this.hooks.onChange();
			},
		};
		this.waiting.set(reference, entry);
		this.hooks.onChange();
		if (this.foreground.delete(agentId)) return;
		this.hooks.wake(describeQuestion(entry));
	}

	/**
	 * §13. A question crossing from a child is untrusted input. Its questions are
	 * validated again, and who asked and where it goes are taken from this agent's
	 * own record of the child, never from what the child says about itself. Only a
	 * forked child of an agent that itself asks the user directly may do so, and
	 * only such a child relays a question from further down; any other child is
	 * named as the asker.
	 */
	private verify(agentId: AgentId, claimed: AskEnvelope): AskEnvelope | null {
		const record = this.tf.children.get(agentId);
		if (!record) return null;
		const raw = claimed.ask as { context?: unknown; questions?: unknown } | undefined;
		// What crosses the wire is an ask already filled in, and a confirm question
		// carries the Yes and No the harness gave it. Those are dropped and given
		// again, so a child cannot choose a confirm question's options either.
		const questions = Array.isArray(raw?.questions)
			? raw.questions.map((question: unknown) => {
					if (!question || typeof question !== "object") return question;
					const { options, ...rest } = question as { type?: unknown; options?: unknown };
					return rest.type === "confirm" ? rest : { ...rest, options };
				})
			: raw?.questions;
		const checked = validateAsk(raw?.context, questions);
		if (!checked.ok) return null;

		const asksUserDirectly = this.tf.asksUserDirectly && record.forked;
		const child = { agentId: record.uuid, agentType: record.type ?? "subagent", depth: record.depth };
		const origin = claimed.from as Partial<AskEnvelope["from"]> | undefined;
		const relayed =
			asksUserDirectly &&
			typeof origin?.agentId === "string" &&
			typeof origin.agentType === "string" &&
			typeof origin.depth === "number" &&
			origin.agentId !== record.uuid &&
			origin.depth > record.depth;
		const via = relayed && Array.isArray(claimed.via) ? claimed.via.filter(isAgentRef) : [];
		return {
			from: relayed ? { agentId: origin.agentId!, agentType: origin.agentType!, depth: origin.depth! } : child,
			// The nearest hop first: the one this agent can vouch for.
			via: relayed ? [child, ...via] : [],
			asksUserDirectly,
			ask: checked.ask,
		};
	}

	/** §13. `answer_subagent` resolves one waiting question. */
	answer(reference: string, answers: Array<{ id: string; value: unknown; note?: string }>): string | null {
		const entry = this.waiting.get(reference);
		if (!entry) {
			const open = this.waitingQuestions;
			if (open.length === 0) {
				return "Nothing is waiting on an answer right now.";
			}
			return (
				`Nothing is waiting on the reference \`${reference}\`. Waiting now: ` +
				open.map((question) => `\`${question.reference}\` from ${question.envelope.from.agentType}`).join(", ") +
				"."
			);
		}
		if (answers.length === 0) {
			return "That call carried no answers. Give one answer per question the subagent asked.";
		}

		const byId = new Map(answers.map((answer) => [answer.id, answer]));
		const missing = entry.envelope.ask.questions.filter(
			(question) => !question.optional && !byId.has(question.id),
		);
		if (missing.length > 0) {
			return (
				"These questions are still unanswered: " +
				missing.map((question) => `\`${question.id}\` (${question.prompt})`).join("; ") +
				". Answer them, or call `ask` yourself if what is missing is the user's to give."
			);
		}

		entry.resolve({
			outcome: "answered",
			answers: entry.envelope.ask.questions.map((question) => {
				const given = byId.get(question.id);
				if (!given) {
					return { id: question.id, values: [], labels: [], typed: false, omitted: true, note: null };
				}
				const values = answerValues(question, given.value);
				return {
					id: question.id,
					values,
					labels: values.map((value) => labelFor(question, value)),
					typed: values.some((value) => !question.options.some((option) => option.value === value)),
					omitted: false,
					note: given.note ?? null,
				};
			}),
		});
		this.record(entry, "answered by this agent");
		return null;
	}

	/**
	 * §13. A subagent that stops with its own child's question open answers it as
	 * unattended: nobody else can reach that question, and the child proceeds on
	 * its own judgment instead of hanging.
	 */
	releaseAsUnattended(): void {
		for (const entry of this.waitingQuestions) {
			entry.resolve(UNATTENDED_RESULT);
			this.record(entry, "unattended: this agent stopped without answering");
		}
	}

	/**
	 * §12. Reads this session branch for questions an earlier process asked and
	 * never finished. A question with a done entry, one from another session, or
	 * one from a fork's copied parent history is not restored: the branch and the
	 * session id decide, not a guess.
	 *
	 * An answer that was journalled before the process stopped is materialised as
	 * the canonical answer and never offered as a question again. A real result on
	 * the branch finished the call, and a canonical answer already on it did too.
	 * Completed canonical answers are inventoried separately below: the normal
	 * DONE is written before the wake, so the offerable list cannot be the only
	 * source of outstanding continuations.
	 */
	restore(ctx: ExtensionContext): number {
		this.ctx = ctx;
		let sessionId: string | null = null;
		let branch: readonly EntryLike[] = [];
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? null;
			if (!sessionId) return 0;
			branch = ctx.sessionManager.getBranch();
		} catch {
			return 0;
		}
		if (!this.tf.isRoot) {
			this.restoreOwnAsk(ctx, branch, sessionId);
			return 0;
		}

		const next = new Map<string, Recovered>();
		const legacy = legacyAsks(branch, sessionId);
		for (const found of recoverableAsks(branch, sessionId)) {
			const known = this.recovered.get(found.pending.id);
			const recovered = known ?? this.recoveredRecord(found);
			if (found.pending.toolCallId === null) {
				// A legacy journal named no call. It stays editable and copyable, but an
				// answer can never be guessed into model context.
				recovered.legacy = true;
				if (found.draft) recovered.draft = found.draft;
				this.recovered.set(found.pending.id, recovered);
				next.set(found.pending.id, recovered);
				continue;
			}
			if (known) {
				if (found.draft) known.draft = found.draft;
				known.submitted = found.submitted ?? known.submitted;
				known.canonical = found.canonical;
				known.sendAttempt = found.sendAttempt;
				known.wakeAttempts = found.wakeAttempts;
				known.legacyWakeAttempt = found.legacyWakeAttempt;
				known.seen = found.seen;
				known.lastError = null;
			} else {
				this.recovered.set(found.pending.id, recovered);
			}
			// The call already finished: a real result wins over any canonical answer,
			// except our own suspended placeholder, which the answer may replace.
			if (found.realResult && !found.suspended) {
				if (!this.hasDone(branch, found.pending.id)) this.writeDone(found.pending.id, "answered");
				this.recovered.delete(found.pending.id);
				continue;
			}
			if (found.canonical) {
				if (!this.hasDone(branch, found.pending.id)) {
					this.writeDone(
						found.pending.id,
						found.canonical.outcome === "answered"
							? "recovered"
							: found.canonical.outcome === "unattended"
								? "unattended"
								: "cancelled",
					);
				}
				this.recovered.delete(found.pending.id);
				this.wakeAnswer(found.pending, found.wakeAttempts, found.legacyWakeAttempt);
				continue;
			}
			// The submit WAL is the immutable payload. A same-process attempt that has
			// not become visible is not retried: the old effect may still land.
			if (found.submitted) {
				const error = this.materializeCanonical(recovered, branch);
				if (error) recovered.lastError = error;
			}
			if (this.observeCanonical(recovered)) {
				this.settleRecovered(recovered, found.submitted?.by ?? "remote");
				continue;
			}
			if (recovered.submitted && this.sendAttemptForCurrentProcess(recovered)) {
				recovered.lastError =
					"Answers are saved. Pi is still writing them into the conversation in this process; restart Pi if they do not appear.";
			}
			next.set(found.pending.id, recovered);
			this.emitRecovered(recovered);
		}
		// §12. A normal product write records DONE before it requests the wake, so a
		// completed canonical answer is not in `pending` any more. It still owns an
		// outstanding continuation. Enumerate completed answers separately from the
		// offerable questions and give a new process its one safe attempt.
		for (const found of journalAsks(branch, sessionId)) {
			if (!found.done || !found.canonical || !found.pending.toolCallId) continue;
			if (next.has(found.pending.id)) continue;
			if (found.realResult && !found.suspended) continue;
			const outcome = this.maybeWake(this.recoveredRecord(found));
			if (outcome !== "failed" && outcome !== "guarded") continue;
			if (this.completedNotices.has(found.pending.id)) continue;
			this.completedNotices.add(found.pending.id);
			this.notify(
				outcome === "failed"
					? "pi-taskforce: the saved answer is in the conversation, but its continuation ended in an error or abort. Run /questions continue to retry it; it will not retry automatically."
					: "pi-taskforce: the saved answer is in the conversation. A continuation was already requested; wait for it, or restart Pi if it does not start.",
				"info",
			);
		}
		// §12. A branch change or a session switch takes back the questions that are
		// not on the new branch. Their pending entries stay: going back offers them
		// again, and a stale callback cannot answer into the wrong branch.
		for (const [id, recovered] of [...this.recovered]) {
			if (next.has(id)) continue;
			this.withdrawRecovered(recovered);
		}
		// A deferred wake belongs to the branch its canonical answer was written on.
		for (const [id, recovered] of [...this.deferredWake]) {
			const current = canonicalFor(branch, id, recovered.pending.toolCallId);
			if (!current) this.deferredWake.delete(id);
		}
		this.legacyCount = legacy.length;
		return next.size - legacy.length;
	}

	/**
	 * §12. A child's own ask is restored in the child's session. The child cannot
	 * show a question, so it sends the same request upward again through the
	 * public extension UI protocol; the parent answers the new request id and the
	 * answer is materialised here, where this agent's model reads it.
	 */
	private restoreOwnAsk(ctx: ExtensionContext, branch: readonly EntryLike[], sessionId: string): void {
		for (const found of recoverableAsks(branch, sessionId)) {
			if (found.pending.toolCallId === null) continue;
			if (found.realResult && !found.suspended) continue;
			if (found.canonical) continue;
			if (this.resumed.has(found.pending.id)) continue;
			this.resumed.add(found.pending.id);
			const job = (async () => {
				const recovered = this.recoveredRecord(found);
				this.recovered.set(found.pending.id, recovered);
				if (found.submitted) {
					const error = this.materializeCanonical(recovered, branch);
					if (error) {
						recovered.lastError = error;
						this.recoveryFailure ??= error;
						return;
					}
					if (this.observeCanonical(recovered)) {
						this.settleRecovered(recovered, found.submitted.by);
						return;
					}
					// The send is provisional. Pi commits a queued custom message while
					// this run starts, and the context boundary verifies the actual
					// request. If it is missing there, the request is stopped.
					recovered.lastError =
						"The recovered answer is saved and queued for this run; the request boundary verifies it before the provider.";
					return;
				}
				const gate = await this.reissueUpward(found.pending, ctx);
				if (!gate.ok) this.recoveryFailure ??= gate.reason;
			})().finally(() => this.recovering.delete(found.pending.id));
			this.recovering.set(found.pending.id, job);
		}
	}

	private recoveredRecord(found: import("./journal.js").RecoveredAsk): Recovered {
		return {
			pending: found.pending,
			draft: found.draft,
			submitted: found.submitted,
			canonical: found.canonical,
			sendAttempt: found.sendAttempt,
			wakeAttempts: [...found.wakeAttempts],
			legacyWakeAttempt: found.legacyWakeAttempt,
			seen: found.seen,
			legacy: false,
			lastError: null,
			withdrawn: false,
			handle: null,
			hidden: false,
			close: null,
		};
	}

	/**
	 * A restarted child must not run its recovered task before the parent has
	 * answered and the answer is durable in its own conversation. The supervisor
	 * sends the task prompt immediately, so the before-agent-start hook waits here
	 * for the upward request to settle. A failed journal write or rejected send
	 * fails closed; a queued send is only provisional, and the request boundary
	 * checks that the actual request carries the original call's result.
	 */
	async awaitRecovery(ctx: ExtensionContext): Promise<RecoveryGate> {
		this.ctx = ctx;
		while (this.recovering.size > 0) {
			await Promise.all([...this.recovering.values()]);
		}
		return this.recoveryFailure === null
			? { ok: true, reason: null }
			: { ok: false, reason: this.recoveryFailure };
	}

	/** Re-sends a child's unanswered ask to the parent and waits for the new answer. */
	private async reissueUpward(pending: PendingAskRecord, ctx: ExtensionContext): Promise<RecoveryGate> {
		if (!ctx.hasUI) {
			return { ok: false, reason: "There is no interactive user to answer the recovered child question." };
		}
		try {
			const raw = await ctx.ui.input(encodeAsk({
				from: pending.from,
				via: pending.via ?? [],
				asksUserDirectly: this.tf.asksUserDirectly,
				ask: pending.ask,
			}));
			const result = raw === undefined ? CANCELLED_RESULT : decodeAskResult(raw);
			if (!result) {
				return { ok: false, reason: "The answer to the recovered child question was not readable." };
			}
			const recovered = this.recovered.get(pending.id) ?? this.recoveredRecord({
				pending,
				draft: null,
				done: null,
				submitted: null,
				canonical: null,
				realResult: false,
				suspended: true,
				sendAttempt: null,
				wakeAttempts: [],
				legacyWakeAttempt: false,
				seen: null,
			});
			this.recovered.set(pending.id, recovered);
			const saveError = this.saveSubmission(recovered, result, "remote");
			if (saveError) {
				recovered.lastError = saveError;
				return { ok: false, reason: saveError };
			}
			const error = this.materializeCanonical(recovered);
			if (error) {
				recovered.lastError = error;
				return { ok: false, reason: error };
			}
			// A queued custom message is provisional, not accepted. Pi may append it
			// only after this handler returns; the context boundary verifies the real
			// request carries the original call's result. A rejected send returned
			// above; a deferred append that later fails cannot reach this return.
			if (this.observeCanonical(recovered)) this.settleRecovered(recovered, "remote");
			return { ok: true, reason: null };
		} catch {
			return { ok: false, reason: "The parent went away before the recovered child question was answered." };
		}
	}

	private hasDone(branch: readonly EntryLike[], id: string): boolean {
		for (const entry of branch) {
			if (entry.type === "custom" && entry.customType === DONE_ENTRY) {
				const data = entry.data as { id?: unknown } | undefined;
				if (data?.id === id) return true;
			}
		}
		return false;
	}

	private stillHere(recovered: Recovered): boolean {
		if (recovered.withdrawn) return false;
		if (this.recovered.get(recovered.pending.id) !== recovered) return false;
		const current = this.sessionId();
		return current === null || recovered.pending.sessionId === null || current === recovered.pending.sessionId;
	}

	/** Takes back a recovered question without finishing it: it stays pending. */
	private withdrawRecovered(recovered: Recovered): void {
		if (recovered.withdrawn) return;
		recovered.withdrawn = true;
		this.deferredWake.delete(recovered.pending.id);
		this.recovered.delete(recovered.pending.id);
		const close = recovered.close;
		recovered.close = null;
		recovered.handle = null;
		if (close) {
			try {
				close({ outcome: "cancelled", answers: [] });
			} catch {
				// A disposed overlay is already gone.
			}
		}
		this.emit(ASK_CLOSE, { id: recovered.pending.id, outcome: "cancelled", by: "terminal" } satisfies AskClosed);
		this.hooks.onChange();
	}

	/** How many questions from an earlier process are still offerable. */
	get recoveredCount(): number {
		return this.recovered.size;
	}

	/**
	 * §12. Shows the first recovered question in the terminal. Answers are checked
	 * before anything is sent; a cancellation is a decision of its own.
	 */
	async showRecovered(ctx: ExtensionContext): Promise<boolean> {
		this.ctx = ctx;
		const first = [...this.recovered.values()].find((recovered) => this.stillHere(recovered));
		if (!first) return false;
		if (first.legacy && (!ctx.hasUI || ctx.mode !== "tui")) {
			ctx.ui.notify(
				"pi-taskforce: this older question has no call to answer. Open pi in a terminal and run /questions to edit or copy it; nothing is sent to the model.",
				"info",
			);
			return true;
		}
		if (!ctx.hasUI || ctx.mode !== "tui") {
			ctx.ui.notify("pi-taskforce: a recovered question can only be answered with a terminal or a connected Pilot.", "info");
			return true;
		}
		// Already on screen, perhaps put away: show that copy instead of a second one.
		if (first.handle) {
			first.hidden = false;
			try {
				first.handle.setHidden(false);
				first.handle.focus();
			} catch {
				// A disposed overlay cannot come back; the phone can still answer.
			}
			return true;
		}
		await this.renderRecovered(first, ctx);
		return true;
	}

	private emitRecovered(recovered: Recovered): void {
		const remote: RemoteAsk = {
			id: recovered.pending.id,
			ask: recovered.pending.ask,
			from: "an earlier run",
			at: Date.now(),
			answer: (input) => this.answerRecovered(recovered, input),
			status: recovered.submitted ? this.pendingStatus(recovered) : null,
		};
		this.emit(ASK_OPEN, remote);
	}

	private renderRecovered(recovered: Recovered, ctx: ExtensionContext): Promise<void> {
		const envelope: AskEnvelope = {
			from: recovered.pending.from,
			via: recovered.pending.via ?? [],
			asksUserDirectly: false,
			ask: recovered.pending.ask,
		};
		const attribution = "an earlier run";
		const heading = "Question saved from the previous run";
		const run = this.screen.then(async () => {
			// The phone may have answered while this waited for the screen.
			if (!this.stillHere(recovered)) return;
			const shown = ctx.ui.custom<AskResult>(
				(tui, theme, _keybindings, rawDone) => {
					// Whichever side answers first closes this copy, like a live ask.
					recovered.close = rawDone;
					const done = (result: AskResult) => {
						if (result.outcome === "cancelled" && !recovered.legacy) {
							const error = this.acceptRecovered(recovered, result, "terminal");
							if (error) this.notify(error, "warning");
						}
						rawDone(result);
					};
					return createAskOverlay({
						envelope,
						theme,
						tui,
						done,
						attribution,
						heading,
						initial: recovered.draft,
						hide: () => {
							recovered.hidden = true;
							try {
								recovered.handle?.setHidden(true);
							} catch {
								// A disposed overlay is already gone.
							}
							this.hooks.onChange();
						},
						submit: (result) => this.submitFromTerminal(recovered, result),
						onDraft: (draft, immediate) => this.journalDraft(recovered.pending.id, draft, immediate),
					});
				},
				{
					overlay: true,
					overlayOptions: { width: "86%", maxHeight: "100%", margin: 1, anchor: "center" },
					onHandle: (handle) => {
						recovered.handle = handle;
						recovered.hidden = false;
					},
					blocked: {
						kind: "question",
						message: recovered.pending.ask.questions[0]?.prompt ?? "Question from an earlier run",
					},
				},
			);
			try {
				await shown;
			} finally {
				if (!recovered.hidden) recovered.handle = null;
				recovered.close = null;
			}
		});
		this.screen = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	/**
	 * §12. The terminal's Send. The answers are journalled first, then sent as the
	 * canonical answer of the call that asked. Completion is not declared until
	 * that message is observed on the current branch; a streaming send is deferred
	 * by Pi, so the journal stays replayable until then.
	 */
	private async submitFromTerminal(recovered: Recovered, result: AskResult): Promise<string | null> {
		if (recovered.legacy) {
			this.copyLegacy(recovered, result);
			return null;
		}
		if (recovered.canonical) return null;
		return this.acceptRecovered(recovered, result, "terminal");
	}

	/** The phone's answer: the same durable path as the terminal's Send. */
	private answerRecovered(recovered: Recovered, input: unknown): AnswerReply {
		if (recovered.legacy) return "This older question has no call to answer; open /questions in the terminal to copy it.";
		if (recovered.canonical) return { pending: this.pendingStatus(recovered) };
		if (!this.stillHere(recovered)) return "This question is no longer waiting on this branch.";
		const result = normalizeRemoteAnswer(recovered.pending.ask, input);
		if (typeof result === "string") return result;
		if (recovered.canonical) return { pending: this.pendingStatus(recovered) };
		const error = this.acceptRecovered(recovered, result, "remote");
		if (error) {
			if (recovered.submitted) return { pending: { ...this.pendingStatus(recovered), message: error } };
			return error;
		}
		return { pending: this.pendingStatus(recovered) };
	}

	/**
	 * §12. Save the answers, attempt the canonical write, and settle only when that
	 * message is actually on this branch. The payload is immutable once saved: a
	 * later answer cannot replace what a recorded effect may already have carried.
	 */
	private acceptRecovered(
		recovered: Recovered,
		result: AskResult,
		by: AskClosed["by"],
	): string | null {
		if (!this.stillHere(recovered)) return "This question is no longer waiting on this branch.";
		const existing = recovered.submitted;
		if (existing) {
			const saved = renderAskResult(recovered.pending.ask, existing.result);
			if (JSON.stringify(existing.result) !== JSON.stringify(result)) {
				return `Answers were already saved as: ${saved} They cannot be changed while delivery is pending.`;
			}
			const error = this.materializeCanonical(recovered);
			if (error) return this.waitingMessage(recovered) ?? error;
			if (this.observeCanonical(recovered) && this.settleRecovered(recovered, by, by !== "terminal")) return null;
			return this.waitingMessage(recovered);
		}
		const saveError = this.saveSubmission(recovered, result, by);
		if (saveError) return saveError;
		const error = this.materializeCanonical(recovered);
		if (error) return error;
		if (this.observeCanonical(recovered) && this.settleRecovered(recovered, by, by !== "terminal")) return null;
		return this.waitingMessage(recovered);
	}

	/** The answers are durable in the journal before anything else happens. */
	private saveSubmission(recovered: Recovered, result: AskResult, by: AskClosed["by"]): string | null {
		if (recovered.submitted) {
			return "Answers were already saved. They cannot be replaced while delivery is pending.";
		}
		const record: SubmitAskRecord = {
			v: 2,
			id: recovered.pending.id,
			at: Date.now(),
			by,
			result,
			sessionId: recovered.pending.sessionId,
			submitId: randomUUID(),
		};
		if (!this.append(SUBMIT_ENTRY, record)) {
			return "The answers could not be saved to the session, so nothing was sent. Nothing was lost; try again.";
		}
		recovered.submitted = record;
		recovered.lastError = null;
		recovered.draft = draftFromSubmit(record, recovered.pending.ask);
		this.draftValues.set(recovered.pending.id, recovered.draft);
		return null;
	}

	/**
	 * §12. The canonical answer is a custom message with a structural link to the
	 * original call. The write attempt is durable first, so a reload in the same
	 * process never repeats an effect that may still land. A genuinely new process
	 * may apply the same immutable payload again because the old one cannot.
	 */
	private materializeCanonical(
		recovered: Recovered,
		branch: readonly EntryLike[] = this.branch(),
	): string | null {
		const observed = canonicalFor(branch, recovered.pending.id, recovered.pending.toolCallId);
		if (observed) {
			recovered.canonical = observed;
			return null;
		}
		const submitted = recovered.submitted;
		if (!submitted) return null;
		const attempt = recovered.sendAttempt;
		if (attempt && attempt.process === processId() && attempt.submitId === (submitted.submitId ?? "")) {
			return "Answers are saved. Pi is still writing them into the conversation in this process; restart Pi if they do not appear.";
		}
		const submitId = submitted.submitId ?? `at:${submitted.at}`;
		const record = {
			v: 1 as const,
			id: recovered.pending.id,
			at: Date.now(),
			toolCallId: recovered.pending.toolCallId ?? "",
			sessionId: recovered.pending.sessionId,
			process: processId(),
			submitId,
		};
		if (!this.append(SEND_ATTEMPT_ENTRY, record)) {
			return "Answers are saved, but Pi could not record the write. Nothing was sent; try again.";
		}
		recovered.sendAttempt = record;
		return this.writeCanonical(recovered.pending, submitted.result);
	}

	private sendAttemptForCurrentProcess(recovered: Recovered): boolean {
		return recovered.sendAttempt?.process === processId();
	}

	private waitingMessage(recovered: Recovered): string {
		if (recovered.sendAttempt?.process === processId()) {
			return "Answers are saved. Pi is still writing them into the conversation in this process; restart Pi if they do not appear. Do not send them again.";
		}
		return "The answers are saved. Pi has not written them into the conversation yet; they will be applied automatically. Try again if the question stays open.";
	}

	private observeCanonical(recovered: Recovered, branch: readonly EntryLike[] = this.branch()): boolean {
		const found = canonicalFor(branch, recovered.pending.id, recovered.pending.toolCallId);
		if (!found) return false;
		recovered.canonical = found;
		return true;
	}

	private branch(): readonly EntryLike[] {
		try {
			return this.ctx?.sessionManager.getBranch() ?? [];
		} catch {
			return [];
		}
	}

	/**
	 * Settle an ask only after its canonical answer is on the branch. The journal
	 * done entry is bookkeeping, never a substitute for the observed message.
	 */
	private settleRecovered(recovered: Recovered, by: AskClosed["by"], closeOverlay = true): boolean {
		if (recovered.withdrawn) return false;
		if (!this.observeCanonical(recovered)) return false;
		const outcome = recovered.submitted?.result.outcome ?? recovered.canonical?.outcome ?? "answered";
		const how = outcome === "answered" ? "answered" : outcome === "unattended" ? "unattended" : "cancelled";
		this.writeDone(recovered.pending.id, how);
		this.recovered.delete(recovered.pending.id);
		this.deferredWake.delete(recovered.pending.id);
		this.closeRecovered(recovered, outcome === "answered" ? "answered" : "cancelled", by, closeOverlay);
		this.maybeWake(recovered);
		this.hooks.onChange();
		return true;
	}

	/** Writes the canonical answer message; the structural link is in its details. */
	private writeCanonical(pending: PendingAskRecord, result: AskResult): string | null {
		try {
			this.pi.sendMessage(
				{
					customType: ANSWER_ENTRY,
					content: renderAskResult(pending.ask, result),
					display: true,
					details: {
						v: 2,
						askId: pending.id,
						outcome: result.outcome,
						toolCallId: pending.toolCallId,
						assistantEntryId: pending.assistantEntryId,
						sessionId: pending.sessionId,
						from: pending.from,
						at: Date.now(),
					},
				},
				{ triggerTurn: false },
			);
			return null;
		} catch (error) {
			return `The answers are saved, but they could not be written to the conversation: ${
				error instanceof Error ? error.message : String(error)
			}. A new Pi process will apply the saved answers.`;
		}
	}

	/** A live ask's answers: journalled, then made canonical, before it closes. */
	private saveLiveSubmission(id: string, result: AskResult, by: AskClosed["by"]): string | null {
		const pending = this.pendingRecords.get(id);
		if (!pending) return null;
		const record: SubmitAskRecord = {
			v: 2,
			id,
			at: Date.now(),
			by,
			result,
			sessionId: pending.sessionId,
			submitId: randomUUID(),
		};
		if (!this.append(SUBMIT_ENTRY, record)) {
			return "The answers could not be saved to the session, so nothing was sent. Nothing was lost; try again.";
		}
		const error = this.writeCanonical(pending, result);
		if (error) this.notify(`pi-taskforce: ${error}`, "warning");
		return null;
	}

	/** A child's own ask: the answer is durable here before it is reported upward. */
	private saveChildSubmission(id: string, result: AskResult, by: AskClosed["by"]): void {
		const pending = this.pendingRecords.get(id);
		if (!pending) return;
		const record: SubmitAskRecord = {
			v: 2,
			id,
			at: Date.now(),
			by,
			result,
			sessionId: pending.sessionId,
			submitId: randomUUID(),
		};
		if (!this.append(SUBMIT_ENTRY, record)) return;
		const error = this.writeCanonical(pending, result);
		if (error) this.notify(`pi-taskforce: ${error}`, "warning");
	}

	/** What a phone is told about a live ask it just answered. */
	private liveStatus(_id: string): PendingDelivery {
		return { state: "dispatched", message: "Answers saved in the conversation.", retry: false };
	}

	/** A legacy answer is copied/exported only; it never becomes model input. */
	private copyLegacy(recovered: Recovered, result: AskResult): void {
		const saveError = this.saveSubmission(recovered, result, "terminal");
		if (saveError) {
			recovered.lastError = saveError;
			return;
		}
		const text = renderAskResult(recovered.pending.ask, result);
		try {
			this.ctx?.ui.setEditorText(text);
		} catch {
			// A surface without an editor still keeps the answers in the journal.
		}
		this.notify(
			"pi-taskforce: this older question has no call to answer. Its answers were copied into the editor and saved as a draft; nothing was sent to the model.",
			"info",
		);
		recovered.lastError = null;
		this.hooks.onChange();
	}

	private wakeAnswer(
		pending: PendingAskRecord,
		wakeAttempts: WakeAttemptRecord[],
		legacyWakeAttempt: boolean,
	): void {
		const canonical = canonicalFor(this.branch(), pending.id, pending.toolCallId);
		if (!canonical) return;
		this.maybeWake({
			pending,
			draft: null,
			submitted: null,
			canonical,
			sendAttempt: null,
			wakeAttempts: [...wakeAttempts],
			legacyWakeAttempt,
			seen: null,
			legacy: false,
			lastError: null,
			withdrawn: false,
			handle: null,
			hidden: false,
			close: null,
		});
	}

	/**
	 * §12. A continuation is attempted at most once per process and canonical
	 * answer. A same-process attempt is unresolved, not proof of delivery. A new
	 * process may request it again because the old process cannot deliver it.
	 */
	private maybeWake(recovered: Recovered): WakeOutcome {
		if (!recovered.pending.toolCallId) return "none";
		const view = this.continuationFor(recovered.pending);
		if (!view) return "none";
		if (view.consumed) return "consumed";
		// A failed or aborted turn is settled, but automatic recovery must not
		// retry it: that would loop on the same error or override a user's abort.
		// `/questions continue` is the explicit retry.
		if (view.retryableFailure) return "failed";
		if (view.currentAttempt) return "guarded";
		if (view.legacyAttempt) {
			return this.adoptLegacyWake(recovered.pending, view.canonical) ? "guarded" : "failed";
		}
		if (!this.isIdle()) {
			this.deferredWake.set(recovered.pending.id, recovered);
			return "deferred";
		}
		this.attemptWake(recovered);
		return "sent";
	}

	/** Adopts an untokened old attempt as this process's unresolved guard. */
	private adoptLegacyWake(pending: PendingAskRecord, canonical: CanonicalAnswer): boolean {
		const record: WakeAttemptRecord = {
			v: 2,
			id: pending.id,
			at: Date.now(),
			toolCallId: pending.toolCallId,
			sessionId: pending.sessionId,
			process: processId(),
			canonicalEntryId: canonical.entryId,
		};
		if (!this.append(WAKE_ATTEMPT_ENTRY, record)) {
			this.notify(
				"pi-taskforce: an older continuation attempt could not be adopted for this process, so no continuation was sent. The answer is saved.",
				"warning",
			);
			return false;
		}
		this.notify(
			"pi-taskforce: an older continuation request had no process identity. It is now guarded for this process; restart pi once to continue safely.",
			"info",
		);
		return true;
	}

	private attemptWake(recovered: Recovered): void {
		const view = this.continuationFor(recovered.pending);
		if (!view || view.consumed || view.retryableFailure || view.currentAttempt || view.legacyAttempt) return;
		const record: WakeAttemptRecord = {
			v: 2,
			id: recovered.pending.id,
			at: Date.now(),
			toolCallId: recovered.pending.toolCallId,
			sessionId: recovered.pending.sessionId,
			process: processId(),
			canonicalEntryId: view.canonical.entryId,
		};
		if (!this.append(WAKE_ATTEMPT_ENTRY, record)) {
			this.notify(
				"pi-taskforce: the answers are saved, but Pi could not record a continuation attempt. Send a message to continue.",
				"warning",
			);
			return;
		}
		recovered.wakeAttempts.push(record);
		try {
			this.pi.sendMessage(
				{
					customType: WAKE_ENTRY,
					content: "The answer to the earlier ask is in the conversation as the result of that call. Continue the work.",
					display: false,
					details: {
						askId: recovered.pending.id,
						toolCallId: recovered.pending.toolCallId,
					},
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			this.notify(
				`pi-taskforce: the answers are saved, but Pi did not continue automatically: ${
					error instanceof Error ? error.message : String(error)
				}. Restart Pi to continue safely.`,
				"warning",
			);
		}
	}

	/** A turn boundary is when a deferred continuation can safely start. */
	flushWake(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.reconcile(ctx);
		if (!this.isIdle()) return;
		for (const [id, recovered] of [...this.deferredWake]) {
			this.deferredWake.delete(id);
			if (recovered.withdrawn) continue;
			if (this.sessionId() !== recovered.pending.sessionId) continue;
			if (!this.canonicalStillCurrent(recovered.pending)) continue;
			this.attemptWake(recovered);
		}
	}

	/**
	 * §12. An explicit continuation for an answer whose automatic attempt did not
	 * start a turn. It is still only a trigger for the canonical answer. A current
	 * process attempt is never repeated; an old untokened attempt is adopted and
	 * needs one full restart.
	 */
	continueAnswered(ctx: ExtensionContext): number {
		this.ctx = ctx;
		let branch: readonly EntryLike[] = [];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return 0;
		}
		const candidates = new Map<string, PendingAskRecord>();
		for (const entry of branch) {
			if (entry.type !== "custom" || entry.customType !== PENDING_ENTRY) continue;
			const data = entry.data as Record<string, unknown> | undefined;
			const pending = data ? pendingRecord(data) : null;
			if (pending?.toolCallId) candidates.set(pending.id, pending);
		}
		let guarded = false;
		for (const pending of candidates.values()) {
			if (pending.sessionId !== null && pending.sessionId !== this.sessionId()) continue;
			const view = this.continuationFor(pending, branch);
			if (!view || view.consumed) continue;
			// A definitive error or abort is settled, so an explicit Continue may
			// retry it in the same process. Automatic continuation does not.
			if (view.retryableFailure) {
				// fall through to the explicit attempt below
			} else if (view.currentAttempt) {
				guarded = true;
				continue;
			} else if (view.legacyAttempt) {
				this.adoptLegacyWake(pending, view.canonical);
				guarded = true;
				continue;
			}
			this.deferredWake.delete(pending.id);
			const record: WakeAttemptRecord = {
				v: 2,
				id: pending.id,
				at: Date.now(),
				toolCallId: pending.toolCallId,
				sessionId: pending.sessionId,
				process: processId(),
				canonicalEntryId: view.canonical.entryId,
			};
			if (!this.append(WAKE_ATTEMPT_ENTRY, record)) {
				this.notify("pi-taskforce: could not record the continuation attempt.", "warning");
				return 0;
			}
			try {
				this.pi.sendMessage(
					{
						customType: WAKE_ENTRY,
						content: "An answer to an earlier ask is in the conversation as the result of that call. Continue the work.",
						display: false,
						details: { askId: pending.id, toolCallId: pending.toolCallId },
					},
					{ triggerTurn: true },
				);
				return 1;
			} catch (error) {
				this.notify(
					`pi-taskforce: could not continue: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
				return 0;
			}
		}
		if (guarded) {
			this.notify(
				"pi-taskforce: a continuation for this answer was already requested in this process. Wait for it to start, or restart Pi if it does not.",
				"info",
			);
		}
		return 0;
	}

	/** What the branch says about this answer: present, seen, consumed, attempted. */
	private continuationFor(
		pending: PendingAskRecord,
		branch: readonly EntryLike[] = this.branch(),
	): ContinuationView | null {
		let canonicalIndex = -1;
		let canonical: CanonicalAnswer | null = null;
		const attempts: Array<{ record: WakeAttemptRecord; index: number }> = [];
		const results = new Map<string, boolean>();
		const calls = new Set<string>();
		for (let i = 0; i < branch.length; i++) {
			const entry = branch[i]!;
			if (entry.type === "message") {
				const message = entry.message as {
					role?: unknown;
					toolCallId?: unknown;
					details?: unknown;
					content?: unknown;
				} | undefined;
				if (message?.role === "assistant" && Array.isArray(message.content)) {
					for (const part of message.content) {
						const block = part as { type?: unknown; id?: unknown };
						if (block.type === "toolCall" && typeof block.id === "string") calls.add(block.id);
					}
				}
				if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
					const details = message.details as { taskforceSuspended?: unknown } | undefined;
					results.set(message.toolCallId, details?.taskforceSuspended === true);
				}
				continue;
			}
			if (entry.type === "custom_message" && entry.customType === ANSWER_ENTRY) {
				const details = entry.details as { askId?: unknown; toolCallId?: unknown } | undefined;
				if (details?.askId === pending.id || details?.toolCallId === pending.toolCallId) {
					const found = canonicalFor([entry], pending.id, pending.toolCallId);
					if (found) {
						canonical = found;
						canonicalIndex = i;
					}
				}
				continue;
			}
			if (entry.type === "custom" && entry.customType === WAKE_ATTEMPT_ENTRY) {
				const data = entry.data as Record<string, unknown> | undefined;
				if (data?.id === pending.id) {
					const record = {
						v: data.v === 2 ? 2 : 1,
						id: pending.id,
						at: typeof data.at === "number" ? data.at : 0,
						toolCallId: typeof data.toolCallId === "string" ? data.toolCallId : null,
						sessionId: typeof data.sessionId === "string" ? data.sessionId : null,
						process: typeof data.process === "string" ? data.process : undefined,
						canonicalEntryId:
							typeof data.canonicalEntryId === "string" ? data.canonicalEntryId : null,
					} as WakeAttemptRecord;
					attempts.push({ record, index: i });
				}
			}
		}
		if (!canonical) return null;
		if (pending.toolCallId && !calls.has(pending.toolCallId)) return null;
		if (pending.toolCallId) {
			const suspended = results.get(pending.toolCallId);
			if (suspended === false) return null;
		}
		// A proof belongs to the request that carried it, not to the answer for the
		// rest of its life. Several answers in one request share a request id, so
		// another answer's proof is part of this request, not a new one. Any
		// successful response consumes the answer for good; a later failed request
		// cannot undo that. Only the latest proof for this answer can supply a
		// retryable failure.
		let consumed = false;
		let failure: "error" | "aborted" | null = null;
		let failureIndex = -1;
		let proof = false;
		let proofRequest: string | null = null;
		for (let i = canonicalIndex + 1; i < branch.length; i++) {
			const entry = branch[i]!;
			if (entry.type === "custom" && entry.customType === VISIBLE_ENTRY) {
				const data = entry.data as Record<string, unknown> | undefined;
				const request = typeof data?.request === "string" ? data.request : null;
				if (visibleIdsOf(data).includes(pending.id)) {
					proof = true;
					proofRequest = request;
					// This is a new request for this answer: an earlier failure belongs
					// to the request before it.
					failure = null;
					failureIndex = -1;
					continue;
				}
				if (proof && (request === null ? proofRequest === null : request === proofRequest)) {
					// The same request also carried another answer.
					continue;
				}
				// A request that did not carry this answer cannot settle it.
				proof = false;
				proofRequest = null;
				continue;
			}
			if (!proof || entry.type !== "message") continue;
			const message = entry.message as { role?: unknown; stopReason?: unknown } | undefined;
			if (message?.role === "user") {
				proof = false;
				proofRequest = null;
				failure = null;
				failureIndex = -1;
				continue;
			}
			if (message?.role !== "assistant") continue;
			proof = false;
			proofRequest = null;
			// Missing stopReason is an old/structural fixture response. Only a
			// definitive error or abort is something explicit Continue may retry.
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				failure = message.stopReason;
				failureIndex = i;
			} else if (message.stopReason !== "pending" && message.stopReason !== "deferred") {
				consumed = true;
				failure = null;
				failureIndex = -1;
			} else {
				// Still running or not model-produced: neither consumed nor failed.
				failure = null;
				failureIndex = -1;
			}
		}
		const matches = (attempt: WakeAttemptRecord) =>
			!attempt.canonicalEntryId || !canonical?.entryId || attempt.canonicalEntryId === canonical.entryId;
		const relevant = attempts.filter((attempt) => attempt.index > canonicalIndex && matches(attempt.record));
		// A failed response only settles the attempts that existed when it arrived.
		// A later attempt with no response is unknown, not a second safe retry.
		const retryableFailure =
			failure && !relevant.some((attempt) => attempt.index > failureIndex) ? failure : null;
		const current = relevant.find((attempt) => attempt.record.process === processId())?.record ?? null;
		const tokened = relevant.some((attempt) => Boolean(attempt.record.process));
		const legacyAttempt = !tokened && relevant.some((attempt) => !attempt.record.process);
		return { canonical, consumed, retryableFailure, currentAttempt: current, legacyAttempt };
	}

	/** The canonical answer is still this branch's, not a copy from elsewhere. */
	private canonicalStillCurrent(pending: PendingAskRecord): boolean {
		return canonicalFor(this.branch(), pending.id, pending.toolCallId) !== null;
	}

	/**
	 * §12. The final request boundary. A recovered child answer is provisional
	 * until the actual request contains the result of its original call. A queued
	 * `sendMessage` is not acceptance: only the projected request is. If the call
	 * is present without a matching non-suspended result, the request is stopped
	 * before the provider. A call compacted out of the request is not blocked;
	 * its canonical answer is ordinary context then.
	 */
	requestProblem(messages: readonly ContextMessage[], ctx: ExtensionContext): string | null {
		this.ctx = ctx;
		let sessionId: string | null = null;
		let branch: readonly EntryLike[] = [];
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? null;
			if (!sessionId) return null;
			branch = ctx.sessionManager.getBranch();
		} catch {
			return null;
		}
		// This is the whole journal, not the offerable-question list: a completed
		// canonical answer is still a required result until the actual request
		// carries it. DONE is bookkeeping, not permission to skip this invariant.
		for (const found of journalAsks(branch, sessionId)) {
			const callId = found.pending.toolCallId;
			if (!callId || found.pending.v !== 2) continue;
			if (!found.submitted && !found.canonical) continue;
			let callPresent = false;
			let result: ContextMessage | null = null;
			for (const message of messages) {
				if (message.role === "assistant" && Array.isArray(message.content)) {
					for (const part of message.content) {
						if (!part || typeof part !== "object") continue;
						const block = part as { type?: unknown; id?: unknown };
						if (block.type === "toolCall" && block.id === callId) callPresent = true;
					}
				}
				if (message.role === "toolResult" && message.toolCallId === callId) result = message;
			}
			// The call left the request (compaction or context editing). The answer is
			// allowed to remain ordinary context; there is no result position to fill.
			if (!callPresent) continue;
			const details = result?.details as
				| { taskforceSuspended?: unknown; taskforceRecovered?: unknown; askId?: unknown; recoveredFrom?: unknown }
				| undefined;
			if (result && details?.taskforceSuspended !== true) {
				const recoveredAsk =
					details?.taskforceRecovered === true
						? details.askId
						: typeof details?.recoveredFrom === "string"
							? details.recoveredFrom
							: null;
				if (recoveredAsk === null || recoveredAsk === found.pending.id) continue;
			}
			return `the recovered answer for ${found.pending.id} is not the result of ${callId}`;
		}
		return null;
	}

	/**
	 * §12. Called with the exact messages of a model request. A marker is durable
	 * proof that the answer was in that request; only an assistant response after
	 * the marker consumes the answer. An unrelated in-flight turn cannot provide
	 * that evidence.
	 */
	noteVisibleAnswers(
		messages: readonly { role?: string; customType?: string; details?: unknown }[],
		ctx: ExtensionContext,
	): void {
		this.ctx = ctx;
		const branch = this.branch();
		const ids = new Set<string>();
		for (const message of messages) {
			const details = message.details as
				| { askId?: unknown; taskforceRecovered?: unknown; recoveredFrom?: unknown }
				| undefined;
			if (message.role === "toolResult" && details?.taskforceRecovered === true && typeof details.askId === "string") {
				ids.add(details.askId);
			}
			if (message.role === "toolResult" && typeof details?.recoveredFrom === "string") {
				ids.add(details.recoveredFrom);
			}
			if (
				message.role === "custom" &&
				message.customType === ANSWER_ENTRY &&
				typeof details?.askId === "string"
			) {
				ids.add(details.askId);
			}
		}
		// A proof is per actual request, not once per answer lifetime. Answers that
		// this request carried are recorded together so one answer's proof cannot
		// be mistaken for a separate request.
		const request = randomUUID();
		for (const id of ids) {
			let pending = this.pendingRecords.get(id) ?? this.recovered.get(id)?.pending;
			if (!pending) {
				for (const entry of branch) {
					if (entry.type !== "custom" || entry.customType !== PENDING_ENTRY) continue;
					const data = entry.data as Record<string, unknown> | undefined;
					const candidate = data ? pendingRecord(data) : null;
					if (candidate?.id === id) {
						pending = candidate;
						break;
					}
				}
			}
			if (!pending) continue;
			if (!canonicalFor(branch, pending.id, pending.toolCallId)) continue;
			this.append(VISIBLE_ENTRY, {
				v: 2,
				id: pending.id,
				at: Date.now(),
				toolCallId: pending.toolCallId,
				request,
			});
		}
	}

	/** Settles recovered asks whose deferred canonical write has now landed. */
	private reconcile(ctx: ExtensionContext, closeOverlay = true): void {
		this.ctx = ctx;
		const branch = this.branch();
		for (const recovered of [...this.recovered.values()]) {
			if (recovered.legacy || recovered.withdrawn) continue;
			if (!this.observeCanonical(recovered, branch) && recovered.submitted) {
				const error = this.materializeCanonical(recovered, branch);
				if (error) {
					recovered.lastError = error;
					continue;
				}
			}
			if (recovered.canonical) this.settleRecovered(recovered, recovered.submitted?.by ?? "remote", closeOverlay);
		}
	}

	private isIdle(): boolean {
		const ctx = this.ctx;
		if (!ctx) return true;
		try {
			if (ctx.isIdle() === false) return false;
		} catch {
			// An unreadable state is treated as idle; a wake is a trigger, not a send.
		}
		try {
			if (ctx.hasPendingMessages() === true) return false;
		} catch {
			// Same.
		}
		return true;
	}

	/**
	 * What the phone is told about a saved answer. A canonical answer in the
	 * conversation is done; it does not need a retry. Only a journal entry whose
	 * materialisation failed stays retryable.
	 */
	private pendingStatus(recovered: Recovered): PendingDelivery {
		if (recovered.canonical) {
			const view = this.continuationFor(recovered.pending);
			if (view?.retryableFailure) {
				return {
					state: "dispatched",
					message: "Answers are in the conversation, but the continuation ended in an error or abort. Run /questions continue to retry it.",
					retry: false,
				};
			}
			if (view?.currentAttempt && !view.consumed) {
				return {
					state: "dispatched",
					message: "Answers are in the conversation. A continuation was already requested in this process; wait for it, or restart Pi if it does not start.",
					retry: false,
				};
			}
			return {
				state: "dispatched",
				message: "Answers are in the conversation as the result of the call that asked. Pi continues on the next turn.",
				retry: false,
			};
		}
		if (recovered.sendAttempt?.process === processId()) {
			return {
				state: "saved",
				message: "Answers are saved. Pi is still writing them into the conversation in this process; restart Pi if they do not appear. Do not send them again.",
				retry: false,
			};
		}
		if (recovered.submitted) {
			return {
				state: "saved",
				message: "Answers are saved but have not been written into the conversation yet. Send again to retry the saved answers.",
				retry: true,
			};
		}
		return {
			state: "saved",
			message: "Answers are saved. They have not reached the conversation yet; send them again to apply them.",
			retry: true,
		};
	}

	private notify(message: string, kind: "info" | "warning"): void {
		try {
			if (this.ctx?.hasUI) this.ctx.ui.notify(message, kind);
		} catch {
			// A vanished context cannot be notified.
		}
	}

	private closeRecovered(
		recovered: Recovered,
		outcome: "answered" | "cancelled",
		by: AskClosed["by"],
		closeOverlay = true,
	): void {
		const close = recovered.close;
		recovered.close = null;
		recovered.handle = null;
		if (close && closeOverlay) {
			try {
				close({ outcome, answers: [] });
			} catch {
				// A disposed overlay is already gone.
			}
		}
		this.emit(ASK_CLOSE, { id: recovered.pending.id, outcome, by } satisfies AskClosed);
	}

	// -------------------------------------------------------------- journal

	private sessionId(): string | null {
		try {
			return this.ctx?.sessionManager.getSessionId() ?? null;
		} catch {
			return null;
		}
	}

	/** Returns whether the entry reached the session; a failure stays retryable. */
	private append(customType: string, data: unknown): boolean {
		try {
			this.pi.appendEntry(customType, data);
			return true;
		} catch {
			this.warnJournalOnce();
			return false;
		}
	}

	private warnJournalOnce(): void {
		if (this.journalWarned) return;
		this.journalWarned = true;
		try {
			if (this.ctx?.hasUI) {
				this.ctx.ui.notify(
					"pi-taskforce: the session would not accept a journal write. This answer is retried, but if pi stops now the last change may be lost.",
					"warning",
				);
			}
		} catch {
			// A vanished context cannot be notified.
		}
	}

	/**
	 * §12. Written before the question is shown, so a kill cannot lose the
	 * question. A v2 record names the call that asked: without that link a
	 * restored answer could only be guessed at.
	 */
	private writePendingRecord(
		id: string,
		envelope: AskEnvelope,
		sessionId: string | null,
		attribution: string | null,
		origin: AskOrigin,
	): PendingAskRecord {
		const record: PendingAskRecord = {
			v: 2,
			id,
			sessionId,
			createdAt: Date.now(),
			ask: envelope.ask,
			from: envelope.from,
			via: envelope.via ?? [],
			attribution,
			toolCallId: origin.toolCallId,
			assistantEntryId: origin.assistantEntryId,
		};
		this.pendingRecords.set(id, record);
		if (!this.append(PENDING_ENTRY, record)) {
			try {
				if (this.ctx?.hasUI) {
					this.ctx.ui.notify(
						"pi-taskforce: this question could not be written to the session, so it cannot be recovered if pi stops.",
						"warning",
					);
				}
			} catch {
				// A vanished context cannot be notified.
			}
		}
		return record;
	}

	/**
	 * Typing reaches the session at most one debounce behind. A boundary the user
	 * chose, such as hiding the ask, moving to another question, or submitting,
	 * is written at once.
	 */
	private journalDraft(id: string, draft: AskDraft, immediate: boolean): void {
		if (!this.tf.isRoot) return;
		this.draftValues.set(id, draft);
		const timer = this.draftTimers.get(id);
		if (timer) clearTimeout(timer);
		if (immediate) {
			this.draftTimers.delete(id);
			this.draftDeadlines.delete(id);
			this.writeDraft(id);
			return;
		}
		// The deadline belongs to the first unsaved change, not the latest key.
		// Continuous typing therefore reaches the session within one second of
		// the first keystroke, instead of being postponed indefinitely.
		const now = Date.now();
		const deadline = this.draftDeadlines.get(id) ?? now + DRAFT_DEBOUNCE_MS;
		this.draftDeadlines.set(id, deadline);
		const next = setTimeout(() => {
			this.draftTimers.delete(id);
			this.draftDeadlines.delete(id);
			this.writeDraft(id);
		}, Math.max(0, deadline - Date.now()));
		// A pending timer must not keep a stopping process alive.
		next.unref?.();
		this.draftTimers.set(id, next);
	}

	private writeDraft(id: string): void {
		const draft = this.draftValues.get(id);
		if (!draft) return;
		const key = JSON.stringify({ index: draft.index, answers: draft.answers });
		if (this.draftWritten.get(id) === key) return;
		const written = this.append(DRAFT_ENTRY, { v: 1, id, at: draft.at, index: draft.index, answers: draft.answers });
		// Marked written only after the append succeeded, so a failed write is
		// attempted again instead of being suppressed as a duplicate.
		if (!written) {
			const retry = setTimeout(() => {
				this.draftTimers.delete(id);
				this.writeDraft(id);
			}, DRAFT_DEBOUNCE_MS);
			retry.unref?.();
			this.draftTimers.set(id, retry);
			return;
		}
		this.draftWritten.set(id, key);
	}

	/** Writes the latest draft now, without waiting for the debounce. */
	private flushDraft(id: string): void {
		const timer = this.draftTimers.get(id);
		if (timer) clearTimeout(timer);
		this.draftTimers.delete(id);
		this.draftDeadlines.delete(id);
		this.writeDraft(id);
	}

	/** §12. Every draft is flushed before the session goes away: only a kill loses typing. */
	flushJournal(): void {
		// Nothing that cannot finish before the process ends is reported as a
		// failure: the pending entry and its saved answers are what the next run
		// restores, and no timer is left behind.
		this.deferredWake.clear();
		for (const id of [...this.draftValues.keys()]) this.flushDraft(id);
		for (const [id, how] of [...this.pendingDone]) this.writeDone(id, how);
	}

	/** A done entry is the end of an ask: no later scan can bring it back. */
	private writeDone(id: string, how: "answered" | "cancelled" | "unattended" | "recovered" | "discarded"): void {
		this.flushDraft(id);
		const written = this.append(DONE_ENTRY, { v: 1, id, at: Date.now(), how });
		if (!written) {
			// The marker keeps a later scan from offering a question whose answers
			// already reached the session; this retry is the belt to that braces.
			this.pendingDone.set(id, how);
			return;
		}
		this.pendingDone.delete(id);
		this.draftValues.delete(id);
		this.draftWritten.delete(id);
	}

	/** §13. A question whose session is shutting down is answered as cancelled. */
	cancelAll(reason: string): void {
		for (const entry of this.waitingQuestions) {
			entry.resolve(CANCELLED_RESULT);
			this.record(entry, `cancelled: ${reason}`);
		}
	}

	/** §14. Opening a waiting question on demand, from the subagent panel. */
	async openWaiting(reference: string, ctx: ExtensionContext): Promise<void> {
		const entry = this.waiting.get(reference);
		if (!entry) return;
		const result = await this.render(entry.envelope, ctx, entry.reference, {
			toolCallId: null,
			assistantEntryId: null,
		});
		entry.resolve(result);
		this.record(entry, "answered by the user");
	}

	// ------------------------------------------------------------- rendering

	/** How many asks are put away and waiting to be shown again. */
	get hiddenCount(): number {
		return (
			[...this.open.values()].filter((ask) => ask.hidden).length +
			[...this.recovered.values()].filter((recovered) => recovered.hidden).length
		);
	}

	/**
	 * §12. Put the ask away without answering it. The overlay is hidden, not
	 * closed: every answer, note and cursor position stays, and the terminal is
	 * free again for scrolling. Nothing is submitted or cancelled.
	 */
	private hideAsk(ask: OpenAsk): void {
		if (ask.hidden) return;
		ask.hidden = true;
		try {
			ask.handle?.setHidden(true);
		} catch {
			// A disposed overlay is already gone.
		}
		this.hooks.onChange();
	}

	/**
	 * §12. Show the ask that was put away, with its state intact. Without one,
	 * the visible ask takes the keys again. Returns false when nothing is open.
	 */
	reopen(): boolean {
		const asks = [...this.open.values()];
		const target = asks.find((ask) => ask.hidden) ?? (asks.length > 0 ? asks[asks.length - 1]! : null);
		if (target && target.handle) {
			target.hidden = false;
			try {
				target.handle.setHidden(false);
				target.handle.focus();
			} catch {
				// A disposed overlay cannot come back; the answer still reaches the agent.
			}
			this.hooks.onChange();
			return true;
		}
		// A recovered question has its own terminal copy; the phone bridge is not
		// this method's to reopen.
		const recovered =
			[...this.recovered.values()].find((candidate) => candidate.hidden && candidate.handle) ??
			[...this.recovered.values()].find((candidate) => candidate.handle);
		if (recovered?.handle) {
			recovered.hidden = false;
			try {
				recovered.handle.setHidden(false);
				recovered.handle.focus();
			} catch {
				// A disposed overlay cannot come back.
			}
			this.hooks.onChange();
			return true;
		}
		return false;
	}

	/**
	 * §12. Which surface is used follows what the process can actually render.
	 * Serialised on one promise, because both surfaces own the screen.
	 */
	private render(envelope: AskEnvelope, ctx: ExtensionContext, id: string, origin: AskOrigin): Promise<AskResult> {
		const attribution = attributionOf(envelope, this.tf.self?.uuid ?? null);
		const first = envelope.ask.questions[0]?.prompt ?? "";
		const open: OpenAsk = {
			id,
			envelope,
			sessionId: this.sessionId(),
			attribution,
			handle: null,
			hidden: false,
			close: null,
			suspended: false,
		};
		this.open.set(id, open);
		this.queuedRenders++;
		const run = this.screen.then(async () => {
			this.queuedRenders--;
			if (!ctx.hasUI) {
				this.open.delete(id);
				return UNATTENDED_RESULT;
			}
			if (ctx.mode !== "tui") {
				const result = await runDialogs(ctx.ui, envelope.ask);
				if (this.tf.isRoot) this.writeDone(id, result.outcome === "answered" ? "answered" : "cancelled");
				this.open.delete(id);
				return result;
			}
			let published = false;
			let closed = false;
			const closeRemote = (outcome: AskResult["outcome"], by: AskClosed["by"]) => {
				if (closed) return;
				closed = true;
				if (published) this.emit(ASK_CLOSE, { id, outcome, by } satisfies AskClosed);
			};
			const shown = ctx.ui.custom<AskResult>(
				(tui, theme, _keybindings, rawDone) => {
					open.close = () => {
						if (closed) return;
						closed = true;
						rawDone(CANCELLED_RESULT);
					};
					// §12. Whichever side answers first, this terminal or a remote such as a
					// phone, closes the ask on both. The answers are journalled and made
					// canonical before the overlay closes.
					const done = (result: AskResult, by: AskClosed["by"] = "terminal"): string | null => {
						if (closed) return null;
						if (open.suspended) {
							closed = true;
							rawDone(result);
							return null;
						}
						if (!this.tf.isRoot) {
							// An explicit cancel is a result too: save it before the call returns.
							this.saveChildSubmission(id, result, by);
							this.writeDone(id, result.outcome === "answered" ? "answered" : "cancelled");
							closed = true;
							rawDone(result);
							return null;
						}
						{
							const error = this.saveLiveSubmission(id, result, by);
							if (error) return error;
						}
						// The last state reaches the session before the ask is marked done,
						// so an answered question cannot come back as unanswered.
						this.writeDone(id, result.outcome === "answered" ? "answered" : "cancelled");
						closeRemote(result.outcome, by);
						rawDone(result);
						return null;
					};
					const remote: RemoteAsk = {
						id,
						ask: envelope.ask,
						from: attribution,
						at: Date.now(),
						answer: (input) => {
							if (closed) return "This ask was already answered.";
							const result = normalizeRemoteAnswer(envelope.ask, input);
							if (typeof result === "string") return result;
							const error = done(result, "remote");
							if (error) return error;
							return result.outcome === "cancelled" ? null : { pending: this.liveStatus(id) };
						},
					};
					published = true;
					this.emit(ASK_OPEN, remote);
					// §12. A question can arrive while the user looks elsewhere, so the
					// terminal is told, once, when it shows.
					if (this.tf.settings?.ask.notify !== false) {
						tui.terminal.write(attentionSequence(attribution ? `Question from ${attribution}` : "pi has a question", first));
					}
					return createAskOverlay({
						envelope,
						theme,
						tui,
						done,
						// The overlay names the agent a forked child's question came from, so
						// it does not read as the root's own question (§13).
						attribution,
						queued: () => this.queuedRenders,
						hide: () => this.hideAsk(open),
						initial: this.draftValues.get(id) ?? null,
						onDraft: (draft, immediate) => this.journalDraft(id, draft, immediate),
					});
				},
				{
					// An overlay rather than an inline component: the transcript stays
					// behind it, and it can be put away and shown again while it waits.
					overlay: true,
					overlayOptions: { width: "86%", maxHeight: "100%", margin: 1, anchor: "center" },
					onHandle: (handle) => {
						open.handle = handle;
					},
					blocked: { kind: "question", message: first },
				},
			);
			// A question torn down without an answer stays pending: the next process
			// can offer it again, with the last draft that reached the session.
			return shown.finally(() => {
				closeRemote("cancelled", "terminal");
				this.open.delete(id);
				this.flushDraft(id);
				this.hooks.onChange();
			});
		});
		this.screen = run.then(
			() => undefined,
			() => undefined,
		);
		return run.finally(() => {
			// A queued ask's header counts the ones behind it, so it redraws as they go.
			this.hooks.onChange();
		});
	}

	private emit(channel: string, data: unknown): void {
		try {
			this.pi.events?.emit(channel, data);
		} catch {
			// A listener's failure is not the ask's.
		}
	}

	/** Sends the envelope to whoever spawned this process and waits (§13). */
	private async relayUpward(
		envelope: AskEnvelope,
		ctx: ExtensionContext,
		id: string,
		_origin: AskOrigin,
	): Promise<{ result: AskResult; suspended: boolean }> {
		if (!ctx.hasUI) return { result: UNATTENDED_RESULT, suspended: false };
		const raw = await ctx.ui.input(encodeAsk(envelope));
		if (raw === undefined) {
			this.writeDone(id, "cancelled");
			return { result: CANCELLED_RESULT, suspended: false };
		}
		const result = decodeAskResult(raw) ?? CANCELLED_RESULT;
		// The answer is durable in this agent's session before it is reported.
		if (result.outcome === "answered") this.saveChildSubmission(id, result, "remote");
		this.writeDone(id, result.outcome === "answered" ? "answered" : "cancelled");
		return { result, suspended: false };
	}

	/**
	 * §13. Every exchange is recorded in this agent's session as an entry, not a
	 * message, so it never enters the context the model reads.
	 */
	private record(entry: WaitingQuestion, howAnswered: string): void {
		this.pi.appendEntry("pi-taskforce-ask", {
			from: entry.envelope.from,
			questions: entry.envelope.ask.questions.map((question) => ({
				id: question.id,
				prompt: question.prompt,
			})),
			howAnswered,
			waitedMs: Date.now() - entry.arrivedAt,
		});
	}
}

/** §12. The answers a visibility proof names; v1 records have one id. */
function visibleIdsOf(data: Record<string, unknown> | undefined): string[] {
	if (!data) return [];
	const ids: string[] = [];
	if (typeof data.id === "string") ids.push(data.id);
	if (Array.isArray(data.ids)) {
		for (const id of data.ids) if (typeof id === "string" && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * A bell, and a desktop notification for terminals that read OSC 777 (Ghostty,
 * WezTerm, iTerm2, foot). Terminals that do not read it ignore it.
 */
export function attentionSequence(title: string, body: string): string {
	const clean = (text: string) => text.replace(/[\u0000-\u001f\u007f;]/g, " ").slice(0, 200);
	return `\u0007\u001b]777;notify;${clean(title)};${clean(body)}\u0007`;
}

/** True when every question was left out, so the result carries no answer. */
function hasNoAnswer(result: AskResult): boolean {
	return result.answers.every((answer) => answer.omitted || answer.values.length === 0);
}

function isAgentRef(value: unknown): value is AskEnvelope["from"] {
	if (!value || typeof value !== "object") return false;
	const ref = value as Partial<AskEnvelope["from"]>;
	return typeof ref.agentId === "string" && typeof ref.agentType === "string" && typeof ref.depth === "number";
}

/**
 * §13. Who the overlay names. The hop nearest this agent is its own child, read
 * from its own record; anything past it is as the child reported it, and says so.
 */
export function attributionOf(envelope: AskEnvelope, selfId: string | null): string | null {
	const via = envelope.via ?? [];
	if (via.length === 0 && envelope.from.agentId === selfId) return null;
	const name = (ref: AskEnvelope["from"]) => `${ref.agentType} (${ref.agentId})`;
	if (via.length === 0) return name(envelope.from);
	return `${name(envelope.from)}, relayed by ${[...via].reverse().map(name).join(" via ")}`;
}

/**
 * §13. `answer_subagent` carries one string per question. Only a multiselect
 * reads a comma as a separator; in any other answer it is part of the text.
 */
function answerValues(question: Question, value: unknown): string[] {
	const parts = Array.isArray(value) ? value.map(String) : [String(value)];
	if (question.type !== "multiselect") return [parts.join(", ")];
	return parts.flatMap((part) => part.split(",")).map((part) => part.trim()).filter(Boolean);
}

function labelFor(question: Question, value: string): string {
	return question.options.find((option) => option.value === value)?.label ?? value;
}

/** §13. The question as the parent reads it, with the exact call that answers it. */
export function describeQuestion(entry: WaitingQuestion): string {
	const { envelope, reference } = entry;
	const lines: string[] = [
		`Your subagent ${envelope.from.agentType} (\`${envelope.from.agentId}\`) is asking you something and is blocked until you answer.`,
	];
	if (envelope.ask.context) lines.push("", envelope.ask.context);
	lines.push("");
	for (const question of envelope.ask.questions) {
		let line = `- \`${question.id}\` (${question.type}): ${question.prompt}`;
		if (question.options.length > 0) {
			line += `\n    options: ${question.options.map((option) => `${option.value} — ${option.label}`).join("; ")}`;
		}
		if (question.optional) line += "\n    optional";
		lines.push(line);
	}
	lines.push(
		"",
		"You have three ways forward: answer with `answer_subagent`; call `ask` yourself, if what is missing",
		"is genuinely the user's to give; or work until you know, and answer then.",
		"",
		"The call that answers it:",
		"```json",
		JSON.stringify(
			{
				reference,
				answers: envelope.ask.questions.map((question) => ({
					id: question.id,
					value: exampleValue(question),
				})),
			},
			null,
			2,
		),
		"```",
	);
	return lines.join("\n");
}

/**
 * §13. The example call is built from the question's own ids and a plausible
 * value, so it is copyable as it stands: a model shown a placeholder id reaches
 * for the answer as the id often enough to matter.
 */
function exampleValue(question: Question): unknown {
	if (question.type === "multiselect") {
		const first = question.options[0]?.value;
		return first ? [first] : [];
	}
	if (question.options.length > 0) {
		return question.default ?? question.options[0]?.value ?? "";
	}
	if (question.type === "confirm") return "yes";
	return "your answer";
}

export { renderAskResult };
