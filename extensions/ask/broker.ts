/**
 * §12, §13. Asking, and where a question goes.
 *
 * One broker per process. It owns three things: this agent's own asks, the asks
 * its children send it, and the single screen or single parent both of them have
 * to share, because two asks running at once would fight over the user.
 */

import { randomUUID } from "node:crypto";
import { processToken } from "./process.js";

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
	type AskDraft,
	type EntryLike,
	DRAFT_DEBOUNCE_MS,
	DRAFT_ENTRY,
	DONE_ENTRY,
	PENDING_ENTRY,
	type PendingAskRecord,
	type DispatchAskRecord,
	SUBMIT_ENTRY,
	type SubmitAskRecord,
	deliveredRecoveries,
	draftFromSubmit,
	recoverableAsks,
	recoveredMessage,
	recoveryMarker,
	DISPATCH_ENTRY,
} from "./journal.js";
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
}

/** A question from an earlier process that is readable, answerable and not live. */
interface Recovered {
	pending: PendingAskRecord;
	draft: AskDraft | null;
	submitting: boolean;
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
	/** What the delivered user message carries, so the entry can be found. */
	marker: string;
	/** The answers the user already sent, so a lost delivery loses nothing. */
	submitted: SubmitAskRecord | null;
	/** The process that called sendUserMessage for those answers, if any did. */
	dispatch: DispatchAskRecord | null;
	/** The send was made and no message proves it finished. */
	unconfirmed: boolean;
	/** Why the last attempt did not finish, as the user is told. */
	lastError: string | null;
}

/** One bounded wait for the session to accept a recovered submission. */
interface Acceptance {
	recovered: Recovered;
	by: AskClosed["by"];
	resolve(accepted: boolean): void;
	timer: ReturnType<typeof setTimeout> | null;
	startedAt: number;
	attempts: number;
	finished: boolean;
}

/**
 * What both surfaces are told when answers were dispatched but the session has
 * not shown them. A restart is the only safe retry: until then the message may
 * still be queued inside this process.
 */
