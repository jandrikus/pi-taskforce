/**
 * §8. How a subagent process runs, and §9's live view of it.
 *
 * The parent reads the child's whole run off the event stream: its tool calls,
 * its streamed text, its turns, its usage, its retries and its compactions.
 * Nothing about what the child is doing is written down: a stored copy of what a
 * process is doing is wrong the moment that process dies (§9).
 */

import { type AskEnvelope, decodeAsk, encodeAskResult } from "../ask/protocol.js";
import type { AskResult } from "../ask/schema.js";
import type { ThinkingLevel } from "./definitions.js";
import type { ModelChoice } from "./models.js";
import { RpcProcess, type RpcMessage } from "./rpc.js";

/** §9. A child's status, read from the run driving it. `failed` is stored. */
export type ChildLiveStatus = "running" | "compacting" | "idle";

export interface UsageReading {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
	/** True when the run has ended, so the reading is history (§9). */
	stale: boolean;
}

export interface LaunchSpec {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	/** The first prompt, sent once the child is up so its size is unbounded (§8). */
	task: string;
	silenceTimeoutMs: number;
	/** 0 means no wall-clock limit at all (§6). */
	timeoutMs: number;
	/**
	 * §6. The model and thinking level this child was launched with. Null for a
	 * forked child, which carries its parent's own prompt and model.
	 */
	model: ModelChoice | null;
	thinking: ThinkingLevel | null;
}

export interface RunHooks {
	/** The child reported its session file; the path is recorded at once (§8). */
	onSessionFile(path: string): void;
	/** A question arrived from the child, and is waiting for an answer (§13). */
	onAsk(pending: PendingAsk): void;
	/** The run ended, for whatever reason. */
	onEnd(outcome: RunOutcome): void;
	/** Anything at all changed, so a widget watching the run can redraw (§14). */
	onUpdate(): void;
	/**
	 * A read-only projection of the run's stream, for observers that must not
	 * touch it (Pilot). Optional, so a terminal-only use carries no extra work.
	 */
	onActivity?(event: ChildActivity): void;
}

/** What a child is doing, as an observer may see it. Deltas are not cumulative. */
export type ChildActivity =
	| { kind: "status"; status: ChildLiveStatus; activity: string; waiting: boolean; runElapsedMs: number }
	| { kind: "message_start" }
	| { kind: "message_end" }
	| { kind: "delta"; index: number; channel: "text" | "thinking"; delta: string }
	| { kind: "tool_start"; toolCallId: string; name: string; args: string }
	| { kind: "tool_update"; toolCallId: string; output: string }
	| { kind: "tool_end"; toolCallId: string; isError: boolean };

export interface PendingAsk {
	requestId: string;
	envelope: AskEnvelope;
	arrivedAt: number;
	answer(result: AskResult): void;
}

export interface RunOutcome {
	/**
	 * §10. The text of the child's last assistant message, which is its result.
	 * A run that failed or was stopped still carries what it wrote last.
	 */
	result: string | null;
	failed: boolean;
	/** Why the run ended, in words the parent can be told. */
	reason: string | null;
	/** §8. Whatever the child wrote to stderr, so a failure gives the error. */
	errorOutput: string | null;
	usage: UsageReading;
}

/** How much of the streaming text is kept; only the widget reads it. */
const STREAM_TAIL_CHARS = 4096;

/** How much of a tool's arguments or partial output an observer receives. */
const ARGS_CHARS = 4000;
const OUTPUT_CHARS = 4000;

function jsonOf(value: unknown): string {
	if (value === undefined) return "";
	try {
		const text = JSON.stringify(value);
		return typeof text === "string" ? text.slice(0, ARGS_CHARS) : "";
	} catch {
		return "";
	}
}

