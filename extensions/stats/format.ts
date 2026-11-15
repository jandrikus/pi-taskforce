/**
 * The text of the stats page. Pure: the same lines go to a scrollable panel or
 * to a notification, so tests do not need a terminal.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";

import type { SessionStatsSnapshot, StatsAgent, StatsContext, StatsUsage } from "./contract.js";

export function statsLines(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	return [
		...overview(snapshot, theme),
		"",
		...costSection(snapshot, theme),
		"",
		...agentsSection(snapshot, theme),
		"",
		...todosSection(snapshot, theme),
		"",
		...problemsSection(snapshot, theme),
		"",
		theme.fg(
			"dim",
			"pi's built-in /session, its RPC stats and its own footer count this session's transcript only; this view adds recorded subagent transcripts.",
		),
	];
}

function overview(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	const session = snapshot.session;
	const current = session.model.known ? `${session.model.provider}/${session.model.id}` : null;
	const model = current ?? (session.observedModel?.known ? observedText(session.observedModel) : "unknown");
	const lines = [
		theme.bold("Session"),
		`  ${theme.fg("muted", "status")}          ${session.status}`,
		`  ${theme.fg("muted", "model")}           ${model}`,
	];
	const historical = session.observedModel?.known ? session.observedModel : null;
	if (current && historical && historical.id) {
		const historicalName = `${historical.provider ? `${historical.provider}/` : ""}${historical.id}`;
		if (historicalName !== current) lines.push(`  ${theme.fg("muted", "last observed")}   ${observedText(historical)}`);
	}
	lines.push(
		`  ${theme.fg("muted", "context")}         ${contextText(session.context)}`,
		`  ${theme.fg("muted", "session age")}     ${duration(session.sessionAgeMs)}`,
		`  ${theme.fg("muted", "last transcript")} ${session.lastActivityAt === null ? "unknown" : new Date(session.lastActivityAt).toLocaleString()}`,
	);
	return lines;
}

function costSection(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	const costs = snapshot.costs;
	const lines = [theme.bold("Costs")];
	if (!costs.available) {
		if (costs.scanning) lines.push(theme.fg("muted", "  Reading this session and its subagent transcripts…"));
		else if (costs.error) lines.push(theme.fg("error", `  unavailable: ${costs.error}`));
		else lines.push(theme.fg("muted", "  unavailable: no session transcript to read"));
		return lines;
	}

	lines.push(`  ${theme.fg("muted", "total incl. agents")} ${theme.fg("accent", theme.bold(money(costs.total!.cost)))}`);
	lines.push(`  ${theme.fg("muted", "this session")}       ${money(costs.own!.cost)}   ${theme.fg("dim", `${tokens(costs.own!)} tokens`)}`);
	lines.push(
		`  ${theme.fg("muted", "subagents (known)")}  ${money(costs.descendants!.cost)}   ${theme.fg("dim", `${tokens(costs.descendants!)} tokens`)}`,
	);
	if (costs.incomplete) {
		lines.push(theme.fg("warning", "  Incomplete: a recorded child or some usage could not be read; this is the known part only."));
	}
	if (costs.stale) lines.push(theme.fg("warning", `  Stale: the last read failed${costs.error ? ` (${costs.error})` : ""}.`));
	if (costs.scanning) lines.push(theme.fg("dim", "  Updating…"));

	lines.push(`  ${theme.bold("By model")}`);
	if (costs.models.length === 0) lines.push(theme.fg("dim", "    none"));
	else {
		for (const model of costs.models) {
			lines.push(`    ${theme.fg("text", model.key)}  ${money(model.usage.cost)}  ${theme.fg("dim", `${tokens(model.usage)} tokens`)}`);
		}
	}
	return lines;
}

function agentsSection(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	const lines = [theme.bold("Agents")];
	if (snapshot.agents.length === 0) {
		lines.push(theme.fg("dim", "  none recorded"));
		return lines;
	}
	for (const agent of snapshot.agents) lines.push(...agentLines(agent, theme));
	return lines;
}

function agentLines(agent: StatsAgent, theme: Theme): string[] {
	const indent = "  ".repeat(Math.max(0, agent.depth - 1));
	const branch = agent.depth > 1 ? "└─ " : "";
	const type = agent.type ?? "agent";
	const status = agent.storedFailure === true && agent.status === "unknown" ? "unknown (last run failed)" : agent.status;
	const bits = [status];
	if (agent.runElapsedMs !== null) bits.push(`run elapsed ${duration(agent.runElapsedMs)}`);
	if (agent.context.known) bits.push(`context ${contextText(agent.context)}`);
	if (agent.observedModel?.known) bits.push(observedText(agent.observedModel));
	if (agent.configuredModel) bits.push(`configured model ${agent.configuredModel}`);
	const lines = [`${indent}${branch}${type} ${theme.fg("dim", agent.uuid)}  ${theme.fg("text", bits.join(" • "))}`];

	const cost = agent.cost;
	if (!cost) lines.push(`${indent}  ${theme.fg("dim", "cost unavailable")}`);
	else {
		const own = cost.known ? money(cost.own.cost) : "unknown";
		const subtree = cost.subtreeKnown ? money(cost.subtree.cost) : `${money(cost.subtree.cost)} partial`;
		const extra = cost.note.length > 0 ? ` — ${cost.note}` : "";
		lines.push(`${indent}  ${theme.fg("muted", "own")} ${own}  ${theme.fg("muted", "subtree")} ${subtree}${theme.fg("dim", extra)}`);
	}
	if (!agent.transcript.available && agent.transcript.note.length > 0) {
		lines.push(`${indent}  ${theme.fg("warning", agent.transcript.note)}`);
	}
	return lines;
}

function todosSection(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	const lines = [theme.bold("TODOs (session-owned)")];
	if (snapshot.todos.length === 0) {
		lines.push(theme.fg("dim", "  none"));
		return lines;
	}
	for (const todo of snapshot.todos) {
		lines.push(`  ${todo.remaining === 0 ? "[x]" : "[ ]"} ${todo.title}  ${todo.done}/${todo.total}  ${theme.fg("dim", todo.path)}`);
		for (const item of todo.items) lines.push(`    ${item.done ? "[x]" : "[ ]"} ${item.text}`);
	}
	return lines;
}

function problemsSection(snapshot: SessionStatsSnapshot, theme: Theme): string[] {
	if (snapshot.problems.length === 0) return [theme.fg("dim", "No unavailable data reported.")];
	return [theme.bold("Unavailable data"), ...snapshot.problems.map((problem) => theme.fg("warning", `  ${problem}`))];
}

function contextText(context: StatsContext): string {
	if (!context.known) {
		const suffix = context.stale ? " (stale)" : "";
		return `unknown${suffix}`;
	}
	if (context.measurement === "request-input" || context.source === "transcript") {
		if (context.tokens === null || context.tokens < 0) return "unknown (historical)";
		const bits = [`last measured request input ${formatTokens(context.tokens)}`];
		if (context.requestModel?.known && context.requestModel.id) {
			bits.push(`on ${context.requestModel.provider ? `${context.requestModel.provider}/` : ""}${context.requestModel.id}`);
		}
		if (context.branch === "active") bits.push("active branch");
		else if (context.branch === "last-recorded") bits.push("last recorded branch");
		if (context.provenance === "before-compaction") bits.push("before compaction");
		else if (context.provenance === "before-context-edit") bits.push("before context edit");
		const when = ageText(context.observedAt ?? null);
		if (when) bits.push(when);
		bits.push("(historical)");
		return bits.join(" ");
	}
	const percent = context.percent === null ? "?" : `${context.percent}%`;
	const window = context.contextWindow === null ? "?" : formatTokens(context.contextWindow);
	return `${percent} (${formatTokens(context.tokens ?? 0)}/${window})${context.stale ? " (stale)" : ""}`;
}

function observedText(model: {
	provider: string | null;
	id: string | null;
	observedAt: number | null;
	branch?: "active" | "last-recorded";
}): string {
	const name = model.id ? `${model.provider ? `${model.provider}/` : ""}${model.id}` : "unknown";
	const when = ageText(model.observedAt);
	const branch = model.branch === "last-recorded" ? " last recorded branch" : "";
	return `last observed model ${name}${branch}${when ? ` ${when}` : ""}`;
}

function ageText(at: number | null): string | null {
	if (at === null || !Number.isFinite(at) || at <= 0) return null;
	const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

function duration(ms: number | null): string {
	if (ms === null) return "unknown";
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function tokens(usage: StatsUsage): string {
	return formatTokens(usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
}

function formatTokens(count: number): string {
	if (count < 1_000) return String(Math.round(count));
	const [value, suffix] = count < 1_000_000 ? [count / 1_000, "k"] : [count / 1_000_000, "M"];
	return `${Number(value.toFixed(1))}${suffix}`;
}

function money(value: number): string {
	return `$${value.toFixed(3)}`;
}
