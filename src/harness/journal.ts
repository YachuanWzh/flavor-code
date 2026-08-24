import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, truncateSync, writeSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { assertHarnessInvariants } from "./invariants.js";

export const HARNESS_JOURNAL_VERSION = 1 as const;
const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

const QueueKindSchema = z.enum(["steer", "followUp"]);
const EventTypeSchema = z.enum([
  "queue.admitted", "queue.claimed", "queue.acked", "queue.released",
  "turn.started", "turn.completed", "turn.interrupted",
  "model.requested", "model.completed",
  "tool.started", "tool.completed", "tool.interrupted",
  "savepoint.created", "recovery.completed",
]);

const JournalRecordSchema = z.object({
  version: z.literal(HARNESS_JOURNAL_VERSION),
  sequence: z.number().int().positive(),
  id: z.string().uuid(),
  timestamp: z.string().datetime({ offset: true }),
  type: EventTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type HarnessJournalEventType = z.infer<typeof EventTypeSchema>;
export type HarnessJournalRecord = z.infer<typeof JournalRecordSchema>;

export interface DurableQueueItem<T = unknown> {
  id: string;
  kind: "steer" | "followUp";
  payload: T;
  admittedAt: string;
  recovered: boolean;
}

export interface IncompleteToolCall {
  id: string;
  tool: string;
  retrySafe: boolean;
  inputHash: string;
}

export interface HarnessRecovery<T = unknown> {
  queue: DurableQueueItem<T>[];
  incompleteTools: IncompleteToolCall[];
  incompleteModelIds: string[];
  interruptedTurnIds: string[];
  lastSavepoint?: { id: string; phase: string; configHash: string };
}

export interface HarnessJournalOptions {
  workspace: string;
  sessionId: string;
  now?(): string;
  maxBytes?: number;
}

/**
 * Crash-consistent, hash-chained execution journal. Queue admission uses a
 * synchronous fsync because returning from steer/followUp is the durability
 * boundary: once the UI says "queued", the prompt must survive a hard crash.
 */
export class HarnessJournal {
  readonly #path: string;
  readonly #now: () => string;
  readonly #maxBytes: number;
  #sequence = 0;
  #lastHash: string | null = null;
  #records: HarnessJournalRecord[] = [];

  constructor(options: HarnessJournalOptions) {
    const workspace = resolve(options.workspace);
    const directory = join(workspace, ".flavor", "sessions");
    assertSessionId(options.sessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertWithin(workspace, directory);
    const canonicalWorkspace = realpathSync.native(workspace);
    const canonicalDirectory = realpathSync.native(directory);
    if (!isWithin(canonicalWorkspace, canonicalDirectory)) throw new Error("Harness journal directory escapes the workspace");
    this.#path = join(canonicalDirectory, `${options.sessionId}.events.jsonl`);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#maxBytes = options.maxBytes ?? MAX_JOURNAL_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 1024) throw new Error("maxBytes must be an integer of at least 1024");
    this.#load();
  }

  get path(): string { return this.#path; }
  get records(): readonly HarnessJournalRecord[] { return this.#records.map((record) => structuredClone(record)); }

  admitQueue<T>(kind: "steer" | "followUp", payload: T): string {
    QueueKindSchema.parse(kind);
    const id = randomUUID();
    this.#append("queue.admitted", { id, kind, payload });
    return id;
  }

  claimQueue(id: string): void { this.#append("queue.claimed", { id }); }
  ackQueue(id: string): void { this.#append("queue.acked", { id }); }
  releaseQueue(id: string, reason: string): void { this.#append("queue.released", { id, reason }); }

  startTurn(config: unknown, prompt: unknown): string {
    const id = randomUUID();
    this.#append("turn.started", { id, config: structuredClone(config), configHash: hashJson(config), prompt: structuredClone(prompt), promptHash: hashJson(prompt) });
    return id;
  }

  completeTurn(id: string): void { this.#append("turn.completed", { id }); }
  interruptTurn(id: string, reason: string): void { this.#append("turn.interrupted", { id, reason }); }

  startModel(input: { agent: string; model: string; iteration: number; attempt: number; messages: unknown }): string {
    const id = randomUUID();
    this.#append("model.requested", { id, ...structuredClone(input), messagesHash: hashJson(input.messages) });
    return id;
  }

  completeModel(id: string, completed: boolean, error?: string): void {
    this.#append("model.completed", { id, completed, ...(error === undefined ? {} : { error }) });
  }

  startTool(tool: string, input: unknown, retrySafe: boolean): string {
    const id = randomUUID();
    this.#append("tool.started", { id, tool, input: structuredClone(input), inputHash: hashJson(input), retrySafe });
    return id;
  }

  completeTool(id: string, result: unknown): void { this.#append("tool.completed", { id, result: structuredClone(result) }); }
  interruptTool(id: string, reason: string): void { this.#append("tool.interrupted", { id, reason }); }

  savepoint(phase: string, config: unknown): string {
    const id = randomUUID();
    this.#append("savepoint.created", { id, phase, configHash: hashJson(config) });
    return id;
  }

  recover<T = unknown>(): HarnessRecovery<T> {
    const queue = new Map<string, DurableQueueItem<T>>();
    const claimed = new Set<string>();
    const tools = new Map<string, IncompleteToolCall>();
    const models = new Set<string>();
    const turns = new Set<string>();
    let lastSavepoint: HarnessRecovery<T>["lastSavepoint"];
    for (const record of this.#records) {
      const payload = record.payload;
      const id = typeof payload.id === "string" ? payload.id : "";
      if (record.type === "queue.admitted") {
        const kind = QueueKindSchema.parse(payload.kind);
        queue.set(id, { id, kind, payload: payload.payload as T, admittedAt: record.timestamp, recovered: false });
      } else if (record.type === "queue.claimed") claimed.add(id);
      else if (record.type === "queue.acked") { queue.delete(id); claimed.delete(id); }
      else if (record.type === "queue.released") claimed.delete(id);
      else if (record.type === "turn.started") turns.add(id);
      else if (record.type === "turn.completed" || record.type === "turn.interrupted") turns.delete(id);
      else if (record.type === "model.requested") models.add(id);
      else if (record.type === "model.completed") models.delete(id);
      else if (record.type === "tool.started") tools.set(id, {
        id,
        tool: String(payload.tool ?? "unknown"),
        retrySafe: payload.retrySafe === true,
        inputHash: String(payload.inputHash ?? ""),
      });
      else if (record.type === "tool.completed" || record.type === "tool.interrupted") tools.delete(id);
      else if (record.type === "savepoint.created") lastSavepoint = {
        id,
        phase: String(payload.phase ?? "unknown"),
        configHash: String(payload.configHash ?? ""),
      };
    }
    const recovered = [...queue.values()].map((item) => ({ ...item, recovered: claimed.has(item.id) }));
    return {
      queue: recovered,
      incompleteTools: [...tools.values()],
      incompleteModelIds: [...models],
      interruptedTurnIds: [...turns],
      ...(lastSavepoint === undefined ? {} : { lastSavepoint }),
    };
  }

  markRecoveryComplete(recovery: HarnessRecovery): void {
    for (const item of recovery.queue) if (item.recovered) this.releaseQueue(item.id, "process-recovery");
    for (const tool of recovery.incompleteTools) {
      this.interruptTool(tool.id, tool.retrySafe
        ? "interrupted by process exit; eligible only for explicit retry"
        : "interrupted by process exit; automatic replay forbidden");
    }
    for (const id of recovery.incompleteModelIds) this.completeModel(id, false, "interrupted by process exit");
    for (const id of recovery.interruptedTurnIds) this.interruptTurn(id, "interrupted by process exit");
    this.#append("recovery.completed", {
      queueItems: recovery.queue.length,
      interruptedTools: recovery.incompleteTools.length,
      interruptedModels: recovery.incompleteModelIds.length,
      interruptedTurns: recovery.interruptedTurnIds.length,
    });
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    const metadata = statSync(this.#path);
    if (!metadata.isFile()) throw new Error("Harness journal path is not a regular file");
    if (metadata.size > this.#maxBytes) throw new Error(`Harness journal exceeds ${this.#maxBytes} bytes`);
    const raw = readFileSync(this.#path, "utf8");
    // A power loss can leave one partial tail record. Only a non-newline tail is
    // discarded; malformed committed lines fail closed.
    const committed = raw.endsWith("\n") ? raw : raw.slice(0, Math.max(0, raw.lastIndexOf("\n") + 1));
    if (committed.length !== raw.length) truncateSync(this.#path, Buffer.byteLength(committed));
    const lines = committed.split("\n").filter(Boolean);
    let previousHash: string | null = null;
    for (const line of lines) {
      const record = JournalRecordSchema.parse(JSON.parse(line) as unknown);
      if (record.sequence !== this.#records.length + 1) throw new Error("Harness journal sequence is not contiguous");
      if (record.previousHash !== previousHash) throw new Error("Harness journal hash chain is broken");
      if (record.hash !== recordHash(record)) throw new Error("Harness journal record hash is invalid");
      this.#records.push(record);
      previousHash = record.hash;
    }
    this.#sequence = this.#records.length;
    this.#lastHash = previousHash;
    assertHarnessInvariants(this.#records);
  }

  #append(type: HarnessJournalEventType, payload: Record<string, unknown>): void {
    const normalizedPayload = jsonSafeRecord(payload);
    const unsigned = {
      version: HARNESS_JOURNAL_VERSION,
      sequence: this.#sequence + 1,
      id: randomUUID(),
      timestamp: this.#now(),
      type,
      payload: normalizedPayload,
      previousHash: this.#lastHash,
    } as const;
    const record = JournalRecordSchema.parse({ ...unsigned, hash: hashJson(unsigned) });
    const line = `${JSON.stringify(record)}\n`;
    const priorBytes = existsSync(this.#path) ? statSync(this.#path).size : 0;
    if (priorBytes + Buffer.byteLength(line) > this.#maxBytes) throw new Error(`Harness journal exceeds ${this.#maxBytes} bytes`);
    const fd = openSync(this.#path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
    try { writeSync(fd, line, undefined, "utf8"); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.#records.push(record);
    this.#sequence = record.sequence;
    this.#lastHash = record.hash;
  }
}

function jsonSafeRecord(value: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? `${item}n` : item);
  return JSON.parse(json) as Record<string, unknown>;
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function recordHash(record: HarnessJournalRecord): string {
  const { hash: _hash, ...unsigned } = record;
  return hashJson(unsigned);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function assertSessionId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) throw new Error("Invalid session id");
}

function assertWithin(root: string, target: string): void {
  if (!isWithin(resolve(root), resolve(target))) throw new Error("Harness journal path escapes the workspace");
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.startsWith(`..${sep}`));
}
