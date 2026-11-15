import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { encodeProject, sessionKey, todoDir } from "../extensions/todos/dir.js";
import { isOpen, parseTodo } from "../extensions/todos/parse.js";
import { copyOpenLists, readTodoDir, TodoWatcher } from "../extensions/todos/watcher.js";
import { listingText, widgetLines } from "../extensions/ui/todos.js";
import { todoBlock } from "../extensions/prompts/index.js";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "taskforce-todos-"));
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("§4 where the lists live", () => {
	it("encodes the project the way pi names its session folders", () => {
		expect(encodeProject("/home/u/dev/x")).toBe("--home-u-dev-x--");
	});

	const session = { file: "/home/u/.pi/agent/sessions/--p-q--/2026-11-08T18-03-03-307Z_01a1.jsonl", id: "01a1" };

	it("names a session's directory the way pi names its transcript", () => {
		expect(sessionKey(session)).toBe("2026-11-08T18-03-03-307Z_01a1");
		expect(sessionKey({ file: undefined, id: "01a1" })).toBe("01a1");
	});

	it("defaults to todos inside the agent directory, and honours a configured base", () => {
		expect(todoDir("/p/q", "/home/u/.pi/agent", "", session)).toBe(
			"/home/u/.pi/agent/todos/--p-q--/2026-11-08T18-03-03-307Z_01a1",
		);
		expect(todoDir("/p/q", "/home/u/.pi/agent", "/sync/todos", session)).toBe(
			"/sync/todos/--p-q--/2026-11-08T18-03-03-307Z_01a1",
		);
	});

	it("gives two sessions of one project two directories", () => {
		const other = { file: "/s/--p-q--/2026-11-08T19-00-00-000Z_01b2.jsonl", id: "01b2" };
		expect(todoDir("/p/q", "/a", "", session)).not.toBe(todoDir("/p/q", "/a", "", other));
	});
});

describe("§5 reading a list", () => {
	it("reads the title, the counts and the first unticked item", () => {
		const summary = parseTodo(
			["# Ship the parser", "", "- [x] read the spec", "* [ ] write the lexer", "  notes here", "1. [X] plan", "+ [ ] tests"].join("\n"),
			"fallback",
		);
		expect(summary).toEqual({
			title: "Ship the parser",
			total: 4,
			done: 2,
			next: "write the lexer",
			items: [
				{ text: "read the spec", done: true },
				{ text: "write the lexer", done: false },
				{ text: "plan", done: true },
				{ text: "tests", done: false },
			],
		});
		expect(isOpen(summary)).toBe(true);
	});

	it("falls back to the file name and ignores items inside code fences", () => {
		const summary = parseTodo(["- [x] done", "```md", "- [ ] example only", "```"].join("\n"), "2026-11-08-x");
		expect(summary).toEqual({ title: "2026-11-08-x", total: 1, done: 1, next: null, items: [{ text: "done", done: true }] });
		expect(isOpen(summary)).toBe(false);
	});

	it("is not fooled by plain list lines or links in brackets", () => {
		expect(parseTodo("- plain\n- [link](x)\n-[ ] no space", "t").total).toBe(0);
	});
});

describe("§5 the directory", () => {
	it("lists visible Markdown files, most recently changed first", () => {
		const dir = tempDir();
		writeFileSync(join(dir, "old.md"), "# Old\n- [ ] a\n");
		writeFileSync(join(dir, "new.md"), "# New\n- [x] a\n");
		writeFileSync(join(dir, ".sync.new.md.tmp"), "- [ ] hidden\n");
		writeFileSync(join(dir, ".hidden.md"), "- [ ] hidden\n");
		writeFileSync(join(dir, "notes.txt"), "- [ ] not markdown\n");
		utimesSync(join(dir, "old.md"), 1000, 1000);
		expect(readTodoDir(dir).map((file) => file.name)).toEqual(["new.md", "old.md"]);
	});

	it("is empty for a directory that does not exist", () => {
		expect(readTodoDir(join(tempDir(), "missing"))).toEqual([]);
	});

	it("creates the directory and sees a change from any writer", async () => {
		const dir = join(tempDir(), "--p--");
		const onChange = vi.fn();
		const watcher = new TodoWatcher(onChange);
		watcher.start(dir);
		try {
			expect(watcher.files).toEqual([]);
			writeFileSync(join(dir, "2026-11-08-a.md"), "# A\n- [ ] first\n");
			await vi.waitFor(() => expect(watcher.files.map((file) => file.title)).toEqual(["A"]), { timeout: 3000 });
			expect(onChange).toHaveBeenCalled();
		} finally {
			watcher.stop();
		}
	});

	it("watches only the latest session's directory after a switch", async () => {
		const base = tempDir();
		const first = join(base, "s1");
		const second = join(base, "s2");
		const watcher = new TodoWatcher(() => {});
		watcher.start(first);
		writeFileSync(join(first, "a.md"), "# A\n- [ ] one\n");
		watcher.refresh();
		expect(watcher.files.map((file) => file.title)).toEqual(["A"]);
		watcher.start(second);
		try {
			expect(watcher.dir).toBe(second);
			expect(watcher.files).toEqual([]);
			writeFileSync(join(first, "b.md"), "# B\n- [ ] one\n");
			writeFileSync(join(second, "c.md"), "# C\n- [ ] one\n");
			await vi.waitFor(() => expect(watcher.files.map((file) => file.title)).toEqual(["C"]), { timeout: 3000 });
		} finally {
			watcher.stop();
		}
	});
});

