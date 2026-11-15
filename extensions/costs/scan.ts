/**
 * Session cost: this session's own transcript plus every nested pi-taskforce
 * child transcript it recorded.
 *
 * The walk is deliberately the same shape as the Pilot Go reader: all entries
 * (not just the active branch), latest child record per uuid, a `--fork`
 * child's copied history left out of its own cost, and a transcript counted
 * once. A transcript is only opened when it sits in this session's own
 * `subagents/<transcript stem>/` tree, with no symlinked path component.
 */

import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface CostModel {
	key: string;
	usage: Usage;
}

/** Model evidence from an assistant message on the agent's branch. */
export interface ObservedModel {
	known: true;
	provider: string | null;
	id: string;
	observedAt: number | null;
	/** response-model is provider-reported; message is the recorded request model. */
	evidence: "response-model" | "message";
	/** active only when the caller supplies the real live leaf. */
	branch: "active" | "last-recorded";
}

/** Historical request-input size, never a claim about the current context. */
export interface ContextObservation {
	kind: "request-input";
	source: "transcript";
	tokens: number;
	observedAt: number;
	provider: string | null;
	model: string | null;
	provenance: "assistant-usage" | "before-compaction" | "before-context-edit";
	/** last-recorded is transcript-only; active is supplied live-leaf evidence. */
	branch: "active" | "last-recorded";
}

export type CostAgentStatus = "ok" | "missing" | "error" | "outside" | "cycle" | "duplicate";

export interface CostAgent {
	uuid: string;
	parentUuid: string | null;
	type: string | null;
	depth: number;
	forked: boolean;
	failed: boolean;
	status: CostAgentStatus;
	/** What happened to a child that could not be read; empty for a normal row. */
	note: string;
	/** This agent's own usage. Partial when `known` is false. */
	own: Usage;
	known: boolean;
	/** Own plus every known descendant. */
	subtree: Usage;
	subtreeKnown: boolean;
	models: CostModel[];
	/** Last assistant model on this agent's last-recorded, non-inherited branch. */
	observedModel?: ObservedModel;
	/** Last measured assistant request-input size on that same branch. */
	lastContext?: ContextObservation;
}

export interface Cost {
	/** Known total: own plus known descendants. */
	total: Usage;
	/** This transcript's whole usage history, matching pi's /session totals. */
	own: Usage;
	/** Known descendant usage only. */
	descendants: Usage;
	models: CostModel[];
	agents: CostAgent[];
	/** A recorded child is unknown, or some usage could not be parsed. */
	incomplete: boolean;
}

export interface CostView {
	cost: Cost | null;
	scanning: boolean;
	error: string | null;
	stale: boolean;
}

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const CHILD_ENTRY = "pi-taskforce-child";

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
	return {
		input: a.input + b.input,
		output: a.output + b.output,
		cacheRead: a.cacheRead + b.cacheRead,
		cacheWrite: a.cacheWrite + b.cacheWrite,
		cost: a.cost + b.cost,
	};
}

