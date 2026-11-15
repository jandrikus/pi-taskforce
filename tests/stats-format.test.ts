import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { SessionStatsSnapshot, StatsAgent, StatsContext, StatsUsage } from "../extensions/stats/contract.js";
import { statsLines } from "../extensions/stats/format.js";

const plain = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function usage(cost: number): StatsUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost };
}

function unknownContext(): StatsContext {
	return { known: false, tokens: null, contextWindow: null, percent: null, stale: false, source: "none" };
}

function missingAgent(): StatsAgent {
	return {
		uuid: "missing-child",
		parentUuid: "root",
		depth: 2,
		type: "scout",
		status: "unknown",
		statusEvidence: "none",
		storedFailure: false,
		runElapsedMs: null,
		configuredModel: null,
		context: unknownContext(),
		transcript: { available: false, note: "the recorded transcript is not on disk" },
		cost: {
			known: false,
			own: usage(0),
			subtree: usage(0),
			subtreeKnown: false,
			status: "missing",
			note: "the recorded transcript is not on disk",
		},
	};
}

function snapshot(): SessionStatsSnapshot {
	return {
		at: 0,
		session: {
			id: "root",
			file: null,
			cwd: "/work",
			status: "idle",
			model: { known: false, provider: null, id: null },
			context: unknownContext(),
			sessionAgeMs: null,
			lastActivityAt: null,
		},
		costs: {
			available: true,
			total: usage(0),
			own: usage(0),
			descendants: usage(0),
			models: [],
			incomplete: true,
			scanning: false,
			error: null,
			stale: false,
		},
		agents: [missingAgent()],
		todos: [],
		problems: ["Some recorded agents or usage could not be read; the total is the known part only."],
	};
}

describe("stats agent cost text", () => {
	it("shows unknown own cost and marks only the known subtree as partial", () => {
		const text = statsLines(snapshot(), plain).join("\n");
		expect(text).toContain("own unknown");
		expect(text).toContain("subtree $0.000 partial");
		expect(text).not.toContain("own $0.000 partial");
	});
});

describe("stats historical model and context text", () => {
	it("labels the transcript model as last observed and request input as historical", () => {
		const observedAt = Date.now() - 10 * 60_000;
		const base = snapshot();
		const withHistory: SessionStatsSnapshot = {
			...base,
			session: {
				...base.session,
				observedModel: {
					known: true,
					provider: "openai",
					id: "gpt-actual",
					observedAt,
					evidence: "response-model",
					branch: "last-recorded",
				},
				context: {
					known: true,
					tokens: 12_000,
					contextWindow: null,
					percent: null,
					stale: true,
					source: "transcript",
					observedAt,
					measurement: "request-input",
					provenance: "before-compaction",
					requestModel: { known: true, provider: "openai", id: "gpt-requested" },
					branch: "last-recorded",
				},
			},
			agents: [
				{
					...missingAgent(),
					observedModel: {
						known: true,
						provider: "openai",
						id: "gpt-actual",
						observedAt,
						evidence: "message",
						branch: "last-recorded",
					},
					context: {
						known: true,
						tokens: 8_000,
						contextWindow: null,
						percent: null,
						stale: true,
						source: "transcript",
						observedAt,
						measurement: "request-input",
						provenance: "before-context-edit",
						requestModel: { known: true, provider: "openai", id: "gpt-requested" },
						branch: "last-recorded",
					},
				},
			],
		};

		const text = statsLines(withHistory, plain).join("\n");
		expect(text).toContain("model           last observed model openai/gpt-actual last recorded branch 10m ago");
		expect(text).toContain("last measured request input 12k on openai/gpt-requested last recorded branch before compaction 10m ago (historical)");
		expect(text).not.toContain("100%");
		expect(text).toContain("last observed model openai/gpt-actual last recorded branch 10m ago");
		expect(text).toContain("context last measured request input 8k on openai/gpt-requested last recorded branch before context edit 10m ago (historical)");
	});

	it("never presents an absent historical token count as zero", () => {
		const base = snapshot();
		const context: StatsContext = {
			known: true,
			tokens: null,
			contextWindow: null,
			percent: null,
			stale: true,
			source: "transcript",
			measurement: "request-input",
		};
		const text = statsLines({ ...base, session: { ...base.session, context } }, plain).join("\n");
		expect(text).toContain("context         unknown (historical)");
		expect(text).not.toContain("last measured request input 0");
	});
});
