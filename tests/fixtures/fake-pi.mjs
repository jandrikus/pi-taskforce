// A stand-in for `pi --mode rpc`: answers the commands a ChildRun sends and plays
// back one scripted run, chosen by FAKE_PI_SCRIPT.
import { createInterface } from "node:readline";

const script = process.env.FAKE_PI_SCRIPT ?? "finish";
const emit = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const assistant = (content, extra = {}) =>
	emit({ type: "message_end", message: { role: "assistant", content, stopReason: "stop", ...extra } });

function run() {
	if (script === "garbage") {
		for (const line of ["null", "[]", "42", "\"text\"", "{\"type\":7}", "{\"type\":\"message_end\",\"message\":null}", "{\"type\":\"message_update\"}", "{\"type\":\"extension_ui_request\"}"]) {
			process.stdout.write(`${line}\n`);
		}
	}
	if (script === "stream") {
		emit({ type: "message_start", message: { role: "assistant", content: [] } });
		emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } });
		emit({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "think" } });
		emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
		emit({ type: "tool_execution_update", toolCallId: "c1", partialResult: { content: [{ type: "text", text: "partial output" }] } });
		emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: true });
	}
	emit({ type: "agent_start" });
	emit({ type: "turn_start" });
	assistant([{ type: "text", text: "Looking around." }, { type: "toolCall", name: "read" }]);
	if (script === "crash") process.exit(3);
	emit({ type: "turn_start" });
	assistant([{ type: "text", text: "Found it: the parser lives in src/parse.ts." }], {
		usage: { input: 200, output: 50, cacheRead: 0, cacheWrite: 0 },
	});
	if (script === "silent-last") assistant([{ type: "toolCall", name: "ls" }], { stopReason: "toolUse" });
	if (script === "error-last") assistant([], { stopReason: "error", errorMessage: "529 overloaded" });
	emit({ type: "agent_end", messages: [], willRetry: false });
	emit({ type: "agent_settled" });
	// The extension in a real child calls ctx.shutdown() once it has settled.
	setTimeout(() => process.exit(0), 20);
}

createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	if (command.type === "abort") process.exit(0);
	const data = command.type === "get_state" ? { model: { contextWindow: 1000 } } : {};
	emit({ type: "response", command: command.type, success: true, id: command.id, data });
	if (command.type === "prompt" && script === "inspect") {
		emit({ type: "agent_start" });
		assistant([{ type: "text", text: JSON.stringify({ task: command.message, args: process.argv.slice(2), tools: process.env.PI_TASKFORCE_TOOLS ?? null, forkPath: process.env.PI_TASKFORCE_FORK_PATH ?? null }) }]);
		emit({ type: "agent_end", messages: [], willRetry: false });
		emit({ type: "agent_settled" });
		setTimeout(() => process.exit(0), 20);
	} else if (command.type === "prompt" && script !== "hang") run();
});
