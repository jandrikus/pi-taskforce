/**
 * §12. The identity of this operating-system process, not of an extension load.
 *
 * A `/reload` replaces every extension instance but keeps the JavaScript global
 * object. A restart creates a new process and therefore a new identity. Attempt
 * records use it to tell an effect that may still be in flight in this process
 * from one whose process is gone and can no longer deliver.
 */
import { randomUUID } from "node:crypto";

const KEY = Symbol.for("pi-taskforce.process-id");

export function processId(): string {
	const globals = globalThis as typeof globalThis & { [KEY]?: string };
	return (globals[KEY] ??= randomUUID());
}
