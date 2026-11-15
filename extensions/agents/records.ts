/**
 * §9. The children a parent can address, recorded as custom entries in the
 * parent's own session. The session outlives the process, so the children are
 * still addressable after pi restarts, and the entries never reach the model.
 */

export type AgentId = string;

/** An agent record. It carries no live status: that is read from the run (§9). */
export interface AgentRecord {
	uuid: AgentId;
	parentUuid: AgentId | null;
	/** The agent type name, or `null` for a root. */
	type: string | null;
	/** The outcome of the child's last run, the one thing that outlives it. */
	failed: boolean;
	sessionFile: string | null;
	spawnedAt: number;
	/** Position in the agent tree. The root sits at 1. */
	depth: number;
	/** Started from a copy of its parent's conversation (§7). */
	forked: boolean;
}

export const CHILD_ENTRY = "pi-taskforce-child";

interface EntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

export class ChildRecords {
	private readonly byId = new Map<AgentId, AgentRecord>();

	constructor(private readonly append: (record: AgentRecord) => void) {}

	/** Reads the entries of the active branch back; a later entry wins. */
	load(entries: readonly EntryLike[]): void {
		this.byId.clear();
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.customType !== CHILD_ENTRY) continue;
			const record = asRecord(entry.data);
			if (record) this.byId.set(record.uuid, record);
		}
	}

	all(): AgentRecord[] {
		return [...this.byId.values()].sort((a, b) => a.spawnedAt - b.spawnedAt);
	}

	get(uuid: AgentId): AgentRecord | null {
		return this.byId.get(uuid) ?? null;
	}

	add(record: AgentRecord): void {
		this.byId.set(record.uuid, record);
		this.append(record);
	}

	update(uuid: AgentId, patch: Partial<Omit<AgentRecord, "uuid">>): void {
		const current = this.byId.get(uuid);
		if (!current) return;
		const next = { ...current, ...patch };
		if (Object.entries(patch).every(([key, value]) => current[key as keyof AgentRecord] === value)) return;
		this.byId.set(uuid, next);
		this.append(next);
	}
}

function asRecord(data: unknown): AgentRecord | null {
	if (!data || typeof data !== "object") return null;
	const raw = data as Partial<AgentRecord>;
	if (typeof raw.uuid !== "string" || typeof raw.depth !== "number") return null;
	return {
		uuid: raw.uuid,
		parentUuid: typeof raw.parentUuid === "string" ? raw.parentUuid : null,
		type: typeof raw.type === "string" ? raw.type : null,
		failed: raw.failed === true,
		sessionFile: typeof raw.sessionFile === "string" ? raw.sessionFile : null,
		spawnedAt: typeof raw.spawnedAt === "number" ? raw.spawnedAt : 0,
		depth: raw.depth,
		forked: raw.forked === true,
	};
}
