/**
 * A public test seam for the request boundary: after a recovered child's answer
 * has been queued during `before_agent_start`, make the session file unwritable
 * so Pi's own flush of that queued custom message fails.
 */
import { chmodSync } from "node:fs";

export default function (pi: {
	on(event: "before_agent_start", handler: (event: unknown, ctx: { sessionManager: { getSessionFile(): string | null } }) => void): void;
}) {
	pi.on("before_agent_start", (_event, ctx) => {
		if (process.env.CHILD_APPEND_FAIL !== "1") return;
		const file = ctx.sessionManager.getSessionFile();
		if (file) chmodSync(file, 0o444);
	});
}