export function usageTokens(usage: Usage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

interface RawEntry {
	id?: unknown;
	type?: unknown;
	[key: string]: unknown;
}

interface LoadedSession {
	header: { id: string; parentSession: string | null };
	entries: RawEntry[];
	malformed: number;
}

interface ChildRecord {
	uuid: string;
	parentUuid: string | null;
	type: string | null;
	failed: boolean;
	sessionFile: string | null;
	spawnedAt: number;
	depth: number;
	forked: boolean;
}

interface EntryUsage {
	usage: Usage;
	key: string;
	malformed: boolean;
}

/** Reads one session and every child it records. Throws when the root is not a session. */
export async function readCost(sessionFile: string): Promise<Cost> {
	const rawRoot = resolve(sessionFile);
	let rootPath: string;
	try {
		rootPath = await realpath(rawRoot);
	} catch {
		rootPath = rawRoot;
	}
	const root = await loadSession(rootPath);
	const walker = new Walker(rootPath, await subagentBase(rawRoot));
	const rootAgent: CostAgent = {
		uuid: root.header.id,
		parentUuid: null,
		type: null,
		depth: 1,
		forked: false,
		failed: false,
		status: "ok",
		note: "",
		own: emptyUsage(),
		known: true,
		subtree: emptyUsage(),
		subtreeKnown: true,
		models: [],
	};
	walker.ancestor.add(rootPath);
	await walker.walk(root, rootAgent, null, rootPath);

	const total = rootAgent.subtree;
	return {
		total,
		own: rootAgent.own,
		descendants: {
			input: total.input - rootAgent.own.input,
			output: total.output - rootAgent.own.output,
			cacheRead: total.cacheRead - rootAgent.own.cacheRead,
			cacheWrite: total.cacheWrite - rootAgent.own.cacheWrite,
			cost: total.cost - rootAgent.own.cost,
		},
		models: sortedModels(walker.models),
		agents: walker.agents,
		incomplete: walker.incomplete,
	};
}

class Walker {
	readonly agents: CostAgent[] = [];
	readonly models = new Map<string, Usage>();
	incomplete = false;
	private readonly seenUuid = new Map<string, string>();
	private readonly seenPath = new Map<string, string>();
	readonly ancestor = new Set<string>();

	constructor(
		private readonly rootPath: string,
		private readonly base: string | null,
	) {}

	async walk(
		session: LoadedSession,
		agent: CostAgent,
		skip: ReadonlySet<string> | null,
		path: string,
	): Promise<void> {
		agent.status = "ok";
		agent.known = session.malformed === 0;
		agent.note = session.malformed > 0 ? `${session.malformed} unreadable transcript line(s); its cost is partial` : "";
		if (!agent.known) this.incomplete = true;

		const summed = sumEntries(session.entries, skip);
		agent.own = summed.usage;
		agent.models = sortedModels(summed.models);
		const observed = observe(session.entries, skip);
		if (observed.model) agent.observedModel = observed.model;
		if (observed.context) agent.lastContext = observed.context;
		if (summed.malformed > 0) {
			agent.known = false;
			agent.note = joinNotes(agent.note, `${summed.malformed} unreadable usage value(s); its cost is partial`);
			this.incomplete = true;
		}
		for (const [key, usage] of summed.models) this.models.set(key, addUsage(this.models.get(key) ?? emptyUsage(), usage));

		agent.subtree = agent.own;
		agent.subtreeKnown = agent.known;
		this.seenUuid.set(agent.uuid, "agent");
		this.seenPath.set(path, agent.uuid);

		const index = this.agents.length;
		this.agents.push(agent);

		const read = childrenOf(session.entries, agent.uuid);
		if (read.invalid > 0) {
			agent.known = false;
			agent.subtreeKnown = false;
			agent.note = joinNotes(agent.note, `${read.invalid} unreadable child record(s)`);
			this.incomplete = true;
		}

		for (const record of read.children) {
			const child: CostAgent = {
				uuid: record.uuid,
				parentUuid: record.parentUuid,
				type: record.type,
				depth: record.depth > agent.depth ? record.depth : agent.depth + 1,
				forked: record.forked,
				failed: record.failed,
				status: "ok",
				note: "",
				own: emptyUsage(),
				known: false,
				subtree: emptyUsage(),
				subtreeKnown: false,
				models: [],
			};

			const prior = this.seenUuid.get(record.uuid);
			if (prior) {
				child.status = "duplicate";
				child.note = "this agent was already recorded";
				this.agents.push(child);
				continue;
			}

			const lexical = record.sessionFile ? resolve(record.sessionFile) : null;
			if (lexical === this.rootPath || (lexical !== null && this.ancestor.has(lexical))) {
				child.status = "cycle";
				child.note = "this transcript is an ancestor of the session";
				this.seenUuid.set(record.uuid, "cycle");
				this.agents.push(child);
				continue;
			}

			const resolved = await childPath(record.sessionFile, this.base);
			if (resolved.status !== "ok") {
				child.status = resolved.status;
				child.note = resolved.note;
				this.seenUuid.set(record.uuid, resolved.status);
				this.agents.push(child);
				if (resolved.status === "missing" || resolved.status === "error" || resolved.status === "outside") {
					this.incomplete = true;
					agent.subtreeKnown = false;
				}
				continue;
			}
			const childFile = resolved.path;

			if (childFile === this.rootPath || this.ancestor.has(childFile)) {
				child.status = "cycle";
				child.note = "this transcript is an ancestor of the session";
				this.seenUuid.set(record.uuid, "cycle");
				this.agents.push(child);
				continue;
			}
			const owner = this.seenPath.get(childFile);
			if (owner) {
				child.status = "duplicate";
				child.note = "this transcript is already counted";
				this.seenUuid.set(record.uuid, "duplicate");
				this.agents.push(child);
				continue;
			}

			let childSession: LoadedSession;
			try {
				childSession = await loadSession(childFile);
			} catch (error) {
				child.status = isMissing(error) ? "missing" : "error";
				child.note = child.status === "missing" ? "the recorded transcript is not on disk" : "the recorded transcript could not be read";
				this.seenUuid.set(record.uuid, child.status);
				this.agents.push(child);
				this.incomplete = true;
				agent.subtreeKnown = false;
				continue;
			}

			// A --fork child begins with a copy of its parent's entries. Their ids
			// are the parent's, so leaving them out avoids charging that history
			// twice. Records copied with them belong to the parent's uuid and are
			// skipped by childrenOf above.
			const inherited =
				childSession.header.parentSession !== null || record.forked
					? new Set(session.entries.map((entry) => entry.id).filter((id): id is string => typeof id === "string"))
					: null;

			this.seenUuid.set(record.uuid, "agent");
			this.seenPath.set(childFile, record.uuid);
			this.ancestor.add(childFile);
			const before = this.agents.length;
			await this.walk(childSession, child, inherited, childFile);
			this.ancestor.delete(childFile);

			const walked = this.agents[before];
			if (walked) {
				agent.subtree = addUsage(agent.subtree, walked.subtree);
				if (!walked.subtreeKnown) agent.subtreeKnown = false;
			}
		}

		this.agents[index] = agent;
	}
}

interface ResolvedPath {
	status: "ok" | "missing" | "error" | "outside";
	path: string;
	note: string;
}

/**
 * The root's own subagent folder: `<session dir>/subagents/<root stem>/`.
 * Both directory components must be real directories, not symlinks.
 */
async function subagentBase(rawRoot: string): Promise<string | null> {
	let rootDir: string;
	try {
		rootDir = await realpath(dirname(rawRoot));
	} catch {
		return null;
	}
	const sub = join(rootDir, "subagents");
	try {
		const entry = await lstat(sub);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
	} catch {
		return null;
	}
	const stem = basename(rawRoot, ".jsonl");
	if (!stem || stem === "." || stem === "..") return null;
	const base = join(sub, stem);
	try {
		const entry = await lstat(base);
		if (entry.isSymbolicLink() || !entry.isDirectory()) return null;
		const real = await realpath(base);
		return real === base ? base : null;
	} catch {
		return null;
	}
}

async function childPath(recorded: string | null, base: string | null): Promise<ResolvedPath> {
	const missing = (note: string): ResolvedPath => ({ status: "missing", path: "", note });
	const outside = (note: string): ResolvedPath => ({ status: "outside", path: "", note });
	const error = (note: string): ResolvedPath => ({ status: "error", path: "", note });

	if (!recorded) return missing("no transcript was recorded for this child");
	if (!base) return outside("this session's subagents folder is absent or is a symlink");
	if (!isAbsolute(recorded)) return outside("the recorded transcript path is not absolute");
	if (!recorded.endsWith(".jsonl")) return outside("the recorded path is not a .jsonl transcript");

	const lexical = resolve(recorded);
	if (!inside(base, lexical)) {
		return outside("the recorded transcript lies outside this session's subagents folder");
	}

	const parts = relative(base, lexical).split(sep).filter((part) => part.length > 0);
	if (parts.length === 0) return outside("the recorded path is this session's subagents folder");

	let current = base;
	for (let index = 0; index < parts.length; index++) {
		current = join(current, parts[index]!);
		let entry;
		try {
			entry = await lstat(current);
		} catch (cause) {
			return isMissing(cause) ? missing("the recorded transcript is not on disk") : error("the recorded transcript could not be read");
		}
		if (entry.isSymbolicLink()) return outside("the recorded transcript has a symlinked path component");
		if (index < parts.length - 1) {
			if (!entry.isDirectory()) return outside("the recorded transcript path is not a folder path");
		} else if (!entry.isFile()) {
			return outside("the recorded transcript is not a regular file");
		}
	}

	let real: string;
	try {
		real = await realpath(lexical);
	} catch (cause) {
		return isMissing(cause) ? missing("the recorded transcript is not on disk") : error("the recorded transcript could not be read");
	}
	if (real !== lexical || !inside(base, real)) {
		return outside("the recorded transcript resolves outside this session's subagents folder");
	}
	try {
		const entry = await stat(real);
		if (!entry.isFile()) return outside("the recorded transcript is not a regular file");
		return { status: "ok", path: real, note: "" };
	} catch (cause) {
		return isMissing(cause) ? missing("the recorded transcript is not on disk") : error("the recorded transcript could not be read");
	}
}

function inside(base: string, path: string): boolean {
	const rel = relative(base, path);
	return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * JSON.parse reviver `context.source` preserves the original numeric lexemes,
 * which plain JSON.parse already rounded (for example 1.0000000000000001 -> 1).
 * Older runtimes ignore the third reviver argument, so detect the capability
 * instead of assuming it. The live branch is parsed by Pi before reaching this
 * module and keeps its explicit safe-integer fallback.
 */
type JsonSourceContext = { source?: string };
type SourceReviver = (this: unknown, key: string, value: unknown, context?: JsonSourceContext) => unknown;
type SourceParse = (text: string, reviver: SourceReviver) => unknown;

const JSON_NUMBER_LEXEME = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const USAGE_SOURCE_KEYS = new Set(["input", "cacheRead", "cacheWrite"]);
const USAGE_SOURCES = new WeakMap<object, ReadonlyMap<string, string>>();

function runtimeProvidesJsonSource(): boolean {
	try {
		let preserved = false;
		(JSON.parse as SourceParse)('{"n":1.0000000000000001}', function (key, value, context) {
			if (key === "n" && context?.source === "1.0000000000000001") preserved = true;
			return value;
		});
		return preserved;
	} catch {
		return false;
	}
}

const HAS_JSON_SOURCE = runtimeProvidesJsonSource();

interface ParsedLine {
	value: unknown;
	sources: WeakMap<object, ReadonlyMap<string, string>> | null;
}

/**
 * Parse one transcript line. If the reviver itself fails (deep but valid JSON
 * can exhaust the call stack), keep the ordinary JSON.parse result and spend
 * accounting, but leave exact history evidence unavailable for that entry.
 */
function parseLine(line: string): ParsedLine | null {
	if (HAS_JSON_SOURCE) {
		const sources = new WeakMap<object, Map<string, string>>();
		try {
			const value = (JSON.parse as SourceParse)(line, function (key, value, context) {
				if (this !== null && typeof this === "object" && USAGE_SOURCE_KEYS.has(key)) {
					const holder = this as object;
					const source = context?.source;
					let captured = sources.get(holder);
					if (typeof source === "string" && JSON_NUMBER_LEXEME.test(source)) {
						if (!captured) {
							captured = new Map();
							sources.set(holder, captured);
						}
						captured.set(key, source);
					} else if (captured) {
						// Revivers normally see only the effective duplicate key; deleting
						// here also handles runtimes that visit an overwritten value first.
						captured.delete(key);
					}
				}
				return value;
			});
			return { value, sources };
		} catch {
			// Fall through to the ordinary parser below.
		}
	}
	try {
		return { value: JSON.parse(line), sources: null };
	} catch {
		return null;
	}
}

/** Attach sources only to the effective message usage object the scanner reads. */
function attachUsageSources(entry: RawEntry, sources: ParsedLine["sources"]): void {
	if (!sources || entry.type !== "message") return;
	const message = entry.message;
	if (!message || typeof message !== "object" || Array.isArray(message)) return;
	const usage = (message as Record<string, unknown>).usage;
	if (!usage || typeof usage !== "object" || Array.isArray(usage)) return;
	const captured = sources.get(usage);
	if (captured && captured.size > 0) USAGE_SOURCES.set(usage, captured);
}

async function loadSession(path: string): Promise<LoadedSession> {
	const info = await stat(path);
	if (!info.isFile()) throw new Error("not a regular file");
	if (info.size > MAX_TRANSCRIPT_BYTES) throw new Error("the transcript is too large to read");
	const entries: RawEntry[] = [];
	let malformed = 0;
	let header: LoadedSession["header"] | null = null;
	let bytes = 0;
	const stream = createReadStream(path, { encoding: "utf8" });
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	try {
		for await (const line of lines) {
			bytes += Buffer.byteLength(line) + 1;
			if (bytes > MAX_TRANSCRIPT_BYTES) throw new Error("the transcript is too large to read");
			if (line.trim().length === 0) continue;
			const parsedLine = parseLine(line);
			if (!parsedLine) {
				malformed++;
				continue;
			}
			const parsed = parsedLine.value;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				malformed++;
				continue;
			}
			const entry = parsed as RawEntry;
			attachUsageSources(entry, parsedLine.sources);
			if (entry.type === "session") {
				if (header === null && typeof entry.id === "string" && entry.id.length > 0) {
					header = {
						id: entry.id,
						parentSession: typeof entry.parentSession === "string" && entry.parentSession.length > 0 ? entry.parentSession : null,
					};
				}
				continue;
			}
			entries.push(entry);
		}
	} finally {
		lines.close();
		stream.destroy();
	}
	if (!header) throw new Error("the file is not a pi session transcript");
	return { header, entries, malformed };
}

/**
 * The persisted tree leaf is the last entry that has an id. ID-less records do
 * not participate in the parent chain, so they cannot make branch provenance
 * newer or hide the real leaf.
 */
function activeBranch(entries: readonly RawEntry[]): RawEntry[] | null {
	let leaf: string | null = null;
	for (let index = entries.length - 1; index >= 0; index--) {
		const id = entries[index]?.id;
		if (typeof id === "string" && id.length > 0) {
			leaf = id;
			break;
		}
	}
	if (!leaf) return null;
	const byId = new Map<string, RawEntry>();
	for (const entry of entries) {
		if (typeof entry.id === "string" && entry.id.length > 0) byId.set(entry.id, entry);
	}
	const reverse: RawEntry[] = [];
	const seen = new Set<string>();
	let current: string | null = leaf;
	while (current) {
		if (seen.has(current)) return null;
		seen.add(current);
		const entry = byId.get(current);
		if (!entry) return null;
		reverse.push(entry);
		const parent = entry.parentId;
		if (parent === null) break;
		if (typeof parent !== "string" || parent.length === 0) return null;
		current = parent;
	}
	if (reverse.length === 0 || reverse[reverse.length - 1]?.parentId !== null) return null;
	return reverse.reverse();
}

/**
 * Observations read the last-recorded branch only, skipping entries inherited
 * by a fork. Context is the provider's prompt token count from one assistant
 * request; cumulative session usage is never used as context.
 */
function observe(
	entries: readonly RawEntry[],
	skip: ReadonlySet<string> | null,
): { model: ObservedModel | null; context: ContextObservation | null } {
	const branch = activeBranch(entries);
	if (!branch) return { model: null, context: null };
	return observeBranch(branch, skip, "last-recorded");
}

/**
 * Reads observations from entries the caller already knows are the live
 * session branch. This is the only path allowed to claim `active` provenance.
 */
export function observeActiveBranch(entries: readonly unknown[]): {
	model: ObservedModel | null;
	context: ContextObservation | null;
} {
	return observeBranch(entries as readonly RawEntry[], null, "active");
}

function observeBranch(
	branch: readonly RawEntry[],
	skip: ReadonlySet<string> | null,
	branchEvidence: "active" | "last-recorded",
): { model: ObservedModel | null; context: ContextObservation | null } {
	let model: ObservedModel | null = null;
	let context: ContextObservation | null = null;
	let measurementIndex = -1;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index]!;
		if (skip && typeof entry.id === "string" && skip.has(entry.id)) continue;
		if (entry.type !== "message" || !entry.message || typeof entry.message !== "object" || Array.isArray(entry.message)) continue;
		const message = entry.message as Record<string, unknown>;
		if (message.role !== "assistant") continue;
		const at = timestampOf(entry, message.timestamp);
		const requested = typeof message.model === "string" ? message.model.trim() : "";
		const response = typeof message.responseModel === "string" ? message.responseModel.trim() : "";
		const id = response || requested;
		if (id) {
			model = {
				known: true,
				provider: typeof message.provider === "string" && message.provider.trim() ? message.provider.trim() : null,
				id,
				observedAt: at > 0 ? at : null,
				evidence: response ? "response-model" : "message",
				branch: branchEvidence,
			};
		}
		if (!requested || at <= 0) continue;
		const usage = message.usage;
		const sources = usage && typeof usage === "object" && !Array.isArray(usage) ? USAGE_SOURCES.get(usage) : undefined;
		const tokens = requestInputTokens(usage, sources, branchEvidence === "active");
		if (tokens === null) continue;
		context = {
			kind: "request-input",
			source: "transcript",
			tokens,
			observedAt: at,
			provider: typeof message.provider === "string" && message.provider.trim() ? message.provider.trim() : null,
			model: requested,
			provenance: "assistant-usage",
			branch: branchEvidence,
		};
		measurementIndex = index;
	}
	if (context) {
		for (const entry of branch.slice(measurementIndex + 1)) {
			if (entry.type === "compaction") context.provenance = "before-compaction";
			else if (entry.type === "context_edit") context.provenance = "before-context-edit";
		}
	}
	return { model, context };
}

