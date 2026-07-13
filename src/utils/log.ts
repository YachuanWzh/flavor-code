import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

let pending: Promise<void> = Promise.resolve();

export function logError(error: unknown): void {
  if (process.env.DEBUG) process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
}

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  event: string;
  tool?: string | undefined;
  model?: string | undefined;
  agent?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  input?: unknown;
}

export class AuditLogger {
  readonly #path: string;
  #closed = false;

  constructor(workspace: string) {
    this.#path = join(resolve(workspace), ".flavor", "audit.jsonl");
  }

  get path(): string {
    return this.#path;
  }

  async append(entry: AuditEntry): Promise<void> {
    if (this.#closed) return;
    const line = `${JSON.stringify(entry)}\n`;
    // Serialise appends so concurrent writes don't interleave.
    pending = pending.catch(() => undefined).then(() => this.#write(line));
    return pending;
  }

  async #write(line: string): Promise<void> {
    try {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      await appendFile(this.#path, line, { encoding: "utf8", mode: 0o600, flag: "a" });
    } catch {
      // Audit log write failures must not crash the agent. Swallow silently.
    }
  }

  close(): void {
    this.#closed = true;
  }
}
