/**
 * A synthetic provider plus a phone stand-in for the end-to-end recovery test.
 * It answers the first recovered ask once and records every model request, so
 * the test can read what the real extension actually sends to a provider.
 */
import { appendFileSync } from "node:fs";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export interface ProbeState {
	requests: Array<{ roles: string[]; messages: any[] }>;
	opens: any[];
	answered: number;
	holdStream?: boolean;
	autoAnswer?: boolean;
	releaseStream?: () => void;
}

const env = process.env;
const state: ProbeState = ((globalThis as any).__taskforceAskProbe ??= {
	requests: [],
	opens: [],
	answered: 0,
	holdStream: env.ASK_PROBE_HOLD === "1",
	autoAnswer: env.ASK_PROBE_AUTO !== "0",
});
const logPath = env.ASK_PROBE_LOG;

export default function (pi: ExtensionAPI) {
	pi.registerProvider("synthetic", {
		name: "Synthetic ask probe",
		apiKey: "probe",
		api: "probe-api",
		baseUrl: "http://127.0.0.1:9/unused",
		models: [
			{
				id: "fake-1",
				name: "Fake 1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4096,
			},
		],
		streamSimple(model: any, context: any) {
			const request = {
				roles: context.messages.map((message: any) => message.role),
				messages: context.messages,
			};
			state.requests.push(request);
			if (logPath) appendFileSync(logPath, `${JSON.stringify(request)}\n`);
			const stream = createAssistantMessageEventStream();
			const summary = env.ASK_PROBE_SUMMARY === "1";
			const text = summary
				? JSON.stringify(context.messages).includes("Android")
					? "The recovered answer was Android."
					: "No recovered answer was present."
				: "continued";
			const final: any = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: final });
			stream.push({ type: "text_start", contentIndex: 0, partial: final });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "continued", partial: final });
			const finish = () => {
				stream.push({ type: "text_end", contentIndex: 0, content: text, partial: final });
				stream.end(final);
			};
			if (state.holdStream && !state.releaseStream) {
				state.releaseStream = finish;
				return stream;
			}
			finish();
			return stream;
		},
	});

	pi.events.on("ask:open", (ask: any) => {
		state.opens.push(ask);
		if (state.autoAnswer === false) return;
		if (state.answered > 0) return;
		state.answered++;
		const question = ask.ask.questions[0];
		setTimeout(() => {
			ask.answer({ answers: [{ id: question.id, values: ["android"] }] });
		}, 0);
	});
}
