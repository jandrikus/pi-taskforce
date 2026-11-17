/**
 * Second real process: opens the persisted root session, loads the real
 * extension and a synthetic provider, answers the recovered ask, and exits only
 * after the model request contains that answer as the original tool result.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const cwd = process.argv[2]!;
const sessions = join(cwd, "sessions");
const file = join(sessions, readdirSync(sessions).find((name) => name.endsWith(".jsonl"))!);
const extension = fileURLToPath(new URL("../../extensions/index.ts", import.meta.url));
const probe = fileURLToPath(new URL("./ask-probe.ts", import.meta.url));
const model = {
	id: "fake-1",
	name: "Fake 1",
	provider: "synthetic",
	api: "probe-api",
	baseUrl: "http://127.0.0.1:9/unused",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4096,
} as any;
const settings = SettingsManager.inMemory({ compaction: { enabled: false } } as any);
const loader = new DefaultResourceLoader({
	cwd,
	agentDir: `${cwd}/agent`,
	additionalExtensionPaths: [extension, probe],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
	settingsManager: settings,
} as any);
await loader.reload();
const sm = SessionManager.open(file, sessions);
const { session } = await createAgentSession({
	cwd,
	agentDir: `${cwd}/agent`,
	model,
	thinkingLevel: "off",
	resourceLoader: loader,
	sessionManager: sm,
	noTools: "all",
	settingsManager: settings,
} as any);
await session.bindExtensions({ mode: "print", onError: (error: unknown) => process.stderr.write(`${String(error)}\n`) });
const state = (globalThis as any).__taskforceAskProbe;
const started = Date.now();
while (state.requests.length === 0 || !sm.getBranch().some((entry: any) => entry.customType === "pi-taskforce-ask-done")) {
	if (Date.now() - started > 10_000) {
		process.stderr.write("restart run timed out waiting for the continuation\n");
		process.exit(1);
	}
	await new Promise((resolve) => setTimeout(resolve, 20));
}
session.dispose();
process.exit(0);