/** The text of a result, newest end kept, the way the terminal view shows it. */
function tailText(result: unknown, limit: number): string {
	if (!result) return "";
	if (typeof result === "string") return result.length > limit ? `…${result.slice(-limit)}` : result;
	const content = Array.isArray(result) ? result : (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	const text = content
		.filter((part): part is { type: string; text: string } =>
			Boolean(part) && part.type === "text" && typeof part.text === "string",
		)
		.map((part) => part.text)
		.join("\n");
	return text.length > limit ? `…${text.slice(-limit)}` : text;
}

export class ChildRun {
	private readonly process: RpcProcess;
	private readonly hooks: RunHooks;
	private readonly spec: LaunchSpec;

	private startedAt = Date.now();
	private endedAt: number | null = null;
	private lastEventAt = Date.now();
	private compacting = false;
	private ended = false;
	/** §10. The last assistant text the child wrote, kept as it streams in. */
	private lastText: string | null = null;
	/** True between the end of a run and the start of the next: the child is done for now. */
	private idle = false;
	/** §10. How the child's last model call ended, so a failed final call is not read as a finish. */
	private lastStop: { reason: string; error: string | null } | null = null;
	/** Set by `stop`, so the exit it causes is not read as a crash. */
	private stopping = false;
	private failureReason: string | null = null;
	private sessionFile: string | null = null;

	private usage: UsageReading = { tokens: null, contextWindow: null, percent: null, stale: false };
	/** The last few tool names, for the widget; the count is kept apart so the list stays short. */
	private readonly recentTools: string[] = [];
	private toolCalls = 0;
	private turns = 0;
	/** The tail of the text streaming now, for the widget. */
	private streaming = "";
	/** Last projected status, so an unchanged one is not sent again. */
	private observedStatus = "";
	/** Tool output is throttled the way the terminal view is (§9, §14). */
	private lastToolUpdateAt = 0;

	/** An outstanding question freezes both watchdogs entirely (§8). */
	private openAsk: PendingAsk | null = null;
	private answeringMs = 0;
	private answeringSince: number | null = null;

	private watchdog: NodeJS.Timeout | null = null;
	private readonly finished: Promise<RunOutcome>;
	private finish!: (outcome: RunOutcome) => void;

	constructor(spec: LaunchSpec, hooks: RunHooks) {
		this.spec = spec;
		this.hooks = hooks;
		this.finished = new Promise<RunOutcome>((resolve) => {
			this.finish = resolve;
		});
		this.process = new RpcProcess({
			command: spec.command,
			args: spec.args,
			cwd: spec.cwd,
			env: spec.env,
		});
		this.process.on((message) => this.handle(message));
		void this.process.waitForExit().then(() => {
			if (this.stopping) return;
			// §8. A child that finished shuts itself down, and that exit is the normal
			// end of a run. An exit in the middle of a run is a crash.
			if (!this.idle) {
				this.end("the subagent's process exited in the middle of its run", true);
				return;
			}
			// A run whose last model call failed settles too; that is a failure, and
			// the text from before it is not a report.
			const stop = this.lastStop;
			if (stop && (stop.reason === "error" || stop.reason === "aborted")) {
				this.end(`its last model call ${stop.reason === "error" ? "failed" : "was aborted"}${stop.error ? `: ${stop.error}` : ""}`, true);
				return;
			}
			this.end(null, false);
		});
		this.watchdog = setInterval(() => this.checkWatchdogs(), 1_000);
		this.watchdog.unref?.();
	}

	// ------------------------------------------------------------- lifecycle

	/** Starts the run: records the session file, then sends the task as a prompt. */
	async begin(): Promise<void> {
		const state = await this.process.send({ type: "get_state" }, 60_000);
		if (state.success && state.data && typeof state.data === "object") {
			const data = state.data as { sessionFile?: unknown; model?: { contextWindow?: unknown } | null };
			const file = data.sessionFile;
			if (typeof file === "string" && file.length > 0) {
				this.sessionFile = file;
				this.hooks.onSessionFile(file);
			}
			// §9. Known up front, so context use reads as a percentage for a child
			// that finishes on its own as much as for one that is stopped.
			const window = data.model?.contextWindow;
			if (typeof window === "number" && window > 0) this.usage = { ...this.usage, contextWindow: window };
		}
		// pi's own retry of transient provider errors is switched on in the child (§8).
		await this.process.send({ type: "set_auto_retry", enabled: true });
		await this.process.send({ type: "prompt", message: this.spec.task });
	}

	/** §9. A message to a running child is queued in it and read at its next step. */
	async message(text: string): Promise<boolean> {
		const response = await this.process.send({
			type: "prompt",
			message: text,
			streamingBehavior: "steer",
		});
		if (!response.success) {
			const retry = await this.process.send({ type: "prompt", message: text });
			return retry.success;
		}
		return true;
	}

	/** §8. Cooperative first: abort the run, close the input, escalate only if needed. */
	async stop(reason: string, failed = false): Promise<void> {
		this.stopping = true;
		// A child still blocked on a question is released before the stop, so it can
		// flush and exit rather than hang (§8).
		this.releaseOpenAsk();
		await this.captureAuthoritativeUsage();
		await this.process.stop();
		this.end(reason, failed);
	}

	waitForEnd(): Promise<RunOutcome> {
		return this.finished;
	}

	// ----------------------------------------------------------------- state

	get status(): ChildLiveStatus {
		if (this.ended || !this.process.isRunning) return "idle";
		return this.compacting ? "compacting" : "running";
	}

	get isRunning(): boolean {
		return !this.ended && this.process.isRunning;
	}

	/** True when the child has settled: finished, or waiting on background work of its own. */
	get isIdle(): boolean {
		return this.idle;
	}

	get hasOpenQuestion(): boolean {
		return this.openAsk !== null;
	}

	get pendingAsk(): PendingAsk | null {
		return this.openAsk;
	}

	/** §6. What this run was launched on, so nobody has to ask the child. */
	get model(): ModelChoice | null {
		return this.spec.model;
	}

	get thinking(): ThinkingLevel | null {
		return this.spec.thinking;
	}

	get durationMs(): number {
		return (this.endedAt ?? Date.now()) - this.startedAt;
	}

	get toolCallCount(): number {
		return this.toolCalls;
	}

	get recentToolCalls(): readonly string[] {
		return this.recentTools;
	}

	get turnCount(): number {
		return this.turns;
	}

	get streamingText(): string {
		return this.streaming;
	}

	get contextUsage(): UsageReading {
		return { ...this.usage, stale: this.ended };
	}

	get childSessionFile(): string | null {
		return this.sessionFile;
	}

	get stderrTail(): string {
		return this.process.stderrTail;
	}

	/** §14. What the child is actually doing, so silence does not read as stuck. */
	get activity(): string {
		if (this.openAsk) return "asking a question";
		if (this.compacting) return "compacting";
		if (!this.isRunning) return "idle";
		if (this.streaming.length > 0) return "writing";
		const last = this.recentTools.at(-1);
		return last ? `running ${last}` : "waiting for the model";
	}

	// ---------------------------------------------------------------- events

	private handle(message: RpcMessage): void {
		this.lastEventAt = Date.now();

		switch (message.type) {
			case "extension_ui_request":
				this.handleUiRequest(message);
				return;
			case "message_start":
				this.projectMessageStart(message);
				break;
			case "message_end":
				this.noteAssistantText(message.message);
				this.projectMessageEnd(message);
				break;
			case "message_update":
				this.projectUpdate(message);
				break;
			case "tool_execution_start":
				this.projectToolStart(message);
				break;
			case "tool_execution_update":
				this.projectToolUpdate(message);
				break;
			case "tool_execution_end":
				this.projectToolEnd(message);
				break;
			default:
				break;
		}

		switch (message.type) {
			case "compaction_start":
				this.compacting = true;
				this.idle = false;
				break;
			case "agent_start":
				this.idle = false;
				break;
			case "agent_end":
				if (message.willRetry !== true) this.idle = true;
				break;
			case "agent_settled":
				this.idle = true;
				break;
			case "compaction_end":
				this.compacting = false;
				break;
			case "turn_start":
				this.idle = false;
				this.turns++;
				this.streaming = "";
				break;
			case "turn_end":
				this.streaming = "";
				break;
			case "message_update": {
				const event = message.assistantMessageEvent as { type?: string; delta?: string } | undefined;
				if (event?.type === "text_delta" && typeof event.delta === "string") {
					this.streaming = (this.streaming + event.delta).slice(-STREAM_TAIL_CHARS);
				}
				this.readUsage(message.usage);
				break;
			}
			case "tool_execution_start": {
				const name = typeof message.toolName === "string" ? message.toolName.slice(0, 64) : "tool";
				this.toolCalls++;
				this.recentTools.push(name);
				if (this.recentTools.length > 8) this.recentTools.shift();
				break;
			}
			case "auto_retry_start":
				// A retrying child reads as running (§9); nothing else to record.
				break;
			default:
				break;
		}
		this.projectStatus();
		this.hooks.onUpdate();
	}

	/**
	 * §10. A child's result is its last assistant message: whatever it says when it
	 * stops is what its parent reads. A message with no text, such as one that only
	 * calls tools, leaves the last text in place.
	 */
	private noteAssistantText(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const message = raw as { role?: unknown; content?: unknown; stopReason?: unknown; errorMessage?: unknown; usage?: unknown };
		if (message.role !== "assistant") return;
		this.lastStop = {
			reason: typeof message.stopReason === "string" ? message.stopReason : "stop",
			error: typeof message.errorMessage === "string" ? message.errorMessage : null,
		};
		this.readUsage(message.usage);
		const content = message.content;
		const text =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((part): part is { type: string; text: string } =>
								Boolean(part) && part.type === "text" && typeof part.text === "string",
							)
							.map((part) => part.text)
							.join("\n")
					: "";
		if (text.trim().length > 0) this.lastText = text.trim();
	}

	// -------------------------------------------------------- observation

	private projectEvent(event: ChildActivity): void {
		if (!this.hooks.onActivity) return;
		try {
			this.hooks.onActivity(event);
		} catch {
			// An observer that fails must not disturb the run.
		}
	}

	/**
	 * §9. The status a reader may see is the one this process can prove: the run
	 * it drives. It is sent only when it changes, so watching adds no stream of
	 * identical frames.
	 */
	private projectStatus(): void {
		const status = this.status;
		const activity = this.activity;
		const waiting = this.openAsk !== null;
		const key = `${status}\u0000${activity}\u0000${waiting}`;
		if (key === this.observedStatus) return;
		this.observedStatus = key;
		this.projectEvent({ kind: "status", status, activity, waiting, runElapsedMs: this.durationMs });
	}

	private projectMessageStart(message: RpcMessage): void {
		const role = (message.message as { role?: unknown } | undefined)?.role;
		if (role !== "assistant") return;
		this.projectEvent({ kind: "message_start" });
	}

	private projectMessageEnd(message: RpcMessage): void {
		const role = (message.message as { role?: unknown } | undefined)?.role;
		if (role !== "assistant") return;
		this.projectEvent({ kind: "message_end" });
	}

	private projectUpdate(message: RpcMessage): void {
		const event = message.assistantMessageEvent as
			| { type?: string; contentIndex?: number; delta?: string }
			| undefined;
		if (!event) return;
		if (event.type !== "text_delta" && event.type !== "thinking_delta") return;
		if (typeof event.delta !== "string" || event.delta.length === 0) return;
		this.projectEvent({
			kind: "delta",
			index: typeof event.contentIndex === "number" ? event.contentIndex : 0,
			channel: event.type === "thinking_delta" ? "thinking" : "text",
			delta: event.delta,
		});
	}

	private projectToolStart(message: RpcMessage): void {
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (!id) return;
		const name = typeof message.toolName === "string" ? message.toolName.slice(0, 64) : "tool";
		this.projectEvent({ kind: "tool_start", toolCallId: id, name, args: jsonOf(message.args) });
	}

	private projectToolUpdate(message: RpcMessage): void {
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (!id) return;
		const now = Date.now();
		if (now - this.lastToolUpdateAt < 250) return;
		this.lastToolUpdateAt = now;
		this.projectEvent({ kind: "tool_update", toolCallId: id, output: tailText(message.partialResult, OUTPUT_CHARS) });
	}

	private projectToolEnd(message: RpcMessage): void {
		const id = typeof message.toolCallId === "string" ? message.toolCallId : "";
		if (!id) return;
		this.projectEvent({ kind: "tool_end", toolCallId: id, isError: message.isError === true });
	}

	private handleUiRequest(message: RpcMessage): void {
		const id = typeof message.id === "string" ? message.id : null;
		const method = typeof message.method === "string" ? message.method : "";
		const needsAnswer =
			method === "select" || method === "confirm" || method === "input" || method === "editor";

		const envelope = method === "input" ? decodeAsk(message.title) : null;
		if (envelope && id) {
			this.openAsk = {
				requestId: id,
				envelope,
				arrivedAt: Date.now(),
				answer: (result) => this.answerAsk(id, result),
			};
			this.answeringSince = Date.now();
			this.hooks.onAsk(this.openAsk);
			this.projectStatus();
			this.hooks.onUpdate();
			return;
		}

		// §13. Any other dialog a child extension opens is declined; only an ask has
		// somewhere to go.
		if (needsAnswer && id) {
			this.process.write({ type: "extension_ui_response", id, cancelled: true });
		}
	}

	private answerAsk(requestId: string, result: AskResult): void {
		if (this.openAsk?.requestId !== requestId) return;
		this.process.write({
			type: "extension_ui_response",
			id: requestId,
			value: encodeAskResult(result),
		});
		this.closeOpenAsk();
	}

	private closeOpenAsk(): void {
		if (this.answeringSince !== null) {
			this.answeringMs += Date.now() - this.answeringSince;
			this.answeringSince = null;
		}
		this.openAsk = null;
		this.lastEventAt = Date.now();
		this.projectStatus();
		this.hooks.onUpdate();
	}

	/** §13. A question whose run has ended is released and answered as cancelled. */
	private releaseOpenAsk(): void {
		const open = this.openAsk;
		if (!open) return;
		this.process.write({
			type: "extension_ui_response",
			id: open.requestId,
			value: encodeAskResult({ outcome: "cancelled", answers: [] }),
		});
		this.closeOpenAsk();
	}

	private readUsage(raw: unknown): void {
		if (!raw || typeof raw !== "object") return;
		const usage = raw as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
		const total =
			(usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) + (usage.output ?? 0);
		if (total <= 0) return;
		this.usage = {
			tokens: total,
			contextWindow: this.usage.contextWindow,
			percent: this.usage.contextWindow ? Math.round((total / this.usage.contextWindow) * 100) : null,
			stale: false,
		};
	}

	/**
	 * §8. The parent asks the child for its authoritative usage before shutting it
	 * down, rather than trusting what it counted off the stream.
	 */
	private async captureAuthoritativeUsage(): Promise<void> {
		if (!this.process.isRunning) return;
		const response = await this.process.send({ type: "get_session_stats" }, 10_000);
		if (!response.success || !response.data || typeof response.data !== "object") return;
		const context = (response.data as { contextUsage?: unknown }).contextUsage;
		if (!context || typeof context !== "object") return;
		const reading = context as { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
		this.usage = {
			tokens: reading.tokens ?? this.usage.tokens,
			contextWindow: reading.contextWindow ?? this.usage.contextWindow,
			percent: reading.percent ?? this.usage.percent,
			stale: false,
		};
	}

	// ------------------------------------------------------------ watchdogs

	private checkWatchdogs(): void {
		if (this.ended) return;
		// An outstanding question freezes both watchdogs entirely: a child blocked
		// on a question is silent on purpose (§8).
		if (this.openAsk) return;

		const now = Date.now();
		if (now - this.lastEventAt > this.spec.silenceTimeoutMs) {
			void this.stop(
				`the subagent sent nothing for ${Math.round(this.spec.silenceTimeoutMs / 1000)}s and was stopped`,
				true,
			).catch(() => {});
			return;
		}
		if (this.spec.timeoutMs > 0) {
			// The time the human spent answering its questions is subtracted (§8).
			const elapsed = now - this.startedAt - this.answeringMs;
			if (elapsed > this.spec.timeoutMs) {
				void this.stop(
					`the subagent reached its time limit of ${Math.round(this.spec.timeoutMs / 1000)}s and was stopped`,
					true,
				).catch(() => {});
			}
		}
	}

	private end(reason: string | null, failed: boolean): void {
		if (this.ended) return;
		this.ended = true;
		this.endedAt = Date.now();
		if (this.watchdog) clearInterval(this.watchdog);
		this.watchdog = null;
		this.releaseOpenAsk();
		// The abort that a stop produces is not reported as a failure (§8).
		this.failureReason = failed ? reason : this.failureReason;
		this.projectStatus();
		const outcome: RunOutcome = {
			result: this.lastText,
			failed,
			reason,
			errorOutput: failed ? this.process.stderrTail || null : null,
			usage: { ...this.usage, stale: true },
		};
		this.hooks.onEnd(outcome);
		this.hooks.onUpdate();
		this.finish(outcome);
	}

	get failure(): string | null {
		return this.failureReason;
	}
}
