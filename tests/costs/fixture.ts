import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

export interface Fixture {
	dir: string;
	rootFile: string;
	rootStem: string;
	base: string;
}

export const ROOT_ID = "root-uuid";
export const ROOT_STEM = "2026-01-01T00-00-00-000Z_root";

let clock = 1_000;

function stamp(): string {
	return new Date(clock++).toISOString();
}

export function makeFixture(): Fixture {
	const dir = mkdtempSync(join(tmpdir(), "taskforce-costs-"));
	const rootFile = join(dir, `${ROOT_STEM}.jsonl`);
	const base = join(dir, "subagents", ROOT_STEM);
	mkdirSync(base, { recursive: true });
	writeFileSync(rootFile, `${JSON.stringify(header(ROOT_ID))}\n`);
	return { dir, rootFile, rootStem: ROOT_STEM, base };
}

export function cleanup(fixture: Fixture): void {
	rmSync(fixture.dir, { recursive: true, force: true });
}

export function header(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { type: "session", version: 3, id, timestamp: new Date(clock++).toISOString(), cwd: "/work", ...extra };
}

export function writeSession(file: string, id: string, entries: Record<string, unknown>[], extra: Record<string, unknown> = {}): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, [header(id, extra), ...entries].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

export function appendSession(file: string, entries: Record<string, unknown>[]): void {
	appendFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

/** Write a session with already-serialized entry lines, preserving number lexemes. */
export function writeRawSession(file: string, id: string, lines: string[]): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, [JSON.stringify(header(id)), ...lines].join("\n") + "\n");
}

export function usage(input = 0, output = 0, cacheRead = 0, cacheWrite = 0, cost = 0): Record<string, unknown> {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

export function assistant(
	id: string,
	u: Record<string, unknown>,
	options: { provider?: string; model?: string; responseModel?: string } = {},
): Record<string, unknown> {
	return {
		type: "message",
		id,
		timestamp: stamp(),
		message: {
			role: "assistant",
			provider: options.provider ?? "deepseek",
			model: options.model ?? "deepseek-flash",
			...(options.responseModel ? { responseModel: options.responseModel } : {}),
			usage: u,
		},
	};
}

export function toolResult(id: string, u: Record<string, unknown>): Record<string, unknown> {
	return { type: "message", id, timestamp: stamp(), message: { role: "toolResult", usage: u } };
}

export function usageEntry(
	id: string,
	u: Record<string, unknown>,
	provider = "deepseek",
	model = "deepseek-flash",
): Record<string, unknown> {
	return { type: "usage", id, timestamp: stamp(), kind: "cache_warm", provider, model, usage: u };
}

export function compaction(id: string, u: Record<string, unknown>): Record<string, unknown> {
	return { type: "compaction", id, timestamp: stamp(), summary: "", firstKeptEntryId: "x", tokensBefore: 1, usage: u };
}

export function branchSummary(id: string, u: Record<string, unknown>): Record<string, unknown> {
	return { type: "branch_summary", id, timestamp: stamp(), fromId: "x", summary: "", usage: u };
}

export function messageUsage(
	id: string,
	role: string,
	u: Record<string, unknown>,
): Record<string, unknown> {
	return { type: "message", id, timestamp: stamp(), message: { role, usage: u } };
}

export interface RecordInput {
	uuid: string;
	parentUuid: string | null;
	sessionFile: string | null;
	type?: string | null;
	depth?: number;
	forked?: boolean;
	failed?: boolean;
	spawnedAt?: number;
}

export function childRecord(entryId: string, input: RecordInput): Record<string, unknown> {
	return {
		type: "custom",
		id: entryId,
		timestamp: stamp(),
		customType: "pi-taskforce-child",
		data: {
			uuid: input.uuid,
			parentUuid: input.parentUuid,
			type: input.type ?? "scout",
			failed: input.failed ?? false,
			sessionFile: input.sessionFile,
			spawnedAt: input.spawnedAt ?? clock,
			depth: input.depth ?? 2,
			forked: input.forked ?? false,
		},
	};
}

export function childFile(fixture: Fixture, name: string): string {
	return join(fixture.base, `${name}.jsonl`);
}

export function childStem(file: string): string {
	return basename(file, ".jsonl");
}
