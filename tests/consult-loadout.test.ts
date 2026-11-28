import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { ENV } from "../extensions/agents/env.js";
import { CONSULT_ENV, CONSULT_PREFIX } from "../extensions/tools/consult.js";

afterEach(() => vi.unstubAllEnvs());

it.each(["worker", "worker-sol"])('loads consultation without delegation or extra extensions for %s', async type => {
	vi.stubEnv(ENV.agentId, "direct-worker");
	vi.stubEnv(ENV.parentId, "lead");
	vi.stubEnv(ENV.agentType, type);
	vi.stubEnv(ENV.spawnable, "[]");
	vi.stubEnv(CONSULT_ENV, "1");
	const loader = new DefaultResourceLoader({
		cwd: "/tmp", agentDir: "/tmp/taskforce-consult-loadout", settingsManager: SettingsManager.inMemory(),
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/index.ts", import.meta.url))],
	});
	await loader.reload();
	const { errors, extensions } = loader.getExtensions();
	expect(errors).toEqual([]);
	const tools = extensions.flatMap(ext => [...ext.tools.values()].map(t => t.definition));
	expect(tools.some(t => t.name === "delegate")).toBe(false);
	const consult = tools.find(t => t.name === "consultAdvisor")!;
	const input = vi.fn(async () => "Use tabs");
	const result = await consult.execute("c1", { question: "Which layout?" }, undefined, undefined, { mode: "rpc", ui: { input } } as never);
	expect(input).toHaveBeenCalledWith(CONSULT_PREFIX + "Which layout?", undefined, { signal: undefined });
	expect(result.content).toEqual([{ type: "text", text: "Use tabs" }]);
});
