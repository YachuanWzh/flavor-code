import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { PermissionModeSchema } from "../config/schema.js";
import { TaskGraphSchema } from "../agent/planner.js";
import { SubagentResultSchema } from "../agent/subagents.js";
import { TaskPlanSchema, normalizeAbandonedPlan } from "../agent/task-plan.js";
import { message } from "../utils/error.js";

export const SESSION_VERSION = 2 as const;
export const DEFAULT_MAX_SESSION_BYTES = 5 * 1024 * 1024;

const SessionIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Invalid session id");
const IsoDateSchema = z.string().datetime({ offset: true });
const ToolCallSchema = z.object({
  id: z.string().min(1).max(256), name: z.string().min(1).max(256), input: z.unknown(),
}).strict();
const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string().max(DEFAULT_MAX_SESSION_BYTES),
  toolCallId: z.string().min(1).max(256).optional(),
  toolCalls: z.array(ToolCallSchema).max(1_000).optional(),
}).strict();
const LegacySummarySchema = z.object({ role: z.literal("system"), content: z.string().max(DEFAULT_MAX_SESSION_BYTES) }).strict();
const CompactBoundarySchema = z.object({
  summary: z.string().min(1).max(DEFAULT_MAX_SESSION_BYTES),
  compactedAt: IsoDateSchema,
}).strict();
const StateSchema = z.enum(["pending", "running", "completed", "failed", "blocked", "cancelled"]);

const SessionBaseSchema = z.object({
  sessionId: SessionIdSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  workspace: z.object({ path: z.string().min(1).max(32_768) }).strict(),
  tasks: z.object({
    plan: TaskPlanSchema.optional(),
    graph: TaskGraphSchema.optional(),
    states: z.record(z.string(), StateSchema),
    results: z.record(z.string(), SubagentResultSchema),
  }).strict(),
  models: z.object({ main: z.string().min(1).max(1_024), subagent: z.string().min(1).max(1_024) }).strict(),
  permissionMode: PermissionModeSchema,
}).strict();

const SessionDocumentV1Schema = SessionBaseSchema.extend({
  version: z.literal(1),
  conversation: z.object({
    summary: LegacySummarySchema.optional(),
    messages: z.array(MessageSchema).max(50_000),
  }).strict(),
}).strict();

export const SessionDocumentSchema = SessionBaseSchema.extend({
  version: z.literal(SESSION_VERSION),
  conversation: z.object({
    compact: CompactBoundarySchema.optional(),
    messages: z.array(MessageSchema).max(50_000),
  }).strict(),
}).strict();

export type SessionDocument = z.infer<typeof SessionDocumentSchema>;
export interface SessionEntry {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  mainModel: string;
}

export interface SessionStoreOptions { workspace: string; maxBytes?: number; maxSessions?: number }

export class SessionStore {
  readonly #workspace: string;
  readonly #sessions: string;
  readonly #maxBytes: number;
  readonly #maxSessions: number;

