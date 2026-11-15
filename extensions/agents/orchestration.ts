/**
 * §7–§11. Firing children, hearing back from them, and closing them.
 */

import { randomUUID } from "node:crypto";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { delegationProblem, type AgentDefinition } from "./definitions.js";
import type { ChildRun, RunOutcome } from "./child.js";
import type { AgentId, AgentRecord } from "./records.js";
import type { ChildStatus, SpawnControls } from "./supervisor.js";
import type { AskBroker } from "../ask/broker.js";
import { describeQuestion } from "../ask/broker.js";
import type { Taskforce } from "../runtime.js";
import { continueMessage, describeLaunch } from "../prompts/index.js";

/** §10. A report longer than the cap is cut, and the cut says so. */
const REPORT_CAP = 40_000;

export const REPORT_MESSAGE = "pi-taskforce-report";

/** §10. What a parent is told about when a background report reaches it. */
const REPORT_TIMING =
	"Its report arrives as a message once it finishes and your current turn has ended. While you keep " +
	"calling tools the report waits, so do not poll or sleep for it: end your turn if there is nothing else to do.";

export class Orchestration {
	/**
	 * §10. Children whose report has been handed to pi but has not reached this
	 * agent yet. A follow-up waits for the current run to end, so a child can be
	 * idle with its report still queued.
	 */
	private readonly queuedReports = new Set<AgentId>();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly tf: Taskforce,
		private readonly broker: AskBroker,
		private readonly onChange: () => void,
	) {}

	private get supervisor() {
		const supervisor = this.tf.supervisor;
		if (!supervisor) throw new Error("pi-taskforce: the supervisor is not ready");
		return supervisor;
	}

	// ------------------------------------------------------------- spawning

	async spawn(
		definition: AgentDefinition,
		goal: string,
		controls: SpawnControls,
		signal?: AbortSignal,
	): Promise<string> {
		const refusal = this.supervisor.checkSpawnable(definition.name);
		if (refusal) return refusal;

		const problem = delegationProblem(definition);
		if (problem) return problem;

		const self = this.tf.self;
		const child: AgentRecord = {
			uuid: randomUUID(),
			parentUuid: self.uuid,
			type: definition.name,
			failed: false,
			sessionFile: null,
			spawnedAt: Date.now(),
			depth: self.depth + 1,
			forked: controls.fork,
		};

		// §13. A foreground run's first question comes back in this call's result.
		if (!controls.background) this.broker.expectForegroundQuestion(child.uuid);

		const { run } = await this.supervisor.spawn({ definition, goal, args: {}, controls }, child);
		this.onChange();

		// §6. The launch facts are stated here, once, so neither side has to probe
		// for the model it ended up on.
		const launch = describeLaunch(run.model, run.thinking);
		const onLaunch = launch ? ` on ${launch}` : "";

		const address = addressingBlock(child.uuid, definition.name);
		const unresolved = this.supervisor.unresolved.splice(0);
		const missing =
			unresolved.length > 0
				? `These extensions named by the \`${definition.name}\` definition could not be found, so they ` +
					`were not loaded into it: ${unresolved.join(", ")}.`
				: null;

		if (controls.background) {
			this.deliverLater(child, definition, run);
			return [
				`Started ${definition.name} in the background, as \`${child.uuid}\`${onLaunch}.`,
				address,
				REPORT_TIMING,
				missing,
			]
				.filter(Boolean)
				.join("\n\n");
		}

		// §7. A foreground run that asks a question hands the turn back at that
		// moment, and so does an interrupt; either way the child carries on in the
		// background and its report arrives later.
		const handedBack = await Promise.race([
			run.waitForEnd().then((outcome) => ({ kind: "end" as const, outcome })),
			waitForFirstAsk(run).then(() => ({ kind: "ask" as const })),
			waitForAbort(signal).then(() => ({ kind: "interrupted" as const })),
		]);

		if (handedBack.kind !== "end") {
			this.deliverLater(child, definition, run);
			if (handedBack.kind === "ask") {
				const waiting = this.broker.waitingFor(child.uuid);
				return [
					`${definition.name} \`${child.uuid}\`${onLaunch} has asked a question, so this call hands the ` +
						"turn back and the run carries on in the background. " + REPORT_TIMING,
					waiting ? describeQuestion(waiting) : "The question is being put to whoever can answer it.",
				].join("\n\n");
			}
			return [
				`${definition.name} \`${child.uuid}\`${onLaunch} is now running in the background and carries on.`,
				REPORT_TIMING,
			].join("\n\n");
		}

		return [this.buildReport(child, definition, handedBack.outcome, launch), missing]
			.filter(Boolean)
			.join("\n\n");
	}

	// -------------------------------------------------------------- reports

	private deliverLater(child: AgentRecord, definition: AgentDefinition, run: ChildRun): void {
		void run
			.waitForEnd()
			.then((outcome) => this.deliverReport(child, definition, outcome, describeLaunch(run.model, run.thinking)))
			.catch(() => {});
	}

	/**
	 * §10. A background report waits for the parent's current run to finish and
	 * never cuts into it; when the parent is idle, it starts a turn.
	 */
	private deliverReport(
		child: AgentRecord,
		definition: AgentDefinition,
		outcome: RunOutcome,
		launch: string | null,
	): void {
		this.queuedReports.add(child.uuid);
		this.pi.sendMessage(
			{
				customType: REPORT_MESSAGE,
				content: this.buildReport(child, definition, outcome, launch),
				display: true,
				details: { agentId: child.uuid, type: definition.name, failed: outcome.failed },
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		this.onChange();
	}

	/**
	 * §10. The report is the child's last message, preceded by how the run ended
	 * when that was anything but a normal finish. A run that failed or was
	 * stopped still hands over what it wrote last.
	 */
	buildReport(
		child: AgentRecord,
		definition: AgentDefinition,
		outcome: RunOutcome,
		launch: string | null = null,
	): string {
		const onLaunch = launch ? ` on ${launch}` : "";
		const parts: string[] = [`Report from ${definition.name} \`${child.uuid}\`${onLaunch}.`];

		if (outcome.failed) {
			const usage = outcome.usage;
			const window = usage.contextWindow ? ` of ${usage.contextWindow}` : "";
			const percent = usage.percent !== null ? ` (${usage.percent}%)` : "";
			parts.push(
				`This run failed: ${outcome.reason ?? "the run stopped unexpectedly"}. ` +
					`Context use was ${usage.tokens ?? "unknown"}${window} tokens${percent}.`,
			);
			if (outcome.errorOutput) {
				parts.push(`What its process wrote to stderr:\n${outcome.errorOutput.slice(-2000)}`);
			}
		} else if (outcome.reason) {
			parts.push(`This run was stopped: ${outcome.reason}.`);
		}

		if (outcome.result !== null) {
			const lead = outcome.failed || outcome.reason ? "What it wrote last:\n\n" : "";
			parts.push(`${lead}${cut(outcome.result)}`);
		} else {
			parts.push(
				"It wrote no message. Ask it with messageSubagent what it found, or close it and decide what to do instead.",
			);
		}
		return parts.join("\n\n");
	}

	// -------------------------------------------------------------- children

	/** §9. Every child this agent spawned, from its own session. */
	children(): AgentRecord[] {
		return this.tf.children.all();
	}

	/** §9. An agent addresses only the children it spawned itself. */
	findChild(uuid: string): AgentRecord | string {
		return (
			this.tf.children.get(uuid) ??
			`\`${uuid}\` is not one of your subagents. Use \`listSubagents\` to find the right uuid.`
		);
	}

	statusOf(record: AgentRecord): ChildStatus {
		return this.supervisor.statusOf(record);
	}

	/** §10. Whether this child's report is waiting for the current run to end. */
	hasQueuedReport(uuid: AgentId): boolean {
		return this.queuedReports.has(uuid);
	}

	/** §10. The report has reached this agent's messages. */
	reportDelivered(uuid: AgentId): void {
		if (this.queuedReports.delete(uuid)) this.onChange();
	}

	/**
	 * §10. Called when this agent settles with nothing left to deliver. A report
	 * still marked queued then was dropped with the queue, and is not coming.
	 */
	forgetQueuedReports(): void {
		if (this.queuedReports.size === 0) return;
		this.queuedReports.clear();
		this.onChange();
	}

	/** §9. Closing stops the child. It stays idle and can be woken by a message. */
	async close(child: AgentRecord, reason: string): Promise<string> {
		const stopped = await this.supervisor.close(child, reason);
		this.onChange();
		const name = `${child.type ?? "subagent"} \`${child.uuid}\``;
		return stopped
			? `Closed ${name}. It is idle now, and can be woken again with messageSubagent.`
			: `${name} was not running. It stays idle, and can be woken again with messageSubagent.`;
	}

	/** §9. Steering, resuming or waking a child. */
	async message(child: AgentRecord, body: string): Promise<string> {
		const definition = child.type ? (this.tf.catalog.byName.get(child.type) ?? null) : null;
		const wasRunning = this.supervisor.runFor(child.uuid)?.isRunning ?? false;
		// §10. Restarting a child whose report is still queued would send a second
		// report, and the parent has not read the first yet.
		if (!wasRunning && this.queuedReports.has(child.uuid)) {
			return (
				`\`${child.uuid}\` has finished, and its report is queued: it reaches you when your current turn ` +
				"ends. Your message was not sent. End your turn to read the report, then message it if you still need to."
			);
		}
		const resume = wasRunning ? null : continueMessage();

		const result = await this.supervisor.messageChild(child, definition, body, resume);
		this.onChange();
		if (!result.delivered) {
			return `That message could not be delivered: ${result.error ?? "the subagent could not be started"}.`;
		}
		if (result.restarted) {
			// The restarted run reports back like a background spawn does.
			const run = this.supervisor.runFor(child.uuid);
			if (run && definition) this.deliverLater(child, definition, run);
			const launch = run ? describeLaunch(run.model, run.thinking) : null;
			return (
				`\`${child.uuid}\` had stopped, so it was restarted from its own transcript and given your ` +
				"message after a note asking it to read back over its restored context." +
				(launch ? ` It runs on ${launch}.` : "") +
				` ${REPORT_TIMING}`
			);
		}
		return `Your message is queued in \`${child.uuid}\`. It reads it at its next step, so do not wait for it.`;
	}
}

/** §7. The uuid, and the tools the child can be addressed with. */
function addressingBlock(childId: AgentId, type: string): string {
	return (
		`Its uuid is \`${childId}\`. Use \`messageSubagent\` to steer it or ask a follow-up, and ` +
		`\`closeSubagent\` to stop it. \`listSubagents\` finds this ${type} again.`
	);
}

function cut(body: string): string {
	if (body.length <= REPORT_CAP) return body;
	return (
		`${body.slice(0, REPORT_CAP)}\n\n` +
		"[The report was cut here, so whatever came after is missing. The subagent is idle, not gone: " +
		"message it with messageSubagent and ask for the rest.]"
	);
}

function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
	if (!signal) return new Promise<void>(() => {});
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

async function waitForFirstAsk(run: { hasOpenQuestion: boolean; isRunning: boolean }): Promise<void> {
	for (;;) {
		if (run.hasOpenQuestion) return;
		if (!run.isRunning) return new Promise<void>(() => {});
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
}
