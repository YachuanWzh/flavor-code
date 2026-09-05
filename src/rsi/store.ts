/**
 * RSI protected control ledger storage — task P0-03a (rsi.md sections
 * 11.3/11.4, E6 ordering prerequisites).
 *
 * Single-writer, fsync'd append-only JSONL event log plus an atomic JSON
 * snapshot with a monotonic revision for compare-and-set transitions. This is
 * the *storage layer* of the control ledger: it lives in a protected control
 * directory that candidate processes never mount, and every mutation is
 * serialized by an exclusive lock file so multiple front-ends (CLI, desktop,
 * VS Code) cannot interleave half-transactions.
 *
 * Guarantees deliberately kept small and testable:
 * - sequence contiguity and a SHA-256 hash chain over records (tamper/tearing
 *   detection, mirroring the harness journal pattern);
 * - an optional `idempotencyKey` per event: a retried request returns the
 *   original record instead of dispatching the side effect twice;
 * - `compareAndSetState` fails closed on revision mismatch;
 * - a torn final line (power loss) is truncated on load, but a malformed
 *   *committed* record aborts loading instead of silently skipping evidence.
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { hashJson } from "../harness/journal.js";

export const RSI_CONTROL_STORE_VERSION = 1 as const;

/** First-version control event vocabulary (rsi.md 11.4). Unknown types are rejected. */
export const RSI_CONTROL_EVENT_TYPES = [
  "budget.reserved",
  "budget.settled",
  "candidate.proposed",
  "artifact.frozen",
  "eval.completed",
  "promotion.prepared",
  "promotion.committed",
  "rollback.started",
  "rollback.completed",
  "tool_outcomes",
  "trial.reported",
] as const;
export type RsiControlEventType = (typeof RSI_CONTROL_EVENT_TYPES)[number];

const RsiControlEventRecordSchema = z.object({
  version: z.literal(RSI_CONTROL_STORE_VERSION),
  sequence: z.number().int().positive(),
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  type: z.enum(RSI_CONTROL_EVENT_TYPES),
  payload: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).nullable(),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type RsiControlEventRecord = z.infer<typeof RsiControlEventRecordSchema>;

const RsiSnapshotSchema = z.object({
  version: z.literal(RSI_CONTROL_STORE_VERSION),
  revision: z.number().int().nonnegative(),
  data: z.record(z.string(), z.unknown()),
}).strict();
export type RsiSnapshot = z.infer<typeof RsiSnapshotSchema>;

/** Thrown when a CAS write observed a revision other than the caller expected. */
export class RsiRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`RSI state revision conflict: expected ${expected}, actual ${actual}`);
    this.name = "RsiRevisionConflictError";
  }
}

