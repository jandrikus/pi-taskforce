/** §7. One delegation tool. Agent types select defaults, not different call arguments. */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { delegationProblem, THINKING_LEVELS, type ThinkingLevel } from "../agents/definitions.js";
import type { Orchestration } from "../agents/orchestration.js";
import type { Taskforce } from "../runtime.js";

export interface SpawnRegistration {
	/** Types described in this agent's prompt, inherited verbatim by forked children. */
	allowed: (name: string) => boolean;
	/** False for an isolated agent without spawning capability. */
	registerRoster: boolean;
}

export function registerSpawnTools(
	pi: ExtensionAPI,
	tf: Taskforce,
	orchestration: Orchestration,
	registration: SpawnRegistration,
): void {
	if (!registration.registerRoster) return;

	const available = [...tf.catalog.byName.values()].filter((definition) => registration.allowed(definition.name));
	const types = available.map((definition) =>
		`${definition.name}: ${(definition.promptSnippet ?? definition.label).replace(/\s+/g, " ")}`,
	);
	pi.registerTool({
		name: "delegate",
		label: "Delegate",
		description:
			"Delegate a complete, self-contained goal to a separate subagent. Type selects its model, tools, " +
			"instructions and defaults. Unless forked, it knows only what the goal tells it. Its final message " +
			"is its report.\n\n" +
			`Available types: ${types.length > 0 ? types.join("; ") : "none"}.`,
		promptSnippet: available.length > 0 ? "Delegate a self-contained goal to a typed subagent" : undefined,
		parameters: Type.Object({
			type: Type.Optional(Type.String({ default: "general", description: "Agent type. Default general" })),
			goal: Type.String({ minLength: 1, description: "Complete goal, context, constraints and how to verify the result" }),
			background: Type.Optional(Type.Boolean({ description: "Override the type's default. false waits for its report; true returns immediately" })),
			fork: Type.Optional(Type.Boolean({ description: "Override the type's default. true copies your conversation into the child" })),
			thinking: Type.Optional(StringEnum(THINKING_LEVELS, {
				description: "Override the type's default thinking level",
			})),
		}, { additionalProperties: false }),
		async execute(_id, params, signal) {
			const refuse = (body: string) => ({
				content: [{ type: "text" as const, text: body }], details: { refused: true },
			});
			const type = params.type ?? "general";
			const definition = tf.catalog.byName.get(type);
			if (!definition) {
				return refuse(`Unknown or disabled agent type \`${type}\`. Available types: ${[...tf.catalog.byName.keys()].join(", ") || "none"}.`);
			}
			if (typeof params.goal !== "string" || params.goal.trim().length === 0) {
				return refuse("delegate needs a non-empty goal describing the complete task.");
			}
			const problem = delegationProblem(definition);
			if (problem) return refuse(problem);
			const controls = {
				fork: params.fork ?? definition.fork,
				background: params.background ?? definition.background,
				// pi-ai's StringEnum is typed against pi-schema, which typebox's Static
				// does not read, so the enum arrives here as `{}`. The schema still
				// restricts it to THINKING_LEVELS.
				thinking: (params.thinking as ThinkingLevel | undefined) ?? definition.thinking,
			};
			const body = await orchestration.spawn(definition, params.goal, controls, signal);
			return { content: [{ type: "text" as const, text: body }], details: {} };
		},
	});
}
