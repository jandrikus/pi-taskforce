import { afterEach, describe, expect, it } from "vitest";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObserveClient } from "../extensions/observe/channel.js";

const dirs: string[] = [];
const servers: net.Server[] = [];
const clients: ObserveClient[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const server of servers.splice(0)) {
		(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function path(): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "pilot-observe-test-"));
	dirs.push(dir);
	return join(dir, "observe.sock");
}

describe("ObserveClient backpressure", () => {
	it("bounds its queue when the connected root is not reading", async () => {
		const sock = await path();
		const server = net.createServer((reader) => {
			// Accept, then stop consuming. The kernel and Node buffers fill;
			// the writer must not keep growing its own queue behind them.
			sockets.push(reader);
			reader.pause();
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(sock, resolve));

		const client = new ObserveClient(sock);
		clients.push(client);
		const body = "x".repeat(48 * 1024);
		for (let i = 0; i < 2_000; i++) {
			client.send({ i, body });
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(client.pendingCount).toBeLessThanOrEqual(200);
		expect(client.pendingBytes).toBeLessThan(1024 * 1024);
	});

	it("drops old observations instead of blocking when no root is listening", () => {
		const client = new ObserveClient(join(tmpdir(), "missing-observe.sock"));
		clients.push(client);
		const body = "y".repeat(48 * 1024);
		const started = Date.now();
		for (let i = 0; i < 2_000; i++) {
			client.send({ i, body });
		}
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(client.pendingCount).toBeLessThanOrEqual(200);
		expect(client.pendingBytes).toBeLessThanOrEqual(512 * 1024);
	});
});
