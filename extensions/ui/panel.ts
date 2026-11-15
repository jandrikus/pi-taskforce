/**
 * §14. The subagent control panel.
 *
 * It lists every configured agent type, every run in flight with its stats, and
 * every question waiting on the user. It also lists the agent files that failed
 * to parse, because a typo in one would otherwise just make the agent silently
 * absent.
 */

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";

import type { AskBroker } from "../ask/broker.js";
import type { Taskforce } from "../runtime.js";
import { createScroller } from "./scroller.js";

export interface PanelActions {
	/** §14. Stop the selected run, or stop all of them. */
	stopAll(): void;
	stopOne(agentId: string): void;
	/** §14. Open a waiting question on demand. */
	openQuestion(reference: string): void;
}

export async function openPanel(
	tf: Taskforce,
	broker: AskBroker,
	ctx: ExtensionContext,
	actions: PanelActions,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(panelLines(tf, broker, plainTheme).join("\n"), "info");
		return;
	}

	let cursor = 0;
	await ctx.ui.custom<null>((tui, theme, _keybindings, done) => {
		const scroller = createScroller({
			title: "Subagents",
			theme,
			tui,
			done,
			body: () => panelLines(tf, broker, theme, cursor),
			help: () => "↑↓ scroll • s stop selected • S stop all • a answer first question • Esc close",
			onKey: (data) => {
				const runs = tf.supervisor?.liveRuns ?? [];
				if (data === "s") {
					const selected = runs[cursor];
					if (selected) actions.stopOne(selected.agentId);
					return true;
				}
				if (data === "S") {
					actions.stopAll();
					return true;
				}
				if (data === "a") {
					const first = broker.waitingQuestions[0];
					if (first) {
						done(null);
						actions.openQuestion(first.reference);
					}
					return true;
				}
				if (data === "j") {
					cursor = Math.min(Math.max(0, runs.length - 1), cursor + 1);
					return true;
				}
				if (data === "k") {
					cursor = Math.max(0, cursor - 1);
					return true;
				}
				return false;
			},
		});
		return scroller;
	});
}

const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

export function panelLines(
	tf: Taskforce,
	broker: AskBroker,
	theme: Theme,
	cursor = -1,
): string[] {
	const lines: string[] = [];

	const waiting = broker.waitingQuestions;
	if (waiting.length > 0) {
		lines.push(theme.fg("warning", theme.bold("Questions waiting on you")));
		for (const question of waiting) {
			const first = question.envelope.ask.questions[0];
			lines.push(
				theme.fg(
					"warning",
					`  [${question.reference}] ${question.envelope.from.agentType} — ${first?.prompt ?? ""}`,
				),
			);
		}
		lines.push("");
	}

	const runs = tf.supervisor?.liveRuns ?? [];
	lines.push(theme.bold("Runs in flight"));
	if (runs.length === 0) {
		lines.push(theme.fg("dim", "  none"));
	} else {
		runs.forEach(({ agentId, run }, index) => {
			const marker = index === cursor ? theme.fg("accent", "> ") : "  ";
			const usage = run.contextUsage;
			const stats = [
				run.model ? `${run.model.provider}/${run.model.id}${run.thinking ? ` ${run.thinking}` : ""}` : null,
				run.activity,
				`${Math.round(run.durationMs / 1000)}s`,
				`${run.turnCount} turn(s)`,
				`${run.toolCallCount} tool call(s)`,
				usage.tokens !== null ? `${usage.tokens} tokens${usage.percent !== null ? ` (${usage.percent}%)` : ""}` : null,
			]
				.filter(Boolean)
				.join(" • ");
			lines.push(`${marker}${theme.fg("accent", agentId)}`);
			lines.push(`    ${theme.fg("muted", stats)}`);
			const recent = run.recentToolCalls;
			if (recent.length > 0) lines.push(`    ${theme.fg("dim", recent.join(" → "))}`);
		});
	}
	const ended = tf.supervisor?.endedRuns ?? [];
	if (ended.length > 0) {
		lines.push("");
		lines.push(theme.bold("Runs that have finished"));
		for (const run of ended.slice(0, 8)) {
			lines.push(
				`  ${theme.fg("muted", `${run.type} ${run.agentId}`)} ${theme.fg("dim", `— ${run.how}`)}`,
			);
		}
	}
	lines.push("");

	lines.push(theme.bold("Agent types"));
	if (tf.catalog.byName.size === 0) {
		lines.push(theme.fg("dim", "  none configured"));
	} else {
		for (const definition of tf.catalog.byName.values()) {
			lines.push(
				`  ${theme.fg("text", definition.name)} ${theme.fg("dim", `(${definition.scope}) ${definition.path}`)}`,
			);
		}
	}

	if (tf.catalog.failures.length > 0) {
		lines.push("");
		lines.push(theme.fg("error", theme.bold("Agent files that did not load")));
		for (const failure of tf.catalog.failures) {
			lines.push(theme.fg("error", `  ${failure.path}: ${failure.reason}`));
		}
	}

	if (tf.modelProblems.length > 0) {
		lines.push("");
		lines.push(theme.fg("warning", theme.bold("Pinned models not used; these run on the parent's model")));
		for (const problem of tf.modelProblems) lines.push(theme.fg("warning", `  ${problem}`));
	}

	return lines;
}
