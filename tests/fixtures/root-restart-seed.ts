/** First real process: leaves one ask pending on a persisted session. */
import { mkdirSync } from "node:fs";

import { SessionManager } from "@earendil-works/pi-coding-agent";

import {
	ANSWER_ENTRY,
	DONE_ENTRY,
	PENDING_ENTRY,
	SEND_ATTEMPT_ENTRY,
	SUBMIT_ENTRY,
	WAKE_ATTEMPT_ENTRY,
} from "../../extensions/ask/journal.js";

const cwd = process.argv[2]!;
const sessions = `${cwd}/sessions`;
mkdirSync(sessions, { recursive: true });
const manager = SessionManager.create(cwd, sessions, { id: "restart-session" });
manager.appendMessage({ role: "user", content: "Start the restarted task.", timestamp: Date.now() } as never);
manager.appendMessage({
	role: "assistant",
	content: [
		{
			type: "toolCall",
			id: "call_restart_ask",
			name: "ask",
			arguments: {
				context: "Restart test",
				questions: [
					{
						id: "q",
						prompt: "Which target?",
						type: "select",
						options: [
							{ value: "android", label: "Android" },
							{ value: "ios", label: "iOS" },
						],
					},
				],
			},
		},
	],
	api: "probe-api",
	provider: "synthetic",
	model: "fake-1",
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	stopReason: "toolUse",
	timestamp: Date.now(),
} as never);
const assistantEntryId = manager.getBranch().at(-1)?.id ?? null;
manager.appendCustomEntry(PENDING_ENTRY, {
	v: 2,
	id: "ask-restart",
	sessionId: "restart-session",
	createdAt: Date.now(),
	ask: {
		context: "Restart test",
		questions: [
			{
				id: "q",
				prompt: "Which target?",
				type: "select",
				options: [
					{ value: "android", label: "Android" },
					{ value: "ios", label: "iOS" },
				],
			},
		],
	},
	from: { agentId: "root", agentType: "root", depth: 0 },
	via: [],
	attribution: null,
	toolCallId: "call_restart_ask",
	assistantEntryId,
});
const variant = process.env.RESTART_SEED ?? "pending";
if (variant === "submitted") {
	manager.appendCustomEntry(SUBMIT_ENTRY, {
		v: 2,
		id: "ask-restart",
		at: Date.now(),
		by: "remote",
		sessionId: "restart-session",
		submitId: "old-submit",
		result: {
			outcome: "answered",
			answers: [{ id: "q", values: ["android"], labels: ["Android"], typed: false, note: null, omitted: false }],
		},
	});
	manager.appendCustomEntry(SEND_ATTEMPT_ENTRY, {
		v: 1,
		id: "ask-restart",
		at: Date.now(),
		toolCallId: "call_restart_ask",
		sessionId: "restart-session",
		process: "previous-process",
		submitId: "old-submit",
	});
} else if (variant === "canonical-wake" || variant === "canonical-done") {
	manager.appendCustomMessageEntry(
		ANSWER_ENTRY,
		"q: Android",
		true,
		{
			v: 2,
			askId: "ask-restart",
			outcome: "answered",
			toolCallId: "call_restart_ask",
			assistantEntryId,
			sessionId: "restart-session",
			from: { agentId: "root", agentType: "root", depth: 0 },
			at: Date.now(),
		},
	);
	const canonicalEntryId = manager.getBranch().at(-1)?.id ?? null;
	// Normal product order: the question is marked done before the wake request.
	manager.appendCustomEntry(DONE_ENTRY, {
		v: 1,
		id: "ask-restart",
		at: Date.now(),
		how: "recovered",
	});
	if (variant === "canonical-wake") {
		manager.appendCustomEntry(WAKE_ATTEMPT_ENTRY, {
			v: 2,
			id: "ask-restart",
			at: Date.now(),
			toolCallId: "call_restart_ask",
			sessionId: "restart-session",
			process: "previous-process",
			canonicalEntryId,
		});
	}
}
process.stdout.write(`${manager.getSessionFile()}\n`);
