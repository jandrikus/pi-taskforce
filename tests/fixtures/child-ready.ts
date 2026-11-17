/** Test observer: proves the child reached before_agent_start with its task prompt. */
import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async () => {
		const path = process.env.CHILD_READY_LOG;
		if (path) appendFileSync(path, "before_agent_start\n");
	});
}
