/**
 * Seeds the isolated ask-smoke session with one real user message.
 *
 * `pi.appendEntry()` only reaches the session file once a conversation exists:
 * a session with custom entries alone is never written, so a restart sees no
 * journal at all. This creates the session through the SDK with a normal user
 * message first, which is what a production session already has. No model call
 * is involved, and an existing workspace is left alone.
 */
import { existsSync, mkdirSync, readdirSync } from "node:fs";

import { SessionManager } from "@earendil-works/pi-coding-agent";

const work = process.argv[2];
if (!work) {
	console.error("usage: bun scripts/ask-smoke-seed.ts <workspace>");
	process.exit(2);
}

const sessions = `${work}/sessions`;
mkdirSync(sessions, { recursive: true });
const existing = existsSync(sessions) ? readdirSync(sessions).filter((name) => name.endsWith(".jsonl")) : [];
if (existing.length > 0) {
	console.log(`ask smoke: session already in ${sessions}; not seeding again`);
	process.exit(0);
}

const manager = SessionManager.create(work, sessions, { id: "ask-smoke" });
manager.appendMessage({
	role: "user",
	content: [
		{
			type: "text",
			text: "(ask smoke) The session exists so its journal persists. Quit while an ask is open, run the script again, and it comes back. No model is called.",
		},
	],
	timestamp: Date.now(),
});
console.log(`ask smoke: seeded ${manager.getSessionFile()}`);
