/**
 * §5. Watches the session's TODO directory and keeps a summary of every list in
 * it. It reads whatever is on disk, so it sees changes from any writer: the
 * agent's tools, a shell command, the user's editor or a sync.
 */

import { constants, copyFileSync, type FSWatcher, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, watch } from "node:fs";
import { basename, join } from "node:path";

import { isOpen, parseTodo, type TodoSummary } from "./parse.js";

export interface TodoFile extends TodoSummary {
	path: string;
	name: string;
	mtimeMs: number;
}

const DEBOUNCE_MS = 150;

export class TodoWatcher {
	private watcher: FSWatcher | null = null;
	private timer: NodeJS.Timeout | null = null;
	private current: TodoFile[] = [];
	private watched: string | null = null;

	constructor(private readonly onChange: () => void) {}

	/** The directory being watched, known once the session has started. */
	get dir(): string | null {
		return this.watched;
	}

	get files(): readonly TodoFile[] {
		return this.current;
	}

	/** Creates the directory, reads it once, and starts watching it in place of any earlier one. */
	start(dir: string): void {
		this.stop();
		this.watched = dir;
		try {
			mkdirSync(dir, { recursive: true });
		} catch {
			// A directory that cannot be created is simply empty.
		}
		this.current = readTodoDir(dir);
		try {
			this.watcher = watch(dir, () => this.schedule());
			this.watcher.on("error", () => this.stopWatching());
		} catch {
			this.watcher = null;
		}
	}

	/** Re-reads now, for a caller that needs the latest state. */
	refresh(): readonly TodoFile[] {
		if (this.watched) this.current = readTodoDir(this.watched);
		return this.current;
	}

	stop(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.stopWatching();
	}

	private stopWatching(): void {
		try {
			this.watcher?.close();
		} catch {
			// Already closed.
		}
		this.watcher = null;
	}

	private schedule(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => {
			this.timer = null;
			if (!this.watched) return;
			this.current = readTodoDir(this.watched);
			this.onChange();
		}, DEBOUNCE_MS);
		this.timer.unref?.();
	}
}

/** Every visible `*.md` file in the directory, most recently changed first. */
export function readTodoDir(dir: string): TodoFile[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const files: TodoFile[] = [];
	for (const name of names) {
		if (name.startsWith(".") || !name.endsWith(".md")) continue;
		const path = join(dir, name);
		try {
			const stat = statSync(path);
			if (!stat.isFile()) continue;
			const summary = parseTodo(readFileSync(path, "utf8"), basename(name, ".md"));
			files.push({ ...summary, path, name, mtimeMs: stat.mtimeMs });
		} catch {
			// A file that vanished between the listing and the read is skipped.
		}
	}
	return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * §4. `/new keep`: copies the open lists of one session into another. The copies
 * are independent files, and keep their names and their change times, so they
 * sort as they did. A name already in the target is left alone. Returns the
 * names copied.
 */
export function copyOpenLists(from: string, to: string): string[] {
	const open = readTodoDir(from).filter(isOpen);
	if (open.length === 0) return [];
	mkdirSync(to, { recursive: true });
	const copied: string[] = [];
	for (const file of open) {
		const target = join(to, file.name);
		try {
			copyFileSync(file.path, target, constants.COPYFILE_EXCL);
			const seconds = file.mtimeMs / 1000;
			utimesSync(target, seconds, seconds);
			copied.push(file.name);
		} catch {
			// A name the target already has, or a file that vanished, is skipped.
		}
	}
	return copied;
}