export interface RsiControlStoreOptions {
  /** Protected control directory, outside any candidate mount. */
  directory: string;
  now?(): string;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export interface AppendEventInput {
  type: RsiControlEventType;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface AppendEventResult {
  record: RsiControlEventRecord;
  /** True when an existing event already carried this idempotencyKey. */
  duplicate: boolean;
}

/** Lock-free primitives bound to an already-held ledger lock. */
export interface RsiControlTransaction {
  listEvents(): Promise<RsiControlEventRecord[]>;
  appendEvent(input: AppendEventInput): Promise<AppendEventResult>;
  readState(): Promise<RsiSnapshot | null>;
  compareAndSetState(input: { expectedRevision: number; data: Record<string, unknown> }): Promise<RsiSnapshot>;
}

const LOCK_WAIT_MS = 10;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;

export class RsiControlStore {
  readonly #directory: string;
  readonly #eventsPath: string;
  readonly #statePath: string;
  readonly #lockPath: string;
  readonly #now: () => string;
  readonly #lockTimeoutMs: number;
  readonly #staleLockMs: number;
  #records: RsiControlEventRecord[] = [];
  #loaded = false;

  constructor(options: RsiControlStoreOptions) {
    this.#directory = options.directory;
    this.#eventsPath = join(options.directory, "events.jsonl");
    this.#statePath = join(options.directory, "state.json");
    this.#lockPath = join(options.directory, "control.lock");
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.#staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  get directory(): string { return this.#directory; }
  get eventsPath(): string { return this.#eventsPath; }
  get statePath(): string { return this.#statePath; }

  /** Serialized view of every validated event; call after any mutation. */
  async listEvents(): Promise<RsiControlEventRecord[]> {
    return this.withLock(async () => {
      await this.#reloadUnlocked();
      return this.#records.map((record) => structuredClone(record));
    });
  }

  /**
   * Append one control event. With an `idempotencyKey`, a retry inside the
   * same ledger returns the original record and writes nothing new, so a
   * crashed-and-retried request cannot double-dispatch work or budget.
   */
  async appendEvent(input: AppendEventInput): Promise<AppendEventResult> {
    return this.withLock(async () => this.#appendEventUnlocked(input));
  }

  /**
   * Run a check-then-act sequence while holding the ledger lock exactly once.
   * The supplied transaction primitives must not be used after the callback
   * resolves; the budget ledger uses this so reserve/settle stay atomic
   * across processes without re-entering the non-reentrant lock.
   */
  async transact<T>(operation: (tx: RsiControlTransaction) => Promise<T>): Promise<T> {
    return this.withLock(async () => operation({
      listEvents: async () => {
        await this.#reloadUnlocked();
        return this.#records.map((record) => structuredClone(record));
      },
      appendEvent: (input) => this.#appendEventUnlocked(input),
      readState: () => this.#readStateUnlocked(),
      compareAndSetState: (input) => this.#compareAndSetStateUnlocked(input),
    }));
  }

  async #appendEventUnlocked(input: AppendEventInput): Promise<AppendEventResult> {
    const type = z.enum(RSI_CONTROL_EVENT_TYPES).parse(input.type);
    const key = input.idempotencyKey;
    if (key !== undefined && key.length === 0) throw new Error("idempotencyKey must be non-empty when provided");
    const payload = jsonSafeRecord(input.payload);
    await this.#reloadUnlocked();
    if (key !== undefined) {
      const prior = this.#records.find((record) => record.idempotencyKey === key);
      if (prior !== undefined) return { record: structuredClone(prior), duplicate: true };
    }
    const record = this.#createRecord(type, payload, key ?? null);
    const line = `${JSON.stringify(record)}\n`;
    const handle = await open(this.#eventsPath, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.#records.push(record);
    return { record: structuredClone(record), duplicate: false };
  }

  /** Read the durable snapshot, or null when none has been committed yet. */
  async readState(): Promise<RsiSnapshot | null> {
    return this.withLock(async () => this.#readStateUnlocked());
  }

  /**
   * Atomic revision compare-and-set. `expectedRevision` must equal the current
   * revision (0 for "no snapshot yet") or the write is refused with
   * {@link RsiRevisionConflictError}; the stored revision advances by one.
   */
  async compareAndSetState(input: {
    expectedRevision: number;
    data: Record<string, unknown>;
  }): Promise<RsiSnapshot> {
    return this.withLock(async () => this.#compareAndSetStateUnlocked(input));
  }

  async #compareAndSetStateUnlocked(input: {
    expectedRevision: number;
    data: Record<string, unknown>;
  }): Promise<RsiSnapshot> {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
      throw new Error("expectedRevision must be a non-negative integer");
    }
    const data = jsonSafeRecord(input.data);
    const current = await this.#readStateUnlocked();
    const actual = current?.revision ?? 0;
    if (actual !== input.expectedRevision) throw new RsiRevisionConflictError(input.expectedRevision, actual);
    const next: RsiSnapshot = {
      version: RSI_CONTROL_STORE_VERSION,
      revision: actual + 1,
      data,
    };
    await writeAtomicJson(this.#statePath, RsiSnapshotSchema.parse(next));
    return next;
  }

  /**
   * Run a check-then-act sequence under the ledger's exclusive lock. Callers
   * must reload state inside the callback; the budget ledger uses this to keep
   * reserve/settle atomic across processes.
   */
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
    const deadline = Date.now() + this.#lockTimeoutMs;
    let acquired = false;
    while (!acquired) {
      try {
        const handle = await open(this.#lockPath, "wx", 0o600);
        try {
          await handle.writeFile(token, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        acquired = true;
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
        await this.#removeStaleLockIfPossible();
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for RSI control lock ${this.#lockPath}`);
        await delay(LOCK_WAIT_MS);
      }
    }
    try {
      return await operation();
    } finally {
      try {
        if ((await readFile(this.#lockPath, "utf8")) === token) await rm(this.#lockPath, { force: true });
      } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
      }
    }
  }

  async #readStateUnlocked(): Promise<RsiSnapshot | null> {
    try {
      return RsiSnapshotSchema.parse(JSON.parse(await readFile(this.#statePath, "utf8")) as unknown);
    } catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new Error(`RSI control snapshot is invalid: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  /** Reload and fully revalidate the log so a concurrent writer is observed. */
  async #reloadUnlocked(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.#eventsPath, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        this.#records = [];
        this.#loaded = true;
        return;
      }
      throw error;
    }
    // A power loss can leave one partial tail record; only a missing final
    // newline is tolerated and trimmed.
    const committed = raw.endsWith("\n") ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf("\n") + 1));
    if (committed.length !== raw.length) {
      const handle = await open(this.#eventsPath, "r+");
      try {
        await handle.truncate(Buffer.byteLength(committed));
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const records: RsiControlEventRecord[] = [];
    let previousHash: string | null = null;
    let expectedSequence = 1;
    for (const line of committed.split("\n")) {
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new Error(`RSI control event line is not valid JSON (sequence ${expectedSequence})`, { cause: error });
      }
      const record = RsiControlEventRecordSchema.parse(parsed);
      if (record.sequence !== expectedSequence) {
        throw new Error(`RSI control event sequence is not contiguous at ${record.sequence}`);
      }
      if (record.previousHash !== previousHash) {
        throw new Error(`RSI control event hash chain is broken at ${record.sequence}`);
      }
      if (record.hash !== eventHash(record)) {
        throw new Error(`RSI control event hash is invalid at ${record.sequence}`);
      }
      records.push(record);
      previousHash = record.hash;
      expectedSequence += 1;
    }
    this.#records = records;
    this.#loaded = true;
  }

  #createRecord(type: RsiControlEventType, payload: Record<string, unknown>, idempotencyKey: string | null): RsiControlEventRecord {
    const last = this.#records.at(-1);
    const unsigned = {
      version: RSI_CONTROL_STORE_VERSION,
      sequence: (last?.sequence ?? 0) + 1,
      id: randomUUID(),
      timestamp: this.#now(),
      type,
      payload,
      idempotencyKey,
      previousHash: last?.hash ?? null,
    } as const;
    return RsiControlEventRecordSchema.parse({ ...unsigned, hash: hashJson(unsigned) });
  }

  async #removeStaleLockIfPossible(): Promise<void> {
    let token: string;
    try {
      token = await readFile(this.#lockPath, "utf8");
      const metadata = await stat(this.#lockPath);
      if (Date.now() - metadata.mtimeMs <= this.#staleLockMs) return;
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      throw error;
    }
    let ownerPid: number | undefined;
    try {
      const parsed = JSON.parse(token) as { pid?: unknown };
      if (typeof parsed.pid === "number") ownerPid = parsed.pid;
    } catch {
      ownerPid = undefined;
    }
    if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
    const stale = `${this.#lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(this.#lockPath, stale);
      await rm(stale, { force: true });
    } catch (error) {
      if (isCode(error, "ENOENT") || isCode(error, "EPERM")) return;
      throw error;
    }
  }

  /** True once the log has been read back at least one time. */
  get loaded(): boolean { return this.#loaded; }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function eventHash(record: RsiControlEventRecord): string {
  const { hash: _hash, ...unsigned } = record;
  return hashJson(unsigned);
}

function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? `${item}n` : item));
  return JSON.parse(json) as Record<string, unknown>;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user.
    return isCode(error, "EPERM");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