const ISO_TIMESTAMP =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Date.parse normalizes impossible calendar dates (for example February 30).
 * Validate the calendar fields first, matching Go's RFC3339Nano parser.
 */
function parseIsoTimestamp(value: unknown): number {
	if (typeof value !== "string") return 0;
	const match = ISO_TIMESTAMP.exec(value);
	if (!match) return 0;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const hour = Number(match[4]);
	const minute = Number(match[5]);
	const second = Number(match[6]);
	const zone = match[7]!;
	if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return 0;
	const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
	if (day > daysInMonth) return 0;
	if (zone !== "Z") {
		const offsetHour = Number(zone.slice(1, 3));
		const offsetMinute = Number(zone.slice(4, 6));
		if (offsetHour > 23 || offsetMinute > 59) return 0;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function timestampOf(entry: RawEntry, messageTimestamp: unknown): number {
	const iso = parseIsoTimestamp(entry.timestamp);
	if (iso > 0) return iso;
	if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp) && messageTimestamp > 0 && messageTimestamp <= Number.MAX_SAFE_INTEGER) {
		return Math.trunc(messageTimestamp);
	}
	return 0;
}

function requestInputTokens(
	value: unknown,
	sources: ReadonlyMap<string, string> | undefined,
	allowParsedFallback: boolean,
): number | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const usage = value as Record<string, unknown>;
	let total = 0;
	for (const key of ["input", "cacheRead", "cacheWrite"] as const) {
		if (!Object.prototype.hasOwnProperty.call(usage, key)) return null;
		let field: number | null;
		if (sources) {
			const lexeme = sources.get(key);
			field = lexeme === undefined ? null : exactTokenCount(lexeme);
		} else if (allowParsedFallback) {
			const parsed = usage[key];
			field = typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0 && Number.isSafeInteger(parsed) ? parsed : null;
		} else {
			// Disk transcript without a reviver source: never trust the rounded value.
			field = null;
		}
		if (field === null || total > Number.MAX_SAFE_INTEGER - field) return null;
		total += field;
	}
	return total;
}

