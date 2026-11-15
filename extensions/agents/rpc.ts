/**
 * §8. A subagent is a real `pi` process, started by its parent's process and
 * driven over its standard input and output in pi's rpc mode: a persistent
 * process taking commands as JSON lines, answering with responses and a stream
 * of events.
 *
 * This file is the transport only. What the events mean to a run is §8's
 * business and lives in `child.ts`.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RpcMessage {
	type: string;
	[key: string]: unknown;
}

export interface RpcResponse extends RpcMessage {
	type: "response";
	command: string;
	success: boolean;
	data?: unknown;
	error?: string;
	id?: string;
}

export type RpcListener = (message: RpcMessage) => void;

export interface RpcProcessOptions {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/**
 * The longest line a child may write. A real event carries at most one message,
 * and a tool result is already truncated by pi; a line past this is a broken or
 * hostile child, and is not buffered without end.
 */
export const MAX_LINE_CHARS = 32 * 1024 * 1024;

/**
 * Strict JSONL: LF is the only record delimiter, and a trailing CR is stripped.
 * Node's `readline` also splits on U+2028 and U+2029, which are valid inside a
 * JSON string, so it is not usable here.
 */
export function attachJsonlReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
	onOverflow: () => void = () => {},
	maxLineChars = MAX_LINE_CHARS,
): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let overflowed = false;
	const overflow = (): void => {
		overflowed = true;
		buffer = "";
		onOverflow();
	};
	stream.on("data", (chunk: Buffer | string) => {
		if (overflowed) return;
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline === -1) break;
			// A whole line arriving in one chunk is held to the cap as much as one
			// still being buffered.
			if (newline > maxLineChars) return overflow();
			let line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) onLine(line);
		}
		if (buffer.length > maxLineChars) overflow();
	});
	stream.on("end", () => {
		if (overflowed) return;
		buffer += decoder.end();
		const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
		if (line.length > 0) onLine(line);
	});
}

export class RpcProcess {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly listeners = new Set<RpcListener>();
	private readonly pending = new Map<string, (response: RpcResponse) => void>();
	private nextId = 1;
	private exited = false;
	private exitReason: { code: number | null; signal: NodeJS.Signals | null } | null = null;
	private readonly exitWaiters: Array<() => void> = [];
	/** Whatever the child wrote to stderr, kept for the failure report (§8). */
	private stderr = "";

	constructor(options: RpcProcessOptions) {
		this.child = spawn(options.command, options.args, {
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		attachJsonlReader(
			this.child.stdout,
			(line) => this.dispatch(line),
			() => {
				this.stderr = `${this.stderr}\nthe subagent wrote a line longer than ${MAX_LINE_CHARS} characters and was stopped`.slice(-8000);
				this.child.kill("SIGKILL");
			},
		);
		// A pipe error is the child going away; the exit event reports it.
		this.child.stdout.on("error", () => {});
		this.child.stdin.on("error", () => {});

		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000);
		});

		this.child.on("exit", (code, signal) => {
			this.exited = true;
			this.exitReason = { code, signal };
			for (const [, resolve] of this.pending) {
				resolve({ type: "response", command: "unknown", success: false, error: "the child exited" });
			}
			this.pending.clear();
			for (const waiter of this.exitWaiters.splice(0)) waiter();
		});
		this.child.on("error", (error) => {
			this.stderr = `${this.stderr}\n${error.message}`.slice(-8000);
		});
	}

	/** One line off the child's output. Anything that is not a typed JSON object is dropped. */
	private dispatch(line: string): void {
		let message: RpcMessage;
		try {
			message = JSON.parse(line) as RpcMessage;
		} catch {
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message) || typeof message.type !== "string") {
			return;
		}
		if (message.type === "response") {
			const response = message as RpcResponse;
			const id = typeof response.id === "string" ? response.id : null;
			if (id) {
				const resolve = this.pending.get(id);
				if (resolve) {
					this.pending.delete(id);
					resolve(response);
				}
			}
		}
		for (const listener of [...this.listeners]) {
			try {
				listener(message);
			} catch {
				// A malformed event is the child's problem, never a crash of this process.
			}
		}
	}

	get pid(): number | undefined {
		return this.child.pid;
	}

	get isRunning(): boolean {
		return !this.exited;
	}

	get stderrTail(): string {
		return this.stderr.trim();
	}

	get exitInfo(): { code: number | null; signal: NodeJS.Signals | null } | null {
		return this.exitReason;
	}

	on(listener: RpcListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Fire and forget. Used for responses to the child's own requests. */
	write(message: Record<string, unknown>): void {
		if (this.exited) return;
		try {
			this.child.stdin.write(`${JSON.stringify(message)}\n`);
		} catch {
			// The child is going away; the caller finds out through the exit event.
		}
	}

	/** Sends a command and waits for the response carrying the same id. */
	send(command: Record<string, unknown>, timeoutMs = 30_000): Promise<RpcResponse> {
		if (this.exited) {
			return Promise.resolve({
				type: "response",
				command: String(command.type ?? "unknown"),
				success: false,
				error: "the child is not running",
			});
		}
		const id = `tf-${this.nextId++}`;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({
					type: "response",
					command: String(command.type ?? "unknown"),
					success: false,
					error: "the child did not answer in time",
				});
			}, timeoutMs);
			this.pending.set(id, (response) => {
				clearTimeout(timer);
				resolve(response);
			});
			this.write({ ...command, id });
		});
	}

	/** §8. Stopping is cooperative first, and signals are only an escalation. */
	async stop(graceMs = 5_000): Promise<void> {
		if (this.exited) return;
		this.write({ type: "abort" });
		try {
			this.child.stdin.end();
		} catch {
			// Already closed.
		}
		const exited = await this.waitForExit(graceMs);
		if (exited) return;
		this.child.kill("SIGTERM");
		if (await this.waitForExit(graceMs)) return;
		this.child.kill("SIGKILL");
		await this.waitForExit(graceMs);
	}

	waitForExit(timeoutMs?: number): Promise<boolean> {
		if (this.exited) return Promise.resolve(true);
		return new Promise((resolve) => {
			let done = false;
			const finish = (value: boolean): void => {
				if (done) return;
				done = true;
				resolve(value);
			};
			this.exitWaiters.push(() => finish(true));
			if (timeoutMs !== undefined) setTimeout(() => finish(this.exited), timeoutMs);
		});
	}
}
