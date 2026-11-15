/**
 * Turns the live runtime, the cached cost view, and the TODO watcher into the
 * snapshot Pilot asks for. No files are written and no model call is made.
 */

import type { AgentRecord } from "../agents/records.js";
import { observeActiveBranch, type ContextObservation, type Cost, type CostAgent, type CostModel, type CostView, type ObservedModel, type Usage } from "../costs/scan.js";
import type { TodoFile } from "../todos/watcher.js";
import type {
	SessionStatsSnapshot,
	StatsAgent,
	StatsContext,
	StatsCostAgent,
	StatsCosts,
	StatsModelUsage,
	StatsObservedModel,
	StatsRootModel,
	StatsTodo,
	StatsUsage,
} from "./contract.js";

export interface StatsRootContext {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface StatsRun {
	isRunning: boolean;
	isIdle: boolean;
	status: "running" | "compacting" | "idle";
	durationMs: number;
}

export interface StatsSupervisor {
	runFor(agentId: string): StatsRun | undefined;
	contextUsageOf(agentId: string): {
		tokens: number | null;
		contextWindow: number | null;
		percent: number | null;
		stale: boolean;
	} | null;
}

export interface StatsSessionInput {
	id: string;
	file: string | null;
	cwd: string;
	idle: boolean;
	model: { provider: string; id: string } | null;
	context: StatsRootContext | undefined;
	/** The actual sessionManager branch. Null/undefined means no live leaf is available. */
	activeBranch?: readonly unknown[] | null;
	sessionAgeMs: number | null;
	lastActivityAt: number | null;
}

export interface StatsInput {
	session: StatsSessionInput;
	costs: CostView;
	records: readonly AgentRecord[];
	supervisor: StatsSupervisor | null;
	definitions: ReadonlyMap<string, { model: string | null }> | null;
	todos: readonly TodoFile[];
}

export function buildStatsSnapshot(input: StatsInput): SessionStatsSnapshot {
	const cost = input.costs.cost;
	const root = rootAgent(cost);
	const activeBranchKnown = input.session.activeBranch != null;
	const active = activeBranchKnown ? observeActiveBranch(input.session.activeBranch!) : null;
	const problems = costProblems(input.costs);
	const agents = buildAgents(input, cost);
	const sessionId = input.session.id;

	return {
		at: Date.now(),
		session: {
			id: sessionId,
			file: input.session.file,
			cwd: input.session.cwd,
			status: input.session.idle ? "idle" : "running",
			model: rootModel(input.session.model),
			observedModel: observedModel((activeBranchKnown ? active?.model ?? null : root?.observedModel) ?? undefined),
			activeBranchKnown,
			context: rootContext(input.session.context, active?.context ?? null, root?.lastContext, activeBranchKnown),
			sessionAgeMs: input.session.sessionAgeMs,
			lastActivityAt: input.session.lastActivityAt,
		},
		costs: costSummary(input.costs),
		agents,
		todos: input.todos.map((file) => todo(file, sessionId)),
		problems,
	};
}

function costProblems(view: CostView): string[] {
	const problems: string[] = [];
	if (!view.cost) {
		if (view.scanning) problems.push("Costs are still being read.");
		else if (view.error) problems.push(`Costs are unavailable: ${view.error}`);
		else problems.push("Costs are unavailable because there is no session transcript to read.");
		return problems;
	}
	if (view.stale) problems.push(`Costs are stale${view.error ? `: ${view.error}` : ""}.`);
	if (view.cost.incomplete) problems.push("Some recorded agents or usage could not be read; the total is the known part only.");
	return problems;
}

function rootModel(model: { provider: string; id: string } | null): StatsRootModel {
	return model
		? { known: true, provider: model.provider, id: model.id }
		: { known: false, provider: null, id: null };
}

function rootAgent(cost: Cost | null): CostAgent | null {
	return cost?.agents.find((agent) => agent.parentUuid === null) ?? null;
}

function rootContext(
	context: StatsRootContext | undefined,
	active: ContextObservation | null,
	recorded: ContextObservation | undefined,
	activeBranchKnown: boolean,
): StatsContext {
	if (context && context.tokens !== null) {
		return {
			known: true,
			tokens: context.tokens,
			contextWindow: context.contextWindow,
			percent: context.percent,
			stale: false,
			source: "root",
			observedAt: null,
			measurement: "live",
			provenance: "live",
			requestModel: null,
			branch: null,
		};
	}
	if (activeBranchKnown) return active ? historyContext(active) : unknownContext("root");
	if (active) return historyContext(active);
	return recorded ? historyContext(recorded) : unknownContext("root");
}

function observedModel(value: ObservedModel | undefined): StatsObservedModel | null {
	if (!value) return null;
	return {
		known: value.known,
		provider: value.provider,
		id: value.id,
		observedAt: value.observedAt,
		evidence: value.evidence,
		branch: value.branch,
	};
}

function historyContext(value: ContextObservation): StatsContext {
	return {
		known: true,
		tokens: value.tokens,
		contextWindow: null,
		percent: null,
		stale: true,
		source: "transcript",
		observedAt: value.observedAt,
		measurement: "request-input",
		provenance: value.provenance,
		requestModel: value.model ? { known: true, provider: value.provider, id: value.model } : null,
		branch: value.branch ?? "last-recorded",
	};
}

function buildAgents(input: StatsInput, cost: Cost | null): StatsAgent[] {
	const records = new Map(input.records.map((record) => [record.uuid, record]));
	const agents: StatsAgent[] = [];
	const seen = new Set<string>();

	for (const agent of cost?.agents ?? []) {
		if (agent.parentUuid === null) continue;
		const record = records.get(agent.uuid) ?? null;
		seen.add(agent.uuid);
		agents.push(agentStats(input, agent, record));
	}

	for (const record of records.values()) {
		if (seen.has(record.uuid)) continue;
		// A fork copies its parent's child records, but those children belong to
		// the old root and must not appear as this session's agents.
		if (record.parentUuid !== input.session.id) continue;
		agents.push(agentStats(input, null, record));
	}
	return agents;
}

function agentStats(input: StatsInput, agent: CostAgent | null, record: AgentRecord | null): StatsAgent {
	const uuid = agent?.uuid ?? record?.uuid ?? "";
	const type = agent?.type ?? record?.type ?? null;
	const local = record;
	const run = local ? input.supervisor?.runFor(local.uuid) : undefined;
	const running = run?.isRunning === true;
	const reading = running ? input.supervisor?.contextUsageOf(local?.uuid ?? uuid) ?? null : null;
	const live = validLiveReading(reading) ? reading : null;
	const context = live
		? runContext(live)
		: agent?.lastContext
			? historyContext(agent.lastContext)
			: run
				? runContext(reading)
				: unknownContext("none");
	const status = running ? (run.isIdle ? "idle" : run.status) : "unknown";

	return {
		uuid,
		parentUuid: agent?.parentUuid ?? record?.parentUuid ?? null,
		depth: agent?.depth ?? record?.depth ?? 0,
		type,
		status,
		statusEvidence: running ? "live-run" : "none",
		storedFailure: agent ? agent.failed : (record?.failed ?? null),
		runElapsedMs: running ? run.durationMs : null,
		configuredModel: type ? (input.definitions?.get(type)?.model ?? null) : null,
		observedModel: agent ? observedModel(agent.observedModel) : null,
		context,
		transcript: {
			available: agent ? agent.status === "ok" : false,
			note: agent
				? agent.note
				: input.costs.cost
					? "this agent is not in the read transcript tree"
					: "the cost transcript could not be read",
		},
		cost: agent ? agentCost(agent) : null,
	};
}

function runContext(reading: { tokens: number | null; contextWindow: number | null; percent: number | null; stale: boolean } | null): StatsContext {
	if (!reading || reading.tokens === null) {
		return {
			known: false,
			tokens: reading?.tokens ?? null,
			contextWindow: reading?.contextWindow ?? null,
			percent: reading?.percent ?? null,
			stale: reading?.stale ?? false,
			source: reading ? "run" : "none",
			observedAt: null,
			measurement: "none",
			provenance: "none",
			requestModel: null,
			branch: null,
		};
	}
	return {
		known: true,
		tokens: reading.tokens,
		contextWindow: reading.contextWindow,
		percent: reading.percent,
		stale: reading.stale,
		source: "run",
		observedAt: null,
		measurement: "live",
		provenance: "live",
		requestModel: null,
		branch: null,
	};
}

/** Zero tokens is a valid live reading; a missing token count is not. */
function validLiveReading(
	reading: { tokens: number | null; contextWindow: number | null; percent: number | null; stale: boolean } | null,
): reading is { tokens: number; contextWindow: number | null; percent: number | null; stale: boolean } {
	return reading !== null && typeof reading.tokens === "number" && Number.isFinite(reading.tokens) && reading.tokens >= 0 && Number.isSafeInteger(reading.tokens);
}

function unknownContext(source: "root" | "run" | "none"): StatsContext {
	return {
		known: false,
		tokens: null,
		contextWindow: null,
		percent: null,
		stale: false,
		source,
		observedAt: null,
		measurement: "none",
		provenance: "none",
		requestModel: null,
		branch: null,
	};
}

function costSummary(view: CostView): StatsCosts {
	const cost = view.cost;
	return {
		available: cost !== null,
		total: cost ? usage(cost.total) : null,
		own: cost ? usage(cost.own) : null,
		descendants: cost ? usage(cost.descendants) : null,
		models: cost ? cost.models.map(model) : [],
		incomplete: cost?.incomplete ?? false,
		scanning: view.scanning,
		error: view.error,
		stale: view.stale,
	};
}

function agentCost(agent: CostAgent): StatsCostAgent {
	return {
		known: agent.known,
		own: usage(agent.own),
		subtree: usage(agent.subtree),
		subtreeKnown: agent.subtreeKnown,
		status: agent.status,
		note: agent.note,
	};
}

function todo(file: TodoFile, sessionId: string): StatsTodo {
	return {
		name: file.name,
		title: file.title,
		path: file.path,
		changedAt: file.mtimeMs,
		total: file.total,
		done: file.done,
		remaining: Math.max(0, file.total - file.done),
		items: file.items.map((item) => ({ text: item.text, done: item.done })),
		owner: { kind: "session", sessionId },
	};
}

function model(entry: CostModel): StatsModelUsage {
	return { key: entry.key, usage: usage(entry.usage) };
}

function usage(value: Usage): StatsUsage {
	return {
		input: value.input,
		output: value.output,
		cacheRead: value.cacheRead,
		cacheWrite: value.cacheWrite,
		cost: value.cost,
	};
}
