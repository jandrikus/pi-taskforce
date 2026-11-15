/**
 * §6. Which model a child runs on.
 *
 * A definition's `model` is matched exactly as `provider/id` against pi's model
 * registry, never fuzzily: a near miss must not quietly land on another provider
 * or another model. A model that is unknown or has no credentials is reported at
 * session start, and a child of that type runs on its parent's model instead.
 */

import type { ThinkingLevel } from "./definitions.js";

/** The slice of pi's model registry this needs, so tests can stand one in. */
export interface ModelLookup {
	getAll(): Array<{ provider: string; id: string }>;
	hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}

export interface ModelChoice {
	provider: string;
	id: string;
}

export type ModelCheck = { ok: true; model: ModelChoice } | { ok: false; problem: string };

/** The parent's own model and thinking level at the moment of the spawn. */
export interface ParentModel {
	model: ModelChoice | null;
	thinking: ThinkingLevel | null;
}

export function checkModel(reference: string, registry: ModelLookup): ModelCheck {
	const text = reference.trim();
	const model = registry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === text);
	if (!model) {
		const hint = text.includes("/") ? "" : " It must be written as `provider/id`.";
		return {
			ok: false,
			problem: `model \`${text}\` is not in pi's model list.${hint} Check it with \`pi --list-models\`.`,
		};
	}
	if (!registry.hasConfiguredAuth(model)) {
		return { ok: false, problem: `model \`${text}\` has no credentials for provider \`${model.provider}\`.` };
	}
	return { ok: true, model: { provider: model.provider, id: model.id } };
}

/** One line per definition whose pinned model would not be used. */
export function modelProblems(
	definitions: Iterable<{ name: string; model: string | null; path: string }>,
	registry: ModelLookup,
): string[] {
	const out: string[] = [];
	for (const definition of definitions) {
		if (!definition.model) continue;
		const check = checkModel(definition.model, registry);
		if (!check.ok) out.push(`${definition.name} (${definition.path}): ${check.problem}`);
	}
	return out;
}

/**
 * The model and thinking level a non-forked child is launched with. A valid
 * pinned model wins; otherwise the parent's. An explicit thinking level wins;
 * otherwise the parent's.
 */
export function chooseLaunchModel(
	pinned: string | null,
	thinking: ThinkingLevel | null,
	parent: ParentModel,
	registry: ModelLookup | null,
): { model: ModelChoice | null; thinking: ThinkingLevel | null } {
	let model = parent.model;
	if (pinned && registry) {
		const check = checkModel(pinned, registry);
		if (check.ok) model = check.model;
	}
	return { model, thinking: thinking ?? parent.thinking };
}
