/**
 * Reads the persisted ask-smoke session and reports what a restart would find.
 *
 * This is the check after quitting with a question open: the journal entries are
 * read from the real session file through the SDK, not from process memory.
 * Exits 1 when nothing is recoverable, so it can double as an assertion.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import { recoverableAsks, scanAsks } from "../extensions/ask/journal.js";

const work = process.argv[2];
if (!work) {
	console.error("usage: bun scripts/ask-smoke-check.ts <workspace>");
	process.exit(2);
}

const sessions = join(work, "sessions");
const files = readdirSync(sessions).filter((name) => name.endsWith(".jsonl"));
if (files.length === 0) {
	console.log("ask smoke: no session file yet. Run scripts/ask-smoke.sh once.");
	process.exit(1);
}
const file = join(sessions, files[0]!);
const manager = SessionManager.open(file, sessions);
const branch = manager.getBranch();
const scan = scanAsks(branch as never);
const recoverable = recoverableAsks(branch as never, manager.getSessionId() ?? null);
console.log(`ask smoke: ${file}`);
console.log(`ask smoke: ${branch.length} entries on the branch, ${scan.done.size} finished ask(s)`);
console.log(`ask smoke: ${recoverable.length} recoverable question(s)`);
for (const found of recoverable) {
	const answered = Object.keys(found.draft?.answers ?? {});
	console.log(
		`  ${found.pending.id}: "${found.pending.ask.questions[0]?.prompt ?? ""}"` +
			` draft=${found.draft ? `yes (position ${found.draft.index})` : "no"}` +
			` answers=${answered.length > 0 ? answered.join(",") : "none"}` +
			` submitted=${found.submitted ? found.submitted.by : "no"}`,
			` ${found.dispatch ? `dispatched-by=${found.dispatch.token.slice(0, 8)}` : "not-dispatched"}`,
	);
}
process.exit(recoverable.length > 0 ? 0 : 1);