export const DELIVERY_UNCONFIRMED = "Answers saved; delivery is not confirmed. Restart Pi to retry safely.";
/** After this long without the user message, the delivery is reported unconfirmed. */
const ACCEPTANCE_WATCHDOG_MS = 20_000;
/** Bounded backoff; an event such as message_start also checks immediately. */
const ACCEPTANCE_STEPS = [100, 250, 500, 1000, 2000, 5000] as const;

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
	private readonly pendingDone = new Map<string, "answered" | "cancelled" | "recovered">();
	/** A broken session is reported once, not on every keystroke. */
	private journalWarned = false;
	/** The bounded waits for a recovered submission to become a user message. */
	private readonly acceptance = new Map<string, Acceptance>();
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
	async ask(ask: Ask, ctx: ExtensionContext): Promise<AskResult> {
		this.ctx = ctx;
		const self = this.tf.self;
		const envelope: AskEnvelope = {
			from: { agentId: self.uuid, agentType: self.type ?? "root", depth: this.tf.depth },
			asksUserDirectly: this.tf.asksUserDirectly,
			ask,
		};
		return this.tf.isRoot ? this.render(envelope, ctx) : this.relayUpward(envelope, ctx);
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
			void (this.tf.isRoot ? this.render(envelope, ctx) : this.relayUpward(envelope, ctx))
				.then((result) => pending.answer(result))
				.catch(() => pending.answer(CANCELLED_RESULT));
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
	 * never finished, and offers each one again. A question with a done entry, one
	 * from another session, or one from a fork's copied parent history is not
	 * restored: the branch and the session id decide, not a guess.
	 */
	restore(ctx: ExtensionContext): number {
		if (!this.tf.isRoot) return 0;
		this.ctx = ctx;
		// A branch change ends every wait: the answers belong to the branch that
		// asked, and a queued delivery for the old one must not finish this one.
		this.clearAcceptance();
		let sessionId: string | null = null;
		let branch: readonly EntryLike[] = [];
		try {
			sessionId = ctx.sessionManager.getSessionId() ?? null;
			if (!sessionId) return 0;
			branch = ctx.sessionManager.getBranch();
		} catch {
			return 0;
		}
		const delivered = deliveredRecoveries(branch);
		const next = new Map<string, Recovered>();
		for (const found of recoverableAsks(branch, sessionId)) {
			// A message carrying the marker is proof the answers reached the session,
			// even when the process died before the done entry could be written.
			if (delivered.has(found.pending.id)) continue;
			const known = this.recovered.get(found.pending.id);
			if (known) {
				if (found.draft) known.draft = found.draft;
				known.submitted = found.submitted;
				known.dispatch = found.dispatch;
				// The watch belonged to the previous instance and is gone with it.
				// Retries stay guarded by the dispatch token, not by this flag.
				known.submitting = false;
				known.unconfirmed = found.submitted !== null;
				known.lastError = found.submitted ? this.unconfirmedMessage(known) : null;
				next.set(found.pending.id, known);
				continue;
			}
			const recovered: Recovered = {
				pending: found.pending,
				draft: found.draft,
				submitted: found.submitted,
				dispatch: found.dispatch,
				unconfirmed: found.submitted !== null,
				lastError: null,
				submitting: false,
				withdrawn: false,
				handle: null,
				hidden: false,
				close: null,
				marker: recoveryMarker(found.pending.id),
			};
			if (found.submitted) recovered.lastError = this.unconfirmedMessage(recovered);
			this.recovered.set(found.pending.id, recovered);
			next.set(found.pending.id, recovered);
			// The phone gets the same widget and the same bridge as a live ask, so it
			// can answer a question whose terminal process is gone.
			this.emitRecovered(recovered);
		}
		// §12. A branch change or a session switch takes back the questions that are
		// not on the new branch. Their pending entries stay: going back offers them
		// again, and a stale callback cannot answer into the wrong branch.
		for (const [id, recovered] of [...this.recovered]) {
			if (next.has(id)) continue;
			this.withdrawRecovered(recovered);
		}
		return next.size;
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
		recovered.submitting = false;
		this.stopAcceptance(recovered.pending.id, false);
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
			from: "recovered from the previous run",
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
		const attribution = "recovered from the previous run";
		const run = this.screen.then(async () => {
			// The phone may have answered while this waited for the screen.
			if (!this.stillHere(recovered)) return;
			const shown = ctx.ui.custom<AskResult>(
				(tui, theme, _keybindings, rawDone) => {
					// Whichever side answers first closes this copy, like a live ask.
					recovered.close = rawDone;
					const done = (result: AskResult) => {
						// A cancel that arrives after the message landed is not a cancel,
						// even if no acceptance check has run yet.
						if (result.outcome === "cancelled" && !this.finishAccepted(recovered, "terminal")) {
							this.finishRecovered(recovered, "cancelled", "terminal", "pi-taskforce: the recovered question was cancelled.", result);
						}
						rawDone(result);
					};
					return createAskOverlay({
						envelope,
						theme,
						tui,
						done,
						attribution,
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
	 * §12. Recovered answers reach the root as a new user message, never as the
	 * result of a tool call that has already ended.
	 *
	 * Nothing is dispatched while a turn runs or a message is queued: the answers
	 * are saved and the caller is told so, retryable once the session is quiet.
	 * "Quiet" is only a snapshot, so the send itself is still a follow-up; that
	 * covers a turn that starts between the check and the call without ever
	 * interrupting one.
	 *
	 * `pi.sendUserMessage()` returns void and reports failures elsewhere, so a
	 * synchronous return proves nothing. The submission is journalled before the
	 * send, and the answer counts only when the marked user message is on the
	 * session branch. A dispatch that is never observed stays pending with its
	 * saved answers and is never reported as accepted.
	 */
	/**
	 * The terminal's Send. Returns a problem string while the overlay stays open,
	 * or null when the question is finished (accepted or cancelled before any
	 * dispatch). A message it cannot prove is never called "sent".
	 */
	private async submitFromTerminal(recovered: Recovered, result: AskResult): Promise<string | null> {
		if (result.outcome === "cancelled") {
			// A cancel that arrives after the message landed is not a cancel: the
			// answer is in the session, and the observer may simply not have run.
			if (this.finishAccepted(recovered, "terminal")) return null;
			if (this.dispatchBlocksCancel(recovered)) return DELIVERY_UNCONFIRMED;
			this.finishRecovered(
				recovered,
				"cancelled",
				"terminal",
				"pi-taskforce: the recovered question was cancelled.",
				result,
			);
			return null;
		}
		const started = this.startRecovered(recovered, result, "terminal");
		if (started.pending) return started.pending.message;
		if (started.error) return started.error;
		if (!started.accepted) return null;
		if (await started.accepted) return null;
		if (!this.stillHere(recovered)) return null;
		return this.pendingStatus(recovered).message;
	}

	/** The phone's answer: durable before any admission, accepted later. */
	private answerRecovered(recovered: Recovered, input: unknown): AnswerReply {
		if (!this.stillHere(recovered)) return "This question is no longer waiting on this branch.";
		const result = normalizeRemoteAnswer(recovered.pending.ask, input);
		if (typeof result === "string") return result;
		if (result.outcome === "cancelled") {
			if (this.finishAccepted(recovered, "remote")) return null;
			if (this.dispatchBlocksCancel(recovered)) return { pending: this.pendingStatus(recovered) };
			this.finishRecovered(
				recovered,
				"cancelled",
				"remote",
				"pi-taskforce: the recovered question was cancelled.",
				result,
			);
			return null;
		}
		// A repeated tap while the first submit is in flight is the same answer,
		// not a second one: it gets the same status, and nothing is sent twice.
		if (recovered.submitting) return { pending: this.pendingStatus(recovered) };
		const started = this.startRecovered(recovered, result, "remote");
		if (started.pending) return { pending: started.pending };
		if (started.error) {
			// A dispatch this process made is a status, not a failure: the phone keeps
			// the card and shows the reason with the restart instruction.
			if (recovered.dispatch) return { pending: { ...this.pendingStatus(recovered), message: started.error } };
			return started.error;
		}
		if (!this.stillHere(recovered)) return null;
		return { pending: this.pendingStatus(recovered) };
	}

	/**
	 * §12. Saved, then dispatched once. The order is the guarantee: the payload is
	 * in the journal before the session is told anything, and the dispatch record
	 * that names this process is written before `sendUserMessage()` is called, so
	 * an unconfirmed delivery can never be mistaken for one that never happened.
	 */
	private startRecovered(
		recovered: Recovered,
		result: AskResult,
		by: AskClosed["by"],
	): { error: string | null; pending?: PendingDelivery; accepted: Promise<boolean> | null } {
		if (!this.stillHere(recovered)) {
			return { error: "This question is no longer waiting on this branch.", accepted: null };
		}
		const ctx = this.ctx;
		if (!ctx) return { error: "There is no live session to send these answers to.", accepted: null };
		// Accepted earlier and not yet seen by this instance: the message wins.
		if (this.markerOnBranch(recovered)) {
			this.finishRecovered(
				recovered,
				"recovered",
				by,
				"pi-taskforce: the recovered answers are already in the session.",
				{ outcome: "answered", answers: [] },
			);
			return { error: null, accepted: null };
		}
		// Dispatched by this very process and unconfirmed: the message may still be
		// queued. Nothing may be sent again until a restart, and nothing may be
		// cancelled as if it never happened.
		if (recovered.dispatch && recovered.dispatch.token === processToken()) {
			return { error: DELIVERY_UNCONFIRMED, accepted: null };
		}
		// A second Send from a card that came back empty must not replace the
		// answers already saved: only an answer the user actually gave wins.
		const payload =
			recovered.submitted && hasNoAnswer(result) && !hasNoAnswer(recovered.submitted.result)
				? recovered.submitted.result
				: result;
		const saveError = this.saveSubmission(recovered, payload, by);
		if (saveError) return { error: saveError, accepted: null };
		// Quiet start: a turn that is already running, or a message already queued,
		// gets no dispatch at all. The answers are durable, so this is a status with
		// a retry, not a failed send — and no dispatch record is written, because
		// nothing was sent.
		const busy = this.busyReason(ctx);
		if (busy) return { error: null, pending: { ...this.pendingStatus(recovered), message: busy }, accepted: null };
		const noCredentials = this.refuseWithoutCredentials(ctx);
		if (noCredentials) {
			// Saved and never dispatched: retrying is safe, here or after a restart.
			recovered.unconfirmed = false;
			recovered.submitting = false;
			recovered.lastError = noCredentials;
			return { error: null, pending: { ...this.pendingStatus(recovered), message: noCredentials }, accepted: null };
		}
		const token = processToken();
		const dispatch: DispatchAskRecord = {
			v: 1,
			id: recovered.pending.id,
			sessionId: this.sessionId(),
			at: Date.now(),
			token,
		};
		// Written immediately before the call: if it cannot be written, nothing is
		// sent, because a send with no record could never be reasoned about again.
		if (!this.append(DISPATCH_ENTRY, dispatch)) {
			return {
				error: "The delivery could not be recorded in the session, so nothing was sent. The answers are saved; try again.",
				accepted: null,
			};
		}
		recovered.dispatch = dispatch;
		recovered.submitting = true;
		recovered.lastError = null;
		const accepted = this.watchAcceptance(recovered, by);
		const text = recoveredMessage(recovered.pending, payload);
		try {
			// A follow-up is safe whether pi is idle or already streaming: idle starts
			// a turn, busy queues it, and the call cannot be rejected for being busy.
			this.pi.sendUserMessage(text, { deliverAs: "followUp" });
		} catch (error) {
			recovered.submitting = false;
			this.stopAcceptance(recovered.pending.id, false);
			// The call threw before anything was accepted. The dispatch record stays:
			// only a restart may treat the send as safely repeatable.
			this.markUnconfirmed(recovered, DELIVERY_UNCONFIRMED);
			return {
				error: `The answers were not sent: ${error instanceof Error ? error.message : String(error)}. ${DELIVERY_UNCONFIRMED}`,
				accepted: null,
			};
		}
		return { error: null, accepted };
	}

	/** The answers are durable in the journal. Dispatch is a separate record. */
	private saveSubmission(recovered: Recovered, result: AskResult, by: AskClosed["by"]): string | null {
		const record: SubmitAskRecord = {
			v: 1,
			id: recovered.pending.id,
			at: Date.now(),
			by,
			result,
			sessionId: recovered.pending.sessionId,
		};
		if (!this.append(SUBMIT_ENTRY, record)) {
			return "The answers could not be saved to the session, so nothing was sent. Nothing was lost; try again.";
		}
		recovered.submitted = record;
		recovered.unconfirmed = false;
		recovered.lastError = null;
		recovered.draft = draftFromSubmit(record, recovered.pending.ask);
		this.draftValues.set(recovered.pending.id, recovered.draft);
		return null;
	}

	/**
	 * The branch is the authority: a message already on it finishes the question,
	 * whatever a late cancel says. The send is never repeated either way.
	 */
	private finishAccepted(recovered: Recovered, by: AskClosed["by"]): boolean {
		if (!this.markerOnBranch(recovered)) return false;
		this.finishRecovered(
			recovered,
			"recovered",
			by,
			"pi-taskforce: the recovered answers are already in the session.",
			{ outcome: "answered", answers: [] },
		);
		return true;
	}

	/** True when a send from this process may still land; it cannot be recalled. */
	private dispatchedHere(recovered: Recovered): boolean {
		if (!recovered.dispatch) return false;
		if (recovered.dispatch.token !== processToken()) return false;
		return !this.markerOnBranch(recovered);
	}

	/** A dispatched answer may not be cancelled as if it had never been sent. */
	private dispatchBlocksCancel(recovered: Recovered): boolean {
		return this.dispatchedHere(recovered);
	}

	/**
	 * What the user and the phone are told about an unfinished submission. A send
	 * from this process is never offered for retry: only a restart empties the
	 * queue that might still deliver it.
	 */
	private pendingStatus(recovered: Recovered): PendingDelivery {
		if (recovered.dispatch && recovered.dispatch.token === processToken()) {
			return { state: "dispatched", message: DELIVERY_UNCONFIRMED, retry: false };
		}
		if (recovered.dispatch) {
			return {
				state: "dispatched",
				message:
					"Answers saved. Delivery from the previous run is not confirmed; sending them again may duplicate them.",
				retry: true,
			};
		}
		return {
			state: "saved",
			message: "Answers saved. They have not been sent yet; send them again to deliver them.",
			retry: true,
		};
	}

	private unconfirmedMessage(recovered: Recovered): string {
		return this.pendingStatus(recovered).message;
	}

	/** True while a send from this process may still land: navigation must wait. */
	hasUnresolvedDispatch(): boolean {
		for (const recovered of this.recovered.values()) {
			if (recovered.withdrawn) continue;
			if (this.dispatchedHere(recovered)) return true;
		}
		return false;
	}

	/**
	 * Why a dispatch has to wait, or null when the session looks quiet. A busy or
	 * queued session is only saved, never sent: the answers stay retryable and the
	 * existing turn is not touched.
	 */
	private busyReason(ctx: ExtensionContext): string | null {
		let idle = true;
		let queued = false;
		try {
			idle = ctx.isIdle() !== false;
		} catch {
			// An unreadable state is not a reason to refuse a saved answer.
		}
		try {
			queued = ctx.hasPendingMessages() === true;
		} catch {
			// Same: an unsupported check cannot prove a queue.
		}
		if (!idle) return "Answers saved. Pi is still working, so they were not sent yet; send them again when the current turn has finished.";
		if (queued) return "Answers saved. Pi already has a message queued, so they were not sent yet; send them again once that message has been taken.";
		return null;
	}

	/**
	 * The same rule pi applies itself: stored or environment credentials, or a
	 * provider that reports itself configured. A local endpoint that needs no key
	 * is configured, and an unreadable registry never blocks a working provider.
	 */
	private refuseWithoutCredentials(ctx: ExtensionContext): string | null {
		const model = ctx.model;
		if (!model) return "No model is selected, so the answers were not sent. The answers are saved.";
		try {
			const registry = ctx.modelRegistry;
			if (!registry) return null;
			if (registry.hasConfiguredAuth(model)) return null;
			if (registry.getProviderAuthStatus(model.provider).configured) return null;
			return `No credentials are configured for "${model.provider}", so the answers were not sent. The answers are saved.`;
		} catch {
			return null;
		}
	}

	private markUnconfirmed(recovered: Recovered, message: string): void {
		recovered.submitting = false;
		recovered.unconfirmed = true;
		recovered.lastError = message;
		try {
			if (this.ctx?.hasUI) this.ctx.ui.notify(`pi-taskforce: ${message}`, "warning");
		} catch {
			// A vanished context cannot be notified.
		}
		this.hooks.onChange();
	}

	/**
	 * §12. Event-driven acceptance. `message_start` fires before the session entry
	 * exists, so it is a trigger, not proof: only a matching user message on the
	 * branch finishes the question. Between events a bounded backoff rechecks; the
	 * watchdog only stops waiting and says the delivery is unconfirmed, because a
	 * queued send from this process can still land.
	 */
	onMessageStart(ctx: ExtensionContext, message: { role?: unknown }): void {
		if (message?.role !== "user") return;
		this.ctx = ctx ?? this.ctx;
		this.pokeAcceptance();
	}

	/** A turn boundary can flush a queued follow-up; check without waiting. */
	pokeAcceptance(): void {
		for (const watch of [...this.acceptance.values()]) {
			if (!this.checkAcceptance(watch)) this.arm(watch, 25);
		}
		// The watchdog stops waiting, but a message that arrives later still
		// finishes the question: an unanswered-but-saved ask is never dead.
		for (const recovered of [...this.recovered.values()]) {
			if (this.acceptance.has(recovered.pending.id)) continue;
			if (!recovered.submitted || !this.stillHere(recovered)) continue;
			if (!this.markerOnBranch(recovered)) continue;
			this.finishRecovered(
				recovered,
				"recovered",
				recovered.submitted.by,
				"pi-taskforce: the recovered answers were accepted as a new user message.",
				{ outcome: "answered", answers: [] },
			);
		}
	}

	private watchAcceptance(recovered: Recovered, by: AskClosed["by"]): Promise<boolean> {
		const id = recovered.pending.id;
		this.stopAcceptance(id, false);
		return new Promise<boolean>((resolve) => {
			const watch: Acceptance = {
				recovered,
				by,
				resolve,
				timer: null,
				startedAt: Date.now(),
				attempts: 0,
				finished: false,
			};
			this.acceptance.set(id, watch);
			this.arm(watch, 0);
		});
	}

	private arm(watch: Acceptance, delay: number): void {
		if (watch.finished) return;
		if (watch.timer) clearTimeout(watch.timer);
		const timer = setTimeout(() => {
			watch.timer = null;
			if (watch.finished) return;
			watch.attempts++;
			if (this.checkAcceptance(watch)) return;
			if (Date.now() - watch.startedAt >= ACCEPTANCE_WATCHDOG_MS) {
				this.expireAcceptance(watch);
				return;
			}
			const step = ACCEPTANCE_STEPS[Math.min(watch.attempts - 1, ACCEPTANCE_STEPS.length - 1)]!;
			this.arm(watch, step);
		}, delay);
		// A pending check must not keep a stopping process alive.
		timer.unref?.();
		watch.timer = timer;
	}

	/** True when the watch is settled. */
	private checkAcceptance(watch: Acceptance): boolean {
		if (watch.finished) return true;
		if (!this.stillHere(watch.recovered)) {
			this.settle(watch, false);
			return true;
		}
		if (this.markerOnBranch(watch.recovered)) {
			this.settle(watch, true);
			this.finishRecovered(
				watch.recovered,
				"recovered",
				watch.by,
				"pi-taskforce: the recovered answers were accepted as a new user message.",
				{ outcome: "answered", answers: [] },
			);
			return true;
		}
		return false;
	}

	private expireAcceptance(watch: Acceptance): void {
		this.settle(watch, false);
		this.markUnconfirmed(watch.recovered, DELIVERY_UNCONFIRMED);
	}

	private settle(watch: Acceptance, accepted: boolean): void {
		if (watch.finished) return;
		watch.finished = true;
		if (watch.timer) clearTimeout(watch.timer);
		watch.timer = null;
		this.acceptance.delete(watch.recovered.pending.id);
		watch.resolve(accepted);
	}

	private stopAcceptance(id: string, accepted: boolean): void {
		const watch = this.acceptance.get(id);
		if (watch) this.settle(watch, accepted);
	}

	private clearAcceptance(): void {
		for (const watch of [...this.acceptance.values()]) this.settle(watch, false);
	}

	private markerOnBranch(recovered: Recovered): boolean {
		try {
			const branch = this.ctx?.sessionManager.getBranch() ?? [];
			return deliveredRecoveries(branch).has(recovered.pending.id);
		} catch {
			return false;
		}
	}

	private finishRecovered(
		recovered: Recovered,
		how: "cancelled" | "recovered",
		by: AskClosed["by"],
		notice: string,
		result: AskResult,
	): void {
		if (recovered.withdrawn) return;
		this.stopAcceptance(recovered.pending.id, false);
		this.writeDone(recovered.pending.id, how);
		this.recovered.delete(recovered.pending.id);
		// Whichever side finished it, a terminal copy must not stay open showing a
		// question that is already accepted (a terminal submit can outlive the
		// watchdog and then see the message arrive).
		const close = recovered.close;
		recovered.close = null;
		recovered.handle = null;
		if (close) {
			try {
				close(result);
			} catch {
				// A disposed overlay is already gone.
			}
		}
		this.emit(ASK_CLOSE, {
			id: recovered.pending.id,
			outcome: how === "cancelled" ? "cancelled" : "answered",
			by,
		} satisfies AskClosed);
		try {
			if (this.ctx?.hasUI) this.ctx.ui.notify(notice, "info");
		} catch {
			// A vanished context cannot be notified.
		}
		this.hooks.onChange();
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

	/** Written before the question is shown, so a kill cannot lose the question. */
	private writePending(open: OpenAsk): void {
		const record: PendingAskRecord = {
			v: 1,
			id: open.id,
			sessionId: open.sessionId,
			createdAt: Date.now(),
			ask: open.envelope.ask,
			from: open.envelope.from,
			via: open.envelope.via ?? [],
			attribution: open.attribution,
		};
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
		// A watch that cannot finish before the process ends is not a failure to
		// report: the pending entry and its saved answers are what the next run
		// restores, and no timer is left behind.
		this.clearAcceptance();
		for (const id of [...this.draftValues.keys()]) this.flushDraft(id);
		for (const [id, how] of [...this.pendingDone]) this.writeDone(id, how);
	}

	/** A done entry is the end of an ask: no later scan can bring it back. */
	private writeDone(id: string, how: "answered" | "cancelled" | "recovered"): void {
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
		const result = await this.render(entry.envelope, ctx);
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
	private render(envelope: AskEnvelope, ctx: ExtensionContext): Promise<AskResult> {
		const attribution = attributionOf(envelope, this.tf.self?.uuid ?? null);
		const first = envelope.ask.questions[0]?.prompt ?? "";
		// Stable for the life of the question and unique across processes.
		const id = `ask-${randomUUID()}`;
		const open: OpenAsk = {
			id,
			envelope,
			sessionId: this.sessionId(),
			attribution,
			handle: null,
			hidden: false,
		};
		this.open.set(id, open);
		// §12. Written when the ask is queued, not when it reaches the screen. A
		// second question waiting behind the first must survive a kill too.
		if (this.tf.isRoot && ctx.hasUI) this.writePending(open);
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
					// §12. Whichever side answers first, this terminal or a remote such as a
					// phone, closes the ask on both.
					const done = (result: AskResult, by: AskClosed["by"] = "terminal") => {
						if (closed) return;
						// The last state reaches the session before the ask is marked done,
						// so an answered question cannot come back as unanswered.
						if (this.tf.isRoot) this.writeDone(id, result.outcome === "answered" ? "answered" : "cancelled");
						closeRemote(result.outcome, by);
						rawDone(result);
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
							done(result, "remote");
							return null;
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
	private async relayUpward(envelope: AskEnvelope, ctx: ExtensionContext): Promise<AskResult> {
		if (!ctx.hasUI) return UNATTENDED_RESULT;
		const raw = await ctx.ui.input(encodeAsk(envelope));
		if (raw === undefined) return CANCELLED_RESULT;
		return decodeAskResult(raw) ?? CANCELLED_RESULT;
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
