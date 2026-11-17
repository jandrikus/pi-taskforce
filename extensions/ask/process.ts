/**
 * §12. How a broker knows whether it is still the process that dispatched a
 * recovered answer.
 *
 * `pi.sendUserMessage()` returns before the message exists, and pi gives an
 * extension no way to see or cancel its queue. What we can know is whether the
 * dispatch happened *here*: a message queued by this process may still land
 * after a watchdog, a cancel or an extension reload, so only a different
 * process may safely treat an unconfirmed dispatch as lost.
 *
 * The token is stored on `globalThis` under a registered symbol, so reloading
 * the extension (new module instances, same process) keeps it, while a new pi
 * process starts with a new one. It is random and never written anywhere except
 * the session journal, next to the ask it belongs to.
 */

import { randomUUID } from "node:crypto";

const TOKEN_KEY = Symbol.for("pi-taskforce.process-token");

export function processToken(): string {
	const holder = globalThis as { [TOKEN_KEY]?: string };
	if (typeof holder[TOKEN_KEY] !== "string" || holder[TOKEN_KEY]!.length === 0) {
		holder[TOKEN_KEY] = randomUUID();
	}
	return holder[TOKEN_KEY]!;
}

/** Test seam: a reload keeps the token, so tests must be able to reset it. */
export function forgetProcessToken(): void {
	delete (globalThis as { [TOKEN_KEY]?: string })[TOKEN_KEY];
}