/**
 * Validate a raw JSON number lexeme without converting it to a JavaScript
 * number first. Fractions, unsafe values and negative values are rejected;
 * integral exponent notation such as 1.0e3 is accepted.
 */
function exactTokenCount(lexeme: string): number | null {
	const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(lexeme.trim());
	if (!match) return null;
	const negative = match[1] === "-";
	const whole = match[2]!;
	const fraction = match[3] ?? "";
	if (whole.length + fraction.length > 1_000) return null;
	const exponentText = match[4] ?? "0";
	const exponent = Number(exponentText);
	if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1_000) return null;
	const digits = `${whole}${fraction}`.replace(/^0+/, "");
	if (digits.length === 0) return 0;
	if (negative) return null;
	const scale = exponent - fraction.length;
	let value: bigint;
	if (scale >= 0) {
		if (scale > 16) return null;
		value = BigInt(digits) * 10n ** BigInt(scale);
	} else {
		const trim = -scale;
		if (trim >= digits.length) return null;
		const cut = digits.length - trim;
		if (!/^0*$/.test(digits.slice(cut))) return null;
		value = BigInt(digits.slice(0, cut) || "0");
	}
	return value <= 9_007_199_254_740_991n ? Number(value) : null;
}

function childrenOf(entries: readonly RawEntry[], parentUuid: string): { children: ChildRecord[]; invalid: number } {
	const latest = new Map<string, ChildRecord>();
	let invalid = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CHILD_ENTRY) continue;
		const record = asChildRecord(entry.data);
		if (!record) {
			invalid++;
			continue;
		}
		latest.set(record.uuid, record);
	}
	const children: ChildRecord[] = [];
	for (const record of latest.values()) {
		if (record.parentUuid === parentUuid) children.push(record);
	}
	children.sort((a, b) => (a.spawnedAt === b.spawnedAt ? (a.uuid < b.uuid ? -1 : 1) : a.spawnedAt - b.spawnedAt));
	return { children, invalid };
}

