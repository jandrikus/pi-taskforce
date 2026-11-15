/**
 * The root session's cost surface: a cached monitor, the `Total incl. agents`
 * status line, and the `/cost` page. Only root sessions show it: a child's
 * transcript is already part of its root's total.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { costStatusText, STATUS_KEY } from "./format.js";
import { CostMonitor, type CostMonitorOptions } from "./monitor.js";
import { openCosts } from "../ui/costs.js";

export interface CostFeatureOptions {
	getLive: () => boolean;
	read?: CostMonitorOptions["read"];
	pollMs?: number;
}

export class CostFeature {
	readonly monitor: CostMonitor;
	private ctx: ExtensionContext | null = null;

	constructor(options: CostFeatureOptions) {
		this.monitor = new CostMonitor({
			getLive: options.getLive,
			read: options.read,
			pollMs: options.pollMs,
			onState: () => this.refreshStatus(),
		});
	}

	register(pi: ExtensionAPI): void {
		const handler = async (_args: string, ctx: ExtensionContext): Promise<void> => {
			this.ctx = ctx;
			this.monitor.refresh();
			await openCosts(this.monitor, ctx);
			this.refreshStatus();
		};
		pi.registerCommand("cost", {
			description: "Show session costs including subagents",
			handler,
		});
		pi.registerCommand("costs", {
			description: "Show session costs including subagents (alias of /cost)",
			handler,
		});
	}

	/** Called on every session start, including a switch or a fork. */
	bind(ctx: ExtensionContext): void {
		this.ctx = ctx;
		this.monitor.bind(ctx.sessionManager.getSessionFile() ?? null);
		this.refreshStatus();
	}

	/** A run update, a child finishing, or a turn boundary. */
	refresh(): void {
		this.monitor.refresh();
	}

	dispose(): void {
		this.monitor.dispose();
		try {
			this.ctx?.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// The surface is already gone.
		}
		this.ctx = null;
	}

	private refreshStatus(): void {
		if (!this.ctx?.hasUI) return;
		try {
			this.ctx.ui.setStatus(STATUS_KEY, costStatusText(this.monitor.view()));
		} catch {
			this.ctx = null;
		}
	}
}
