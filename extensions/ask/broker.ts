/**
 * §12, §13. Asking, and where a question goes.
 *
 * One broker per process. It owns three things: this agent's own asks, the asks
 * its children send it, and the single screen or single parent both of them have
 * to share, because two asks running at once would fight over the user.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { PendingAsk } from "../agents/child.js";
import type { AgentId } from "../agents/records.js";
import type { Taskforce } from "../runtime.js";
import { type AskEnvelope, CANCELLED_RESULT, UNATTENDED_RESULT, decodeAskResult, encodeAsk } from "./protocol.js";
import type { Ask, AskResult, Question } from "./schema.js";
import { renderAskResult, validateAsk } from "./schema.js";
import { runDialogs } from "./dialogs.js";
import { createAskOverlay } from "./overlay.js";
import { ASK_CLOSE, ASK_OPEN, type AskClosed, type RemoteAsk, normalizeRemoteAnswer } from "./remote.js";

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

export class AskBroker {
	/** Child questions waiting on this agent's own answer, in arrival order. */
	private readonly waiting = new Map<string, WaitingQuestion>();
	/** §12. Two asks never run at once; a second one waits for the first. */
	private screen: Promise<void> = Promise.resolve();
	private nextReference = 1;
	private nextShown = 1;
	/** Asks waiting for the screen behind the one showing. */
	private queuedRenders = 0;
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

	/**
	 * §12. Which surface is used follows what the process can actually render.
	 * Serialised on one promise, because both surfaces own the screen.
	 */
	private render(envelope: AskEnvelope, ctx: ExtensionContext): Promise<AskResult> {
		this.queuedRenders++;
		const run = this.screen.then(async () => {
			this.queuedRenders--;
			if (!ctx.hasUI) return UNATTENDED_RESULT;
			if (ctx.mode !== "tui") return runDialogs(ctx.ui, envelope.ask);
			const attribution = attributionOf(envelope, this.tf.self?.uuid ?? null);
			const first = envelope.ask.questions[0]?.prompt ?? "";
			const id = `ask-${process.pid}-${this.nextShown++}`;
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
					});
				},
				{ blocked: { kind: "question", message: first } },
			);
			// An overlay torn down without an answer still closes the remote copy.
			return shown.finally(() => closeRemote("cancelled", "terminal"));
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
