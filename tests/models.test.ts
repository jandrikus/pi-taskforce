import { describe, expect, it } from "vitest";

import { checkModel, chooseLaunchModel, type ModelLookup, modelProblems } from "../extensions/agents/models.js";

const registry: ModelLookup = {
	getAll: () => [
		{ provider: "deepseek", id: "deepseek-flash" },
		{ provider: "openrouter", id: "deepseek/deepseek-v4-flash-vision-exp" },
		{ provider: "openai", id: "gpt-6.1-terra" },
		{ provider: "anthropic", id: "claude-opus-5-5" },
	],
	hasConfiguredAuth: (model) => model.provider !== "anthropic",
};

const parent = { model: { provider: "claude-code", id: "claude-opus-5-5" }, thinking: "low" as const };

describe("§6 a pinned model is matched exactly", () => {
	it("accepts an exact provider/id with credentials", () => {
		expect(checkModel("openai/gpt-6.1-terra", registry)).toEqual({
			ok: true, model: { provider: "openai", id: "gpt-6.1-terra" },
		});
	});

	it("does not read a provider-looking prefix as a different provider's id", () => {
		// The old fuzzy path resolved this to openrouter, which nobody asked for.
		const check = checkModel("deepseek/deepseek-v4-flash-vision-exp", registry);
		expect(check.ok).toBe(false);
	});

	it("refuses a bare id, a near miss and a model without credentials", () => {
		expect(checkModel("gpt-6.1-terra", registry)).toMatchObject({ ok: false, problem: /provider\/id/ });
		expect(checkModel("openai/gpt-6.1", registry).ok).toBe(false);
		expect(checkModel("anthropic/claude-opus-5-5", registry)).toMatchObject({ ok: false, problem: /credentials/ });
	});

	it("lists only the definitions whose pinned model will not be used", () => {
		const problems = modelProblems([
			{ name: "general", model: null, path: "/a/general.yml" },
			{ name: "reviewer", model: "openai/gpt-6.1-terra", path: "/a/reviewer.yml" },
			{ name: "scout", model: "deepseek/deepseek-v4-flash-vision-exp", path: "/a/scout.yml" },
		], registry);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toMatch(/^scout \(\/a\/scout\.yml\): model `deepseek\/deepseek-v4-flash-vision-exp`/);
	});
});

describe("§6 what a child is launched with", () => {
	it("uses a valid pinned model with the type's own thinking", () => {
		expect(chooseLaunchModel("openai/gpt-6.1-terra", "xhigh", parent, registry)).toEqual({
			model: { provider: "openai", id: "gpt-6.1-terra" }, thinking: "xhigh",
		});
	});

	it("falls back to the parent's model, never to a fuzzy match", () => {
		expect(chooseLaunchModel("deepseek/deepseek-v4-flash-vision-exp", "off", parent, registry)).toEqual({
			model: parent.model, thinking: "off",
		});
	});

	it("inherits the parent's model and thinking when the type sets neither", () => {
		expect(chooseLaunchModel(null, null, parent, registry)).toEqual(parent);
	});
});
