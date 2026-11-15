/**
 * The side channel that lets a grandchild's activity reach the root process.
 *
 * A child process only sees its own direct runs. Its parent, however, started
 * it, so the root can pass one unix socket path down through the environment.
 * Every taskforce process below the root writes its direct children's activity
 * there; the root reads it and republishes it under its own session id. The
 * channel carries the same bounded, read-only events as the in-process bus and
 * never a transcript, a control message or a path from a client.
 */

import { chmodSync, mkdtempSync, rmdirSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MAX_LINE = 64 * 1024;
const MAX_QUEUE = 200;
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_BUFFER = 256 * 1024;
const RETRY_MS = 1_000;

/** The socket the root listens on, or null where unix sockets do not exist. */
export function observeSocketPath(): string | null {
	if (process.platform === "win32") return null;
	const uid = typeof process.getuid === "function" ? process.getuid() : 0;
	let dir: string;
	try {
		// A fresh 0700 directory owned by this process, so another user cannot
		// pre-create the path and receive nested activity.
		dir = mkdtempSync(join(tmpdir(), `pi-taskforce-${uid}-`));
	} catch {
		return null;
	}
	return join(dir, "observe.sock");
}

type Listener = (payload: unknown) => void;

export class ObserveChannel {
	private server: net.Server | null = null;
	private sockets = new Set<net.Socket>();
	private listener: Listener | null = null;
	private closed = false;

	constructor(readonly path: string, private readonly ownsDirectory = false) {}

	/** Start listening; a failure (another process owns the path) stays silent. */
	listen(listener: Listener): void {
		if (this.server || this.closed) return;
		this.listener = listener;
		try {
			rmSync(this.path, { force: true });
		} catch {
			// A stale socket is not fatal: listen reports the real problem.
		}
		try {
			const server = net.createServer((sock) => this.accept(sock));
			server.on("error", () => {});
			server.listen(this.path, () => {
				try {
					chmodSync(this.path, 0o600);
				} catch {
					// Best effort; the directory is already private.
				}
			});
			this.server = server;
			server.unref?.();
		} catch {
			this.server = null;
		}
	}

	private accept(sock: net.Socket): void {
		this.sockets.add(sock);
		sock.setEncoding("utf8");
		let buffer = "";
		sock.on("data", (chunk: string) => {
			buffer += chunk;
			if (buffer.length > MAX_LINE * 4) {
				buffer = "";
				return;
			}
			let at = buffer.indexOf("\n");
			while (at >= 0) {
				const line = buffer.slice(0, at);
				buffer = buffer.slice(at + 1);
				if (line.length > 0 && line.length <= MAX_LINE) {
					let payload: unknown;
					try {
						payload = JSON.parse(line);
					} catch {
						payload = null;
					}
					if (payload && this.listener) {
						try {
							this.listener(payload);
						} catch {
							// One bad line does not end the channel.
						}
					}
				}
				at = buffer.indexOf("\n");
			}
		});
		sock.on("close", () => this.sockets.delete(sock));
		sock.on("error", () => this.sockets.delete(sock));
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const sock of this.sockets) sock.destroy();
		this.sockets.clear();
		this.server?.close();
		this.server = null;
		this.listener = null;
		try {
			rmSync(this.path, { force: true });
		} catch {
			// Already removed.
		}
		if (this.ownsDirectory) {
			try {
				// Only remove our own empty directory, never caller-owned paths
				// or unexpected files left alongside the socket.
				rmdirSync(dirname(this.path));
			} catch {
				// Already removed, not empty, or no longer accessible.
			}
		}
	}
}

/**
 * A child's write side. It reconnects on its own, drops rather than grows
 * without bound, and never blocks the child's run.
 */
export class ObserveClient {
	private sock: net.Socket | null = null;
	private queue: string[] = [];
	private queuedBytes = 0;
	private blocked = false;
	private timer: NodeJS.Timeout | null = null;
	private closed = false;
	private connecting = false;

	constructor(readonly path: string) {}

	/** Diagnostics for the bounded-writer regression; they never grow unbounded. */
	get pendingCount(): number {
		return this.queue.length;
	}

	get pendingBytes(): number {
		return this.queuedBytes + (this.sock?.writableLength ?? 0);
	}

	send(payload: unknown): void {
		if (this.closed) return;
		let line: string;
		try {
			line = JSON.stringify(payload);
		} catch {
			return;
		}
		if (line.length > MAX_LINE) return;
		line += "\n";
		if (this.sock?.writable && !this.blocked && this.sock.writableLength < MAX_BUFFER) {
			this.write(line);
			return;
		}
		this.enqueue(line);
		if (!this.sock) this.connect();
	}

	private write(line: string): void {
		const sock = this.sock;
		if (!sock || !sock.writable) {
			this.enqueue(line);
			return;
		}
		try {
			// A slow reader must not make the child's process grow without
			// bound. Once the socket says false, wait for drain; the queue is
			// capped by bytes and lines, dropping old observations only.
			if (!sock.write(line)) this.blocked = true;
		} catch {
			this.blocked = true;
			this.enqueue(line);
		}
	}

	private enqueue(line: string): void {
		this.queue.push(line);
		this.queuedBytes += line.length;
		while (this.queue.length > MAX_QUEUE || this.queuedBytes > MAX_QUEUED_BYTES) {
			const dropped = this.queue.shift();
			if (dropped === undefined) break;
			this.queuedBytes -= dropped.length;
		}
	}

	private flush(): void {
		const sock = this.sock;
		if (!sock || !sock.writable || this.blocked) return;
		while (this.queue.length > 0 && sock.writableLength < MAX_BUFFER) {
			const line = this.queue.shift();
			if (line === undefined) break;
			this.queuedBytes -= line.length;
			try {
				if (!sock.write(line)) {
					this.blocked = true;
					return;
				}
			} catch {
				this.blocked = true;
				return;
			}
		}
	}

	private connect(): void {
		if (this.connecting || this.closed || this.sock) return;
		this.connecting = true;
		let sock: net.Socket;
		try {
			sock = net.connect(this.path);
		} catch {
			this.connecting = false;
			this.later();
			return;
		}
		sock.unref?.();
		sock.on("connect", () => {
			this.connecting = false;
			this.sock = sock;
			this.blocked = false;
			this.flush();
		});
		sock.on("drain", () => {
			this.blocked = false;
			this.flush();
		});
		sock.on("error", () => {
			// The root may not be listening yet; retry with the next event.
		});
		sock.on("close", () => {
			this.connecting = false;
			if (this.sock === sock) this.sock = null;
			this.blocked = false;
			this.later();
		});
	}

	private later(): void {
		if (this.closed || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			if (this.queue.length > 0) this.connect();
		}, RETRY_MS);
		this.timer.unref?.();
	}

	close(): void {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.queue = [];
		this.queuedBytes = 0;
		this.sock?.destroy();
		this.sock = null;
	}
}
