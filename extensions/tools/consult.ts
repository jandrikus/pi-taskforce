import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const CONSULT_PREFIX = "pi-taskforce:consult:v1:";
export const CONSULT_ENV = "PI_TASKFORCE_CONSULT";
export function isWorker(type: string | null): boolean {
	return type === "worker" || type === "worker-sol";
}

export function registerConsult(pi: ExtensionAPI): void {
	if (process.env[CONSULT_ENV] !== "1") return;
	pi.registerTool({
		name: "consultAdvisor", label: "Consult design advisor",
		description: "Ask the design advisor assigned by your lead. This call returns its reply.",
		parameters: Type.Object({ question: Type.String({ minLength: 1, maxLength: 16000 }) }, { additionalProperties: false }),
		async execute(_id, { question }, signal, _update, ctx) {
			if (ctx.mode !== "rpc") throw new Error("Consultation needs the parent RPC connection.");
			const reply = await ctx.ui.input(CONSULT_PREFIX + question, undefined, { signal });
			if (reply === undefined) throw new Error("Consultation cancelled or unavailable.");
			return { content: [{ type: "text", text: reply }], details: {} };
		},
	});
}
