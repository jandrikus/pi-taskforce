/**
 * Text for `/cost`: a short label for the status line and a scrollable page
 * with the own/descendant split, per-model totals and every recorded agent.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

import { type Cost, type CostAgent, type CostView, usageTokens } from "./scan.js";

export const STATUS_KEY = "pi-taskforce-costs";
export const STATUS_LABEL = "Total incl. agents";

export function money(value: number): string {
	return `$${value.toFixed(3)}`;
}

export function formatTokens(count: number): string {
	if (count < 1_000) return String(Math.round(count));
	const [value, suffix] = count < 1_000_000 ? [count / 1_000, "k"] : [count / 1_000_000, "M"];
	return `${Number(value.toFixed(1))}${suffix}`;
}

export function costStatusText(view: CostView): string {
	if (!view.cost) {
		if (view.scanning) return `${STATUS_LABEL}: scanning…`;
		if (view.error) return `${STATUS_LABEL}: unknown`;
		return `${STATUS_LABEL}: unknown`;
	}
	let text = `${STATUS_LABEL}: ${money(view.cost.total.cost)}`;
	if (view.cost.incomplete) text += " (incomplete)";
	if (view.stale) text += " (stale)";
	return text;
}

export function costLines(view: CostView, theme: Theme): string[] {
	const lines: string[] = [];
	if (!view.cost) {
		if (view.scanning) {
			lines.push(theme.fg("muted", "Reading this session and its subagent transcripts…"));
			lines.push(theme.fg("dim", "No total is shown until the first read finishes."));
		} else if (view.error) {
			lines.push(theme.fg("error", "Session cost is unavailable."));
			lines.push(theme.fg("dim", view.error));
		} else {
			lines.push(theme.fg("muted", "No session transcript to read."));
		}
		return lines;
	}

	const cost = view.cost;
	lines.push(`${theme.fg("muted", "Total incl. agents")}   ${theme.fg("accent", theme.bold(money(cost.total.cost)))}`);
	lines.push(`  ${theme.fg("muted", "this session")}       ${money(cost.own.cost)}   ${theme.fg("dim", `${formatTokens(usageTokens(cost.own))} tokens`)}`);
	lines.push(
		`  ${theme.fg("muted", "subagents (known)")}  ${money(cost.descendants.cost)}   ${theme.fg("dim", `${formatTokens(usageTokens(cost.descendants))} tokens`)}`,
	);
	if (cost.incomplete) {
		lines.push(theme.fg("warning", "  Incomplete: a recorded child or some usage could not be read; the total is the known part only."));
	}
	if (view.stale) {
		lines.push(theme.fg("warning", `  Stale: the last read failed${view.error ? ` (${view.error})` : ""}.`));
	}
	if (view.scanning) lines.push(theme.fg("dim", "  Updating…"));

	lines.push("");
	lines.push(theme.bold("By model"));
	if (cost.models.length === 0) lines.push(theme.fg("dim", "  none"));
	else {
		for (const model of cost.models) {
			lines.push(
				`  ${theme.fg("text", model.key)}  ${money(model.usage.cost)}  ${theme.fg("dim", `${formatTokens(usageTokens(model.usage))} tokens`)}`,
			);
		}
	}

	lines.push("");
	lines.push(theme.bold("Agents"));
	for (const agent of cost.agents) {
		lines.push(...agentLines(agent, theme));
	}

	lines.push("");
	lines.push(
		theme.fg(
			"dim",
			"pi's built-in /session, its RPC stats and its own footer count this session's transcript only; this view adds recorded subagent transcripts.",
		),
	);
	return lines;
}

function agentLines(agent: CostAgent, theme: Theme): string[] {
	const indent = "  ".repeat(Math.max(0, agent.depth - 1));
	const branch = agent.depth > 1 ? "└─ " : "";
	const type = agent.type ?? "root";
	const label = `${type} ${theme.fg("dim", agent.uuid)}`;
	const prefix = `${indent}${branch}`;

	if (agent.status === "missing" || agent.status === "error" || agent.status === "outside") {
		const note = agent.note.length > 0 ? ` — ${agent.note}` : "";
		return [`${prefix}${label}  ${theme.fg("warning", "unknown")}${theme.fg("dim", note)}`];
	}
	if (agent.status === "cycle" || agent.status === "duplicate") {
		const note = agent.note.length > 0 ? ` — ${agent.note}` : "";
		return [`${prefix}${label}  ${theme.fg("dim", "not charged")}${theme.fg("dim", note)}`];
	}

	const own = agent.known ? money(agent.own.cost) : `${money(agent.own.cost)} partial`;
	const subtree = agent.subtreeKnown ? money(agent.subtree.cost) : `${money(agent.subtree.cost)} partial`;
	const bits = [`own ${own}`, `subtree ${subtree}`];
	if (agent.forked) bits.push("forked");
	if (agent.failed) bits.push(theme.fg("warning", "last run failed"));
	if (!agent.known && agent.note.length > 0) bits.push(theme.fg("dim", agent.note));
	return [`${prefix}${label}  ${bits.join("  ")}`];
}
