import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { DRAFT_ENTRY, PENDING_ENTRY, SUBMIT_ENTRY, recoverableAsks } from "../extensions/ask/journal.js";
import { validateAsk } from "../extensions/ask/schema.js";

const checked = validateAsk(null, [
	{
		id: "target",
		prompt: "Which target?",
		options: [
			{ value: "local", label: "Local" },
			{ value: "staging", label: "Staging" },
		],
	},
	{ id: "note", prompt: "Anything to say?", optional: true },
]);
if (!checked.ok) throw new Error(checked.message);
const ask = checked.ask;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-taskforce-smoke-"));
	dirs.push(dir);
	return dir;
}

/**
 * The real persistence path the smoke script uses. A session with only custom
 * entries is never written; the seed's user message is what makes the journal
 * survive a quit, and the reopened file is what the next run restores from.
 */
describe("§12 the smoke workspace persists the journal across a restart", () => {
	it("only writes the journal once the seeded conversation exists, then restores it", () => {
		const work = workspace();
		const sessions = join(work, "sessions");

		const first = SessionManager.create(work, sessions, { id: "ask-smoke" });
		first.appendCustomEntry(PENDING_ENTRY, {
			v: 1,
			id: "ask-smoke-1",
			sessionId: "ask-smoke",
			createdAt: 1,
			ask,
			from: { agentId: "ask-smoke", agentType: "root", depth: 0 },
			via: [],
			attribution: null,
		});
		// Nothing is on disk yet: pi does not persist a session without a message.
		expect(existsSync(first.getSessionFile()!)).toBe(false);

		first.appendMessage({
			role: "user",
			content: [{ type: "text", text: "(ask smoke) the session exists so its journal persists" }],
			timestamp: Date.now(),
		});
		const file = first.getSessionFile();
		expect(file).toBeDefined();
		// The pending entry written before the message is flushed with it.
		expect(readFileSync(file!, "utf8")).toContain(PENDING_ENTRY);

		first.appendCustomEntry(DRAFT_ENTRY, {
			v: 1,
			id: "ask-smoke-1",
			at: 2,
			index: 1,
			answers: { target: { picked: ["staging"] } },
		});
		first.appendCustomEntry(SUBMIT_ENTRY, {
			v: 1,
			id: "ask-smoke-1",
			at: 3,
			by: "terminal",
			result: {
				outcome: "answered",
				answers: [
					{ id: "target", values: ["staging"], labels: ["Staging"], typed: false, omitted: false, note: null },
					{ id: "note", values: ["persisted"], labels: ["persisted"], typed: true, omitted: false, note: null },
				],
			},
		});

		// The restart: a new manager reads the same file, and the question comes
		// back with the submitted answers and the note.
		const opened = SessionManager.open(file!, sessions);
		const restored = recoverableAsks(opened.getBranch() as never, "ask-smoke");
		expect(restored).toHaveLength(1);
		expect(restored[0]!.pending.id).toBe("ask-smoke-1");
		expect(restored[0]!.submitted).toMatchObject({ by: "terminal", at: 3 });
		expect(restored[0]!.draft).toMatchObject({
			index: 2,
			answers: { target: { picked: ["staging"] }, note: { typed: "persisted" } },
		});
	});
});
