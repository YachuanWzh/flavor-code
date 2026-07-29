import { mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { redactErrorText, redactSecrets } from "../utils/redact.js";
import { TraceRecordSchema, type TraceKind, type TraceRecord } from "./schema.js";

export interface TraceRecorderOptions {
  path: string;
  sessionId: string;
  secrets?: readonly string[];
  now?: () => Date;
}

export class TraceRecorder {
  readonly path: string;
  readonly #sessionId: string;
  readonly #secrets: readonly string[];
  readonly #now: () => Date;
  #sequence = 0;
  #handle: FileHandle | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: TraceRecorderOptions) {
    this.path = resolve(options.path);
    this.#sessionId = options.sessionId;
    this.#secrets = options.secrets ?? [];
    this.#now = options.now ?? (() => new Date());
  }

  record(kind: TraceKind, payload: unknown): Promise<void> {
    const sequence = ++this.#sequence;
    this.#tail = this.#tail.then(async () => {
      const handle = await this.#file();
      const serialized = redactErrorText(redactSecrets(JSON.stringify(payload) ?? "null", this.#secrets));
      const record: TraceRecord = TraceRecordSchema.parse({
        version: 1,
        sequence,
        timestamp: this.#now().toISOString(),
        sessionId: this.#sessionId,
        kind,
        payload: JSON.parse(serialized) as unknown,
      });
      await handle.appendFile(`${JSON.stringify(record)}\n`, "utf8");
    });
    return this.#tail;
  }

  async close(): Promise<void> {
    await this.#tail;
    await this.#handle?.close();
    this.#handle = undefined;
  }

  async #file(): Promise<FileHandle> {
    if (this.#handle !== undefined) return this.#handle;
    await mkdir(dirname(this.path), { recursive: true });
    this.#handle = await open(this.path, "a", 0o600);
    return this.#handle;
  }
}
