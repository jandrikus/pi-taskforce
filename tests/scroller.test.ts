import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { createScroller } from "../extensions/ui/scroller.js";

const plain = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function fakeTui(rows: number) {
	return {
		terminal: { rows, columns: 80 },
		requestRender: vi.fn(),
	};
}

function page(byTerminalRows: number | undefined) {
	const tui = fakeTui(byTerminalRows ?? 40) as never;
	return createScroller({
		title: "Session stats",
		theme: plain,
		tui,
		body: () => Array.from({ length: 100 }, (_, index) => `line ${index + 1}`),
		help: () => "↑↓ scroll • Esc close",
		maxHeight: byTerminalRows === undefined ? undefined : (rows) => Math.max(1, rows - 6),
		done: () => {},
	});
}

describe("scroller height", () => {
	for (const rows of [20, 40, 45]) {
		it(`fits title, body and hint within ${rows} terminal rows`, () => {
			const lines = page(rows).render(80);
			expect(lines.length).toBeLessThanOrEqual(rows - 6);
			expect(lines[1]).toContain("Session stats");
			expect(lines.some((line) => line.includes("↑↓ scroll • Esc close"))).toBe(true);
			expect(lines.at(-1)).toContain("─");
			expect(lines.some((line) => line.includes("line 1"))).toBe(true);
		});
	}

	it("keeps the old sizing when a caller does not pass maxHeight", () => {
		const lines = page(undefined).render(80);
		expect(lines.length).toBe(40);
		expect(lines.some((line) => line.includes("↑↓ scroll • Esc close"))).toBe(true);
	});
});