function asChildRecord(data: unknown): ChildRecord | null {
	if (!data || typeof data !== "object" || Array.isArray(data)) return null;
	const raw = data as Record<string, unknown>;
	if (typeof raw.uuid !== "string" || raw.uuid.length === 0) return null;
	return {
		uuid: raw.uuid,
		parentUuid: typeof raw.parentUuid === "string" ? raw.parentUuid : null,
		type: typeof raw.type === "string" ? raw.type : null,
		failed: raw.failed === true,
		sessionFile: typeof raw.sessionFile === "string" && raw.sessionFile.length > 0 ? raw.sessionFile : null,
		spawnedAt: finite(raw.spawnedAt) ?? 0,
		depth: finite(raw.depth) ?? 0,
		forked: raw.forked === true,
	};
}

function sumEntries(
	entries: readonly RawEntry[],
	skip: ReadonlySet<string> | null,
): { usage: Usage; models: Map<string, Usage>; malformed: number } {
	const usage = emptyUsage();
	const models = new Map<string, Usage>();
	let malformed = 0;
	for (const entry of entries) {
		if (skip && typeof entry.id === "string" && skip.has(entry.id)) continue;
		const parsed = entryUsage(entry);
		if (!parsed) continue;
		usage.input += parsed.usage.input;
		usage.output += parsed.usage.output;
		usage.cacheRead += parsed.usage.cacheRead;
		usage.cacheWrite += parsed.usage.cacheWrite;
		usage.cost += parsed.usage.cost;
		models.set(parsed.key, addUsage(models.get(parsed.key) ?? emptyUsage(), parsed.usage));
		if (parsed.malformed) malformed++;
	}
	return { usage, models, malformed };
}