  constructor(options: SessionStoreOptions) {
    this.#workspace = resolve(options.workspace);
    this.#sessions = join(this.#workspace, ".flavor", "sessions");
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_SESSION_BYTES;
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes < 256) throw new Error("maxBytes must be an integer of at least 256");
    this.#maxSessions = options.maxSessions ?? 50;
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) throw new Error("maxSessions must be an integer of at least 1");
  }

  async save(input: SessionDocument): Promise<void> {
    const document = SessionDocumentSchema.parse(sanitize(input));
    await this.#assertWorkspace(document.workspace.path);
    await this.#prepareDirectory();
    const target = this.#path(document.sessionId);
    const { conversation: { messages, compact }, ...meta } = document;
    const metaLine = JSON.stringify({
      __meta: true,
      ...meta,
      ...(compact === undefined ? {} : { compact }),
    });
    const lines = [metaLine, ...messages.map((message) => JSON.stringify(message))];
    const body = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(body) > this.#maxBytes) throw new Error(`Session exceeds maximum size of ${this.#maxBytes} bytes`);
    const temporary = join(this.#sessions, `.${document.sessionId}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
    await this.#prune().catch(() => undefined);
  }

  async load(sessionId?: string): Promise<SessionDocument> {
    if (sessionId === undefined) {
      const [latest] = await this.list();
      if (latest === undefined) throw new Error("No saved sessions exist in this workspace");
      sessionId = latest.sessionId;
    }
    SessionIdSchema.parse(sessionId);
    await this.#assertSafeExistingDirectory();
    const path = this.#path(sessionId);
    let raw: string;
    try { raw = await boundedRead(path, this.#maxBytes); }
    catch (error) {
      if (isCode(error, "ENOENT")) throw new Error(`Session "${sessionId}" was not found in this workspace`);
      throw error;
    }
    let parsed: SessionDocument;
    try { parsed = this.#parseSession(raw); }
    catch (error) {
      const quarantine = await this.#quarantine(path);
      throw new Error(`Session "${sessionId}" is corrupt or incompatible and was quarantined as ${basename(quarantine)}: ${message(error)}`);
    }
    await this.#assertWorkspace(parsed.workspace.path);
    return normalizeAbandonedTasks(parsed);
  }

  #parseSession(raw: string): SessionDocument {
    const trimmed = raw.trim();
    if (trimmed.length === 0) throw new Error("Empty session file");
    const firstLine = trimmed.split("\n", 1)[0] ?? "";
    let candidate: unknown;
    const first = JSON.parse(firstLine) as Record<string, unknown>;
    if (first.__meta === true) {
      const meta = { ...first };
      const messages = trimmed
        .split("\n")
        .slice(1)
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
      const summary = meta.summary;
      const compact = meta.compact;
      delete meta.__meta;
      delete meta.summary;
      delete meta.compact;
      candidate = {
        ...meta,
        conversation: {
          ...(meta.version === 1 && summary !== undefined ? { summary } : {}),
          ...(meta.version === SESSION_VERSION && compact !== undefined ? { compact } : {}),
          messages,
        },
      };
    } else {
      candidate = JSON.parse(trimmed) as unknown;
    }
    return parseAndMigrateSession(candidate);
  }

  async list(): Promise<SessionEntry[]> {
    try { await this.#assertSafeExistingDirectory(); }
    catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
    const names = (await readdir(this.#sessions)).filter((name) => name.endsWith(".jsonl")).sort();
    const entries: SessionEntry[] = [];
    for (const name of names) {
      const id = name.slice(0, -6);
      if (!SessionIdSchema.safeParse(id).success) continue;
      try {
        const document = await this.load(id);
        entries.push({ sessionId: document.sessionId, createdAt: document.createdAt, updatedAt: document.updatedAt, mainModel: document.models.main });
      } catch (error) {
        if (!/corrupt|quarantined/i.test(message(error))) throw error;
      }
    }
    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
  }

  async delete(sessionId: string): Promise<void> {
    SessionIdSchema.parse(sessionId);
    try { await this.#assertSafeExistingDirectory(); }
    catch (error) { if (isCode(error, "ENOENT")) return; throw error; }
    const path = this.#path(sessionId);
    try {
      const metadata = await lstat(path);
      if (!metadata.isFile()) throw new Error("Session path is not a regular file");
      await rm(path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  #path(sessionId: string): string {
    SessionIdSchema.parse(sessionId);
    const path = resolve(this.#sessions, `${sessionId}.jsonl`);
    if (!isWithin(this.#sessions, path)) throw new Error("Invalid session id");
    return path;
  }

  async #prune(): Promise<void> {
    const entries = await this.list();
    if (entries.length <= this.#maxSessions) return;
    const excess = entries.slice(this.#maxSessions);
    for (const entry of excess) {
      await rm(this.#path(entry.sessionId), { force: true }).catch(() => undefined);
    }
  }

  async #assertWorkspace(stored: string): Promise<void> {
    const expected = await canonical(this.#workspace);
    const actual = await canonical(stored);
    if (process.platform === "win32" ? expected.toLowerCase() !== actual.toLowerCase() : expected !== actual) {
      throw new Error(`Session belongs to a different workspace: ${stored}. Resume it from that workspace.`);
    }
  }

  async #prepareDirectory(): Promise<void> {
    await assertNoSymlink(this.#workspace, dirname(this.#sessions));
    await mkdir(this.#sessions, { recursive: true, mode: 0o700 });
    await this.#assertSafeExistingDirectory();
  }

  async #assertSafeExistingDirectory(): Promise<void> {
    await assertNoSymlink(this.#workspace, this.#sessions);
    const canonicalRoot = await realpath(this.#workspace);
    const canonicalSessions = await realpath(this.#sessions);
    if (!isWithin(canonicalRoot, canonicalSessions)) throw new Error("Session directory escapes the workspace");
  }

  async #quarantine(path: string): Promise<string> {
    const target = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await rename(path, target);
    return target;
  }
}

async function boundedRead(path: string, maxBytes: number): Promise<string> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error("Session path is not a regular file");
  if (metadata.size > maxBytes) throw new Error(`Session exceeds maximum read size of ${maxBytes} bytes`);
  const value = await readFile(path);
  if (value.byteLength > maxBytes) throw new Error(`Session exceeds maximum read size of ${maxBytes} bytes`);
  return value.toString("utf8");
}

function normalizeAbandonedTasks(document: SessionDocument): SessionDocument {
  const plan = document.tasks.plan === undefined ? undefined : normalizeAbandonedPlan(document.tasks.plan);
  const states = { ...document.tasks.states };
  const results = { ...document.tasks.results };
  const nodes = new Map(document.tasks.graph?.nodes.map((node) => [node.id, node]) ?? []);
  for (const [id, state] of Object.entries(states)) {
    if (state !== "running") continue;
    const node = nodes.get(id);
    const failedDependency = node?.dependencies.some((dependency) => ["failed", "blocked"].includes(states[dependency] ?? "pending")) ?? false;
    states[id] = failedDependency ? "failed" : "pending";
    if (failedDependency && results[id] === undefined) results[id] = {
      taskId: id, status: "failed", summary: "Recovered as failed because a dependency did not complete",
      filesChanged: [], commandsRun: [], verification: [], artifacts: [], risks: ["Execution was abandoned"], suggestedNextSteps: [],
    };
  }
  return {
    ...document,
    tasks: {
      ...document.tasks,
      ...(plan === undefined ? {} : { plan }),
      states,
      results,
    },
  };
}

function parseAndMigrateSession(input: unknown): SessionDocument {
  if (typeof input !== "object" || input === null || !("version" in input)) throw new Error("Session version is missing");
  if (input.version === SESSION_VERSION) return SessionDocumentSchema.parse(input);
  if (input.version !== 1) throw new Error(`Unsupported session version: ${String(input.version)}`);
  const legacy = SessionDocumentV1Schema.parse(input);
  const { conversation, ...metadata } = legacy;
  const prefix = "Conversation summary\n";
  const summary = conversation.summary?.content.startsWith(prefix)
    ? conversation.summary.content.slice(prefix.length).trim()
    : undefined;
  return SessionDocumentSchema.parse({
    ...metadata,
    version: SESSION_VERSION,
    conversation: {
      ...(summary === undefined || summary.length === 0 ? {} : {
        compact: { summary, compactedAt: legacy.updatedAt },
      }),
      messages: conversation.messages,
    },
  });
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  let cursor = resolve(target);
  const stop = resolve(root);
  if (!isWithin(stop, cursor)) throw new Error("Session path escapes the workspace");
  const chain: string[] = [];
  while (cursor !== stop) { chain.push(cursor); cursor = dirname(cursor); }
  for (const path of chain.reverse()) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Session path contains a symbolic link: ${path}`); }
    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  }
}

function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.includes(":"));
}
async function canonical(path: string): Promise<string> { try { return await realpath(resolve(path)); } catch { return resolve(path); } }
function isCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }

function sanitize(input: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof input === "string") {
    if (/\b(?:authorization|api[_ -]?key|provider[_ -]?key|access[_ -]?token|secret)\s*[:=]/i.test(input)) return "[redacted]";
    return input.replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]");
  }
  if (Array.isArray(input)) return input.map((item) => sanitize(item, seen));
  if (typeof input !== "object" || input === null) return input;
  if (seen.has(input)) return "[redacted circular value]";
  seen.add(input);
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (/^(?:authorization|proxy-authorization|api[_-]?key|provider[_-]?key|access[_-]?token|secret)$/i.test(key)) continue;
    output[key] = sanitize(value, seen);
  }
  seen.delete(input);
  return output;
}