describe("§4 keeping lists into a new session", () => {
	it("copies the open lists only, with their names and change times", () => {
		const from = tempDir();
		const to = join(tempDir(), "next");
		writeFileSync(join(from, "open.md"), "# Open\n- [x] a\n- [ ] b\n");
		writeFileSync(join(from, "done.md"), "# Done\n- [x] a\n");
		utimesSync(join(from, "open.md"), 1000, 1000);
		expect(copyOpenLists(from, to)).toEqual(["open.md"]);
		expect(readFileSync(join(to, "open.md"), "utf8")).toBe("# Open\n- [x] a\n- [ ] b\n");
		expect(statSync(join(to, "open.md")).mtimeMs).toBe(1_000_000);
		expect(readTodoDir(to).map((file) => file.name)).toEqual(["open.md"]);
	});

	it("leaves the source alone, so the copies change independently", () => {
		const from = tempDir();
		const to = tempDir();
		writeFileSync(join(from, "l.md"), "- [ ] a\n");
		copyOpenLists(from, to);
		writeFileSync(join(to, "l.md"), "- [x] a\n");
		expect(readFileSync(join(from, "l.md"), "utf8")).toBe("- [ ] a\n");
	});

	it("never overwrites a list the target already has", () => {
		const from = tempDir();
		const to = tempDir();
		writeFileSync(join(from, "l.md"), "- [ ] old\n");
		writeFileSync(join(to, "l.md"), "- [ ] mine\n");
		expect(copyOpenLists(from, to)).toEqual([]);
		expect(readFileSync(join(to, "l.md"), "utf8")).toBe("- [ ] mine\n");
	});

	it("does nothing, and creates nothing, when there is nothing open", () => {
		const from = tempDir();
		mkdirSync(join(from, "sub"));
		const to = join(tempDir(), "never");
		expect(copyOpenLists(from, to)).toEqual([]);
		expect(readTodoDir(to)).toEqual([]);
		expect(copyOpenLists(join(from, "missing"), to)).toEqual([]);
	});
});

describe("§5 what the user sees", () => {
	const file = (title: string, done: number, total: number, next: string | null) => ({
		title, done, total, next, items: [], path: `/d/${title}.md`, name: `${title}.md`, mtimeMs: 0,
	});

	it("shows at most three open lists and counts the rest", () => {
		const open = ["a", "b", "c", "d", "e"].map((title) => file(title, 1, 3, "next"));
		expect(widgetLines(open)).toEqual(["a 1/3 · next", "b 1/3 · next", "c 1/3 · next", "+2 more open"]);
	});

	it("prints open lists before finished ones", () => {
		const text = listingText("/d", [file("done", 2, 2, null), file("open", 0, 1, "go")]);
		expect(text.indexOf("open")).toBeLessThan(text.indexOf("done"));
		expect(listingText("/d", [])).toMatch(/No TODO lists yet/);
	});
});

describe("§5 what the agent reads", () => {
	it("names the directory and the convention, and never a file", () => {
		const block = todoBlock("/home/u/.pi/agent/todos/--p--");
		expect(block).toContain("/home/u/.pi/agent/todos/--p--/");
		expect(block).toContain("YYYY-MM-DD-<slug>.md");
		expect(block).toContain("- [x]");
	});
});
