/** §4. Where a session's TODO lists live. */

import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** pi's own session folder name for a project path (`--home-u-dev-x--`). */
export function encodeProject(cwd: string): string {
	return `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/** The session a directory belongs to: its transcript file, or its id when it has none. */
export interface SessionRef {
	file: string | null | undefined;
	id: string;
}

/**
 * pi's own name for a session, its transcript file without `.jsonl`
 * (`<timestamp>_<id>`). A session that is not saved to disk has only its id.
 */
export function sessionKey(session: SessionRef): string {
	return session.file ? basename(session.file, ".jsonl") : session.id;
}

/**
 * `<base>/<project>/<session>`. The base is the `todos.dir` setting when set,
 * and otherwise `todos` inside pi's agent directory.
 */
export function todoDir(cwd: string, agentDir: string, configured: string, session: SessionRef): string {
	const base = configured.trim()
		? expandHome(configured.trim())
		: join(agentDir, "todos");
	return join(base, encodeProject(cwd), sessionKey(session));
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}
