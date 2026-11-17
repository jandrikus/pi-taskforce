import { describe, expect, it } from "vitest";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";

import { CANCEL_ARM_MS, INPUT_GRACE_MS, createAskOverlay } from "../extensions/ask/overlay.js";
import { validateAsk } from "../extensions/ask/schema.js";
import type { AskResult } from "../extensions/ask/schema.js";

const plain = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const SEND = "\x1b[13;5u";
const KEY = {
	enter: "\r",
	esc: "\x1b",
	tab: "\t",
	shiftTab: "\x1b[Z",
	up: "\x1b[A",
	down: "\x1b[B",
	right: "\x1b[C",
	space: " ",
	backspace: "\x7f",
	ctrlN: "\x0e",
};

/** An overlay over a stub terminal, with a clock the test moves. */
function open(questions: unknown, options: { context?: string; graceMs?: number } = {}) {
	const checked = validateAsk(options.context ?? null, questions);
	if (!checked.ok) throw new Error(checked.message);
	let clock = 10_000;
	const results: AskResult[] = [];
	let hidden = 0;
	const tui = { requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as unknown as TUI;
	const overlay = createAskOverlay({
		envelope: { from: { agentId: "root", agentType: "root", depth: 0 }, asksUserDirectly: true, ask: checked.ask },
		theme: plain,
		tui,
		attribution: null,
		done: (result) => results.push(result),
		hide: () => hidden++,
		graceMs: options.graceMs ?? 0,
		now: () => clock,
	});
	overlay.focused = true;
	const press = (...keys: string[]) => {
		for (const key of keys) overlay.handleInput(key);
	};
	const type = (text: string) => press(...[...text]);
	const screen = () => overlay.render(100).join("\n");
	const result = () => {
		expect(results).toHaveLength(1);
		return results[0]!;
	};
	return {
		press,
		type,
		screen,
		result,
		results,
		hidden: () => hidden,
		tick: (ms: number) => (clock += ms),
	};
}

const db = {
	id: "db",
	prompt: "Which database?",
	label: "Database",
	options: [
		{ value: "pg", label: "PostgreSQL" },
		{ value: "lite", label: "SQLite" },
	],
};
const features = {
	id: "features",
	prompt: "Which features?",
	label: "Features",
	type: "multiselect",
	options: [
		{ value: "auth", label: "Auth" },
		{ value: "billing", label: "Billing" },
		{ value: "search", label: "Search" },
	],
};
const name = { id: "name", prompt: "Project name?", label: "Name" };

describe("§12 the overlay: a text question", () => {
	it("takes typing as soon as it shows, with no row to open first", () => {
		const ui = open([name]);
		ui.type("acme");
		ui.press(KEY.enter);
		expect(ui.result().answers[0]).toMatchObject({ values: ["acme"], typed: true, omitted: false });
	});

	it("keeps digits and n as text instead of reading them as keys", () => {
		const ui = open([name]);
		ui.type("n2 app");
		ui.press(KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["n2 app"]);
	});

	it("skips the question on an empty Enter", () => {
		const ui = open([name]);
		ui.press(KEY.enter);
		expect(ui.result().answers[0]?.omitted).toBe(true);
	});

	it("starts from the default and keeps a revisited answer", () => {
		const ui = open([{ ...name, default: "acme" }, db]);
		ui.press(KEY.enter);
		ui.press(KEY.shiftTab);
		expect(ui.screen()).toContain("acme");
		ui.type("-web");
		ui.press(KEY.enter, "1");
		ui.press(KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["acme-web"]);
	});
});

describe("§12 the overlay: a select", () => {
	it("picks by number and by Enter on the cursor", () => {
		const byNumber = open([db]);
		byNumber.press("2");
		// Picking is not submitting: the explicit send comes after.
		expect(byNumber.results).toHaveLength(0);
		byNumber.press(SEND);
		expect(byNumber.result().answers[0]?.values).toEqual(["lite"]);

		const byEnter = open([db]);
		byEnter.press(KEY.down, KEY.enter);
		expect(byEnter.results).toHaveLength(0);
		byEnter.press(SEND);
		expect(byEnter.result().answers[0]?.values).toEqual(["lite"]);
	});

	it("starts typing an own answer as soon as a letter is pressed", () => {
		const ui = open([db]);
		ui.type("MariaDB");
		// Uncommitted text is still used by an explicit send.
		ui.press(SEND);
		expect(ui.result().answers[0]).toMatchObject({ values: ["MariaDB"], typed: true });
	});

	it("does not let a number land on Skip or Send", () => {
		const ui = open([db]);
		ui.press("4", "5", "6");
		expect(ui.results).toHaveLength(0);
	});

	it("wraps the cursor from the top to Skip", () => {
		const ui = open([db]);
		ui.press(KEY.up, KEY.enter, SEND);
		expect(ui.result().answers[0]?.omitted).toBe(true);
	});

	it("does not offer a typed answer when allowOther is off", () => {
		const ui = open([{ ...db, allowOther: false }]);
		ui.type("x");
		expect(ui.results).toHaveLength(0);
		expect(ui.screen()).not.toContain("own answer");
	});
});

describe("§12 the overlay: a multiselect", () => {
	it("toggles with Space and confirms with Enter, in option order", () => {
		const ui = open([features]);
		ui.press(KEY.down, KEY.down, KEY.space, KEY.up, KEY.up, KEY.space, KEY.enter, SEND);
		expect(ui.result().answers[0]?.values).toEqual(["auth", "search"]);
	});

	it("toggles by number, and unticks on a second press", () => {
		const ui = open([features]);
		ui.press("1", "2", "1", KEY.enter, SEND);
		expect(ui.result().answers[0]?.values).toEqual(["billing"]);
	});

	it("reads Enter with nothing ticked as the option under the cursor", () => {
		const ui = open([features]);
		ui.press(KEY.down, KEY.enter, SEND);
		expect(ui.result().answers[0]?.values).toEqual(["billing"]);
	});

	it("adds typed answers next to the ticked ones and lets them be removed", () => {
		const ui = open([features]);
		ui.press("1");
		ui.type("audit log");
		ui.press(KEY.enter);
		ui.type("sso");
		ui.press(KEY.enter);
		expect(ui.screen()).toContain("audit log");
		ui.press(SEND);
		// An extra added with Enter stays until it is removed on purpose.
		expect(ui.result().answers[0]).toMatchObject({ values: ["auth", "audit log", "sso"], typed: true });
	});

	it("ticks an option when the typed text is its label", () => {
		const ui = open([features]);
		ui.type("search");
		ui.press(KEY.enter, SEND);
		expect(ui.result().answers[0]).toMatchObject({ values: ["search"], typed: false });
	});
});

describe("§12 the overlay: cancelling and stray keys", () => {
	it("needs a second Esc to cancel the whole ask", () => {
		const ui = open([db]);
		ui.press(KEY.esc);
		expect(ui.results).toHaveLength(0);
		expect(ui.screen()).toContain("Esc again");
		ui.press(KEY.esc);
		expect(ui.result().outcome).toBe("cancelled");
	});

	it("disarms the cancel after a pause or another key", () => {
		const ui = open([db]);
		ui.press(KEY.esc);
		ui.tick(CANCEL_ARM_MS + 1);
		ui.press(KEY.esc);
		expect(ui.results).toHaveLength(0);
		ui.press(KEY.down, KEY.esc);
		expect(ui.results).toHaveLength(0);
	});

	it("clears a typed answer on Esc before it cancels anything", () => {
		const ui = open([name]);
		ui.type("oops");
		ui.press(KEY.esc);
		expect(ui.results).toHaveLength(0);
		ui.type("acme");
		ui.press(KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["acme"]);
	});

	it("ignores keys that arrive right as it opens", () => {
		const ui = open([db], { graceMs: INPUT_GRACE_MS });
		ui.press(KEY.enter);
		expect(ui.results).toHaveLength(0);
		ui.tick(INPUT_GRACE_MS);
		ui.press(KEY.enter, SEND);
		expect(ui.result().answers[0]?.values).toEqual(["pg"]);
	});
});

describe("§12 the overlay: several questions", () => {
	it("moves to the next unanswered question, then to review, and submits", () => {
		const ui = open([db, features, name]);
		ui.press("1");
		ui.press("2", KEY.enter);
		ui.type("acme");
		ui.press(KEY.enter);
		expect(ui.screen()).toContain("Submit answers");
		ui.press(KEY.enter);
		const answers = ui.result().answers;
		expect(answers.map((answer) => answer.values)).toEqual([["pg"], ["billing"], ["acme"]]);
	});

	it("goes back to a question it skipped past before review", () => {
		const ui = open([db, features, name]);
		ui.press(KEY.tab, "1", KEY.enter);
		ui.type("acme");
		ui.press(KEY.enter);
		expect(ui.screen()).toContain("Which database?");
	});

	it("opens a question from review and returns there once it is answered", () => {
		const ui = open([db, name]);
		ui.press("1");
		ui.type("acme");
		ui.press(KEY.enter, KEY.up, KEY.up, KEY.enter);
		expect(ui.screen()).toContain("Which database?");
		ui.press("2");
		ui.press(KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["lite"]);
	});

	it("submits unanswered questions as skipped, and says so in review", () => {
		const ui = open([db, name]);
		ui.press(KEY.shiftTab);
		expect(ui.screen()).toContain("not answered, will be skipped");
		ui.press(KEY.enter);
		expect(ui.result().answers.every((answer) => answer.omitted)).toBe(true);
	});

	it("does not switch tabs on arrow keys while a typed answer is being edited", () => {
		const ui = open([db, name]);
		ui.type("ab");
		ui.press("\x1b[D", "X", KEY.enter);
		ui.press(KEY.tab, KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["aXb"]);
	});
});

describe("§12 the overlay: notes", () => {
	it("attaches a note to the question it was written on", () => {
		const ui = open([db, name]);
		ui.press(KEY.ctrlN);
		ui.type("only if it runs on arm64");
		ui.press(KEY.enter, "1");
		ui.press(KEY.enter, KEY.enter);
		const [first, second] = ui.result().answers;
		expect(first).toMatchObject({ values: ["pg"], note: "only if it runs on arm64" });
		expect(second?.note).toBeNull();
	});

	it("discards a note on Esc without cancelling the ask", () => {
		const ui = open([db]);
		ui.press(KEY.ctrlN);
		ui.type("never mind");
		ui.press(KEY.esc, "1", SEND);
		expect(ui.result().answers[0]).toMatchObject({ values: ["pg"], note: null });
	});
});

describe("§12 the overlay: moving between questions", () => {
	const altLeft = "\x1b[1;3D";
	const altRight = "\x1b[1;3C";
	const altDigit = (n: number) => `\x1b[${48 + n};3u`;

	it("steps Back and Next without answering anything", () => {
		const ui = open([db, features, name]);
		ui.press(altRight);
		expect(ui.screen()).toContain("Which features?");
		ui.press(altLeft);
		expect(ui.screen()).toContain("Which database?");
		expect(ui.results).toHaveLength(0);
	});

	it("goes straight to a question by its position", () => {
		const ui = open([db, features, name]);
		ui.press(altDigit(3));
		expect(ui.screen()).toContain("Project name?");
		ui.press(altDigit(2));
		expect(ui.screen()).toContain("Which features?");
		expect(ui.results).toHaveLength(0);
	});

	it("keeps a picked answer when stepping away and back", () => {
		const ui = open([db, features]);
		ui.press("2");
		ui.press(altLeft);
		expect(ui.screen()).toContain("Which database?");
		ui.press(altRight);
		ui.press(KEY.up, KEY.up, KEY.up, KEY.enter, KEY.enter);
		expect(ui.result().answers[0]?.values).toEqual(["lite"]);
	});

	it("counts typed text that was not confirmed yet when submitting explicitly", () => {
		const ui = open([db, features]);
		ui.press("1");
		ui.type("audit log");
		ui.press("\x1b[13;5u");
		expect(ui.result().answers[1]).toMatchObject({ values: ["audit log"], typed: true });
	});

	it("derives every answer from the fields as they stand, not from an earlier pick", () => {
		// select "a", leave, type a custom answer, submit: the custom answer wins.
		const ui = open([db, features]);
		ui.press("1");
		ui.press(altLeft);
		ui.type("custom");
		ui.press("\x1b[13;5u");
		expect(ui.result().answers[0]).toMatchObject({ values: ["custom"], typed: true });
	});

	it("keeps unconfirmed text from earlier text questions", () => {
		const first = { id: "one", prompt: "First?", label: "One" };
		const second = { id: "two", prompt: "Second?", label: "Two" };
		const ui = open([first, second]);
		ui.type("hello");
		ui.press(altRight);
		ui.type("world");
		ui.press("\x1b[13;5u");
		expect(ui.result().answers.map((answer) => answer.values)).toEqual([["hello"], ["world"]]);
		expect(ui.result().answers.every((answer) => !answer.omitted)).toBe(true);
	});

	it("submits only on an explicit submit, never on navigation", () => {
		const ui = open([db, features]);
		ui.press("1");
		ui.press(altLeft, altRight, altLeft, KEY.tab);
		expect(ui.results).toHaveLength(0);
		ui.press("1");
		ui.press("\x1b[13;5u");
		expect(ui.result().answers[0]?.values).toEqual(["pg"]);
	});
});

describe("§12 the overlay: hiding", () => {
	it("hands the terminal back without submitting or cancelling", () => {
		const ui = open([db, name]);
		ui.type("acme");
		ui.press("\x1bh");
		expect(ui.hidden()).toBe(1);
		expect(ui.results).toHaveLength(0);
	});

	it("hides from a question that has no text field, too", () => {
		const ui = open([db]);
		ui.press("\x1bh");
		expect(ui.hidden()).toBe(1);
		expect(ui.results).toHaveLength(0);
	});
});