function entryUsage(entry: RawEntry): EntryUsage | null {
	if (entry.type === "usage") {
		const parsed = parseUsage(entry.usage);
		if (!parsed) return null;
		return { usage: parsed.usage, key: modelKey(entry.provider, entry.model), malformed: parsed.malformed };
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		const parsed = parseUsage(entry.usage);
		if (!parsed) return null;
		return { usage: parsed.usage, key: "Tools/summaries", malformed: parsed.malformed };
	}
	if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") return null;
	const message = entry.message as Record<string, unknown>;
	const parsed = parseUsage(message.usage);
	if (!parsed) return null;
	if (message.role === "assistant") {
		return {
			usage: parsed.usage,
			key: modelKey(message.provider, message.responseModel ?? message.model),
			malformed: parsed.malformed,
		};
	}
	if (message.role === "toolResult" || message.role === "branchSummary" || message.role === "compactionSummary") {
		return { usage: parsed.usage, key: "Tools/summaries", malformed: parsed.malformed };
	}
	return null;
}

function parseUsage(value: unknown): { usage: Usage; malformed: boolean } | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const raw = value as Record<string, unknown>;
	const costValue = raw.cost;
	let cost = 0;
	let malformed = false;
	if (typeof costValue === "number") {
		if (Number.isFinite(costValue)) cost = costValue;
		else malformed = true;
	} else if (costValue && typeof costValue === "object") {
		const total = (costValue as Record<string, unknown>).total;
		if (typeof total === "number" && Number.isFinite(total)) cost = total;
		else if (total !== undefined) malformed = true;
	} else if (costValue !== undefined && costValue !== null) {
		malformed = true;
	}
	const number = (key: "input" | "output" | "cacheRead" | "cacheWrite"): number => {
		const field = raw[key];
		if (field === undefined || field === null) return 0;
		if (typeof field === "number" && Number.isFinite(field)) return field;
		malformed = true;
		return 0;
	};
	return {
		usage: {
			input: number("input"),
			output: number("output"),
			cacheRead: number("cacheRead"),
			cacheWrite: number("cacheWrite"),
			cost,
		},
		malformed,
	};
}

function modelKey(provider: unknown, model: unknown): string {
	const p = typeof provider === "string" ? provider : "";
	const m = typeof model === "string" ? model : "";
	return p === "" && m === "" ? "Tools/summaries" : `${p}/${m}`;
}

function sortedModels(models: Map<string, Usage>): CostModel[] {
	return [...models]
		.filter(([, usage]) => usage.cost > 0 || usageTokens(usage) > 0)
		.map(([key, usage]) => ({ key, usage }))
		.sort((a, b) => (b.usage.cost === a.usage.cost ? a.key.localeCompare(b.key) : b.usage.cost - a.usage.cost));
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isMissing(error: unknown): boolean {
	return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function joinNotes(first: string, second: string): string {
	return first.length === 0 ? second : `${first}; ${second}`;
}
