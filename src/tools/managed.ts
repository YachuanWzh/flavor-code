import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";
import { message } from "../utils/error.js";

const MANAGED_TOOL_VERSION = 1;
const MAX_RECORD_BYTES = 256 * 1024;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const JsonSchemaObject = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  if (schema.type !== "object") {
    context.addIssue({ code: "custom", message: "Tool input JSON Schema must have type object" });
  }
});

export const RegisterManagedToolInputSchema = z.object({
  name: z.string().regex(TOOL_NAME).describe("Unique callable tool name using letters, digits, and underscores"),
  description: z.string().min(1).max(4_096).describe("Purpose and appropriate use of the generated tool"),
  inputSchema: JsonSchemaObject.describe("Provider-facing JSON Schema with an object at the root"),
  implementation: z.string().min(1).max(64 * 1024).describe(
    "Async JavaScript function body, or complete function/arrow expression, receiving input, signal, and context; return the tool result",
  ),
  scope: z.enum(["project", "global"]).default("project").describe(
    "Project persists in the current workspace; global persists for every workspace",
  ),
  agents: z.array(z.enum(["main", "subagent"])).min(1).max(2).optional().describe(
    "Agent roles allowed to call the generated tool; omit to allow both",
  ),
}).strict();

export const RemoveManagedToolInputSchema = z.object({
  name: z.string().regex(TOOL_NAME).describe("Managed tool name to remove"),
  scope: z.enum(["project", "global"]).optional().describe("Required only when the same name exists in both scopes"),
}).strict();

const ManagedToolRecordSchema = RegisterManagedToolInputSchema.extend({
  version: z.literal(MANAGED_TOOL_VERSION),
  createdAt: z.string().datetime(),
}).strict();

export type RegisterManagedToolInput = z.input<typeof RegisterManagedToolInputSchema>;
export type ManagedToolScope = z.output<typeof RegisterManagedToolInputSchema>["scope"];
export type RemoveManagedToolInput = z.input<typeof RemoveManagedToolInputSchema>;
type ManagedToolRecord = z.output<typeof ManagedToolRecordSchema>;

export interface ManagedToolSummary {
  readonly name: string;
  readonly description: string;
  readonly scope: ManagedToolScope;
  readonly path: string;
  readonly createdAt: string;
  readonly agents?: readonly ("main" | "subagent")[];
  readonly active: boolean;
}

export interface ManagedToolStoreOptions {
  workspace: string;
  home: string;
  now?: () => string;
}

interface StoredManagedTool {
  readonly record: ManagedToolRecord;
  readonly path: string;
  readonly scope: ManagedToolScope;
  readonly definition: ToolDefinition<unknown>;
}

interface ManagedExecutionContext {
  readonly workspace: string;
  readonly scope: ManagedToolScope;
  readonly toolName: string;
}

type ManagedExecutor = (
  input: unknown,
  signal: AbortSignal,
  context: ManagedExecutionContext,
) => Promise<unknown>;

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...parameters: string[]
) => ManagedExecutor;

/** Durable store for agent-authored tools. Managed code is trusted in-process code, like plugins. */
export class ManagedToolStore {
  readonly #workspace: string;
  readonly #projectRoot: string;
  readonly #globalRoot: string;
  readonly #now: () => string;
  readonly #entries = new Map<string, StoredManagedTool>();
  #diagnostics: string[] = [];

  constructor(options: ManagedToolStoreOptions) {
    this.#workspace = resolve(options.workspace);
    this.#projectRoot = join(this.#workspace, ".flavor", "tools");
    this.#globalRoot = join(resolve(options.home), ".flavor-code", "tools");
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  get diagnostics(): readonly string[] { return [...this.#diagnostics]; }

  directory(scope: ManagedToolScope): string {
    return scope === "project" ? this.#projectRoot : this.#globalRoot;
  }

  async load(): Promise<void> {
    this.#entries.clear();
    this.#diagnostics = [];
    await this.#loadDirectory("global");
    await this.#loadDirectory("project");
    const groups = new Map<string, StoredManagedTool[]>();
    for (const entry of this.#entries.values()) {
      const key = normalizeName(entry.record.name);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    for (const group of groups.values()) {
      if (group.length > 1) {
        this.#diagnostics.push(
          `Managed tool "${group[0]!.record.name}" exists in both scopes; the project definition is active.`,
        );
      }
    }
  }

  definitions(): readonly ToolDefinition<unknown>[] {
    return this.#activeEntries().map((entry) => entry.definition);
  }

  list(): readonly ManagedToolSummary[] {
    const active = new Set(this.#activeEntries().map(entryKey));
    return [...this.#entries.values()]
      .sort((left, right) => compare(normalizeName(left.record.name), normalizeName(right.record.name))
        || compareScope(left.scope, right.scope))
      .map((entry) => summary(entry, active.has(entryKey(entry))));
  }

  async register(rawInput: RegisterManagedToolInput): Promise<ManagedToolSummary> {
    let input: z.output<typeof RegisterManagedToolInputSchema>;
    try { input = RegisterManagedToolInputSchema.parse(rawInput); }
    catch (error) { throw new Error(`Invalid managed tool registration: ${message(error)}`); }
    if (this.#matching(input.name).length > 0) throw new Error(`Managed tool "${input.name}" already exists`);

    const record = ManagedToolRecordSchema.parse({
      ...input,
      version: MANAGED_TOOL_VERSION,
      createdAt: this.#now(),
    });
    const path = join(this.directory(input.scope), filename(input.name));
    const definition = compileDefinition(record, input.scope, this.#workspace);
    await writeExclusive(path, `${JSON.stringify(record, undefined, 2)}\n`);
    const entry = { record, path, scope: input.scope, definition } satisfies StoredManagedTool;
    this.#entries.set(scopedKey(input.scope, input.name), entry);
    return summary(entry, true);
  }

  async remove(rawInput: RemoveManagedToolInput): Promise<ManagedToolSummary> {
    const input = RemoveManagedToolInputSchema.parse(rawInput);
    const matches = this.#matching(input.name).filter((entry) => input.scope === undefined || entry.scope === input.scope);
    if (matches.length === 0) throw new Error(`Managed tool "${input.name}" was not found`);
    if (matches.length > 1) throw new Error(`Managed tool "${input.name}" exists in multiple scopes; specify scope`);
    const entry = matches[0]!;
    const info = await lstat(entry.path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Managed tool path is no longer a regular file: ${entry.path}`);
    await unlink(entry.path);
    this.#entries.delete(scopedKey(entry.scope, entry.record.name));
    return summary(entry, false);
  }

  removalPaths(rawInput: RemoveManagedToolInput): string[] {
    const parsed = RemoveManagedToolInputSchema.safeParse(rawInput);
    if (!parsed.success) return [];
    const matches = this.#matching(parsed.data.name)
      .filter((entry) => parsed.data.scope === undefined || entry.scope === parsed.data.scope);
    if (matches.length > 0) return matches.map((entry) => entry.path);
    return [join(this.directory(parsed.data.scope ?? "project"), filename(parsed.data.name))];
  }

  async #loadDirectory(scope: ManagedToolScope): Promise<void> {
    const root = this.directory(scope);
    let names: string[];
    try {
      names = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".json"))
        .sort((left, right) => compare(left.name, right.name))
        .map((entry) => entry.name);
    } catch (error) {
      if (isMissing(error)) return;
      this.#diagnostics.push(`${root}: ${message(error)}`);
      return;
    }

    for (const name of names) {
      const path = join(root, name);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error("Managed tool record must be a regular file");
        if (info.size > MAX_RECORD_BYTES) throw new Error(`Managed tool record exceeds ${MAX_RECORD_BYTES} bytes`);
        const record = ManagedToolRecordSchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
        if (record.scope !== scope) throw new Error(`Managed tool record scope must match its ${scope} directory`);
        const key = scopedKey(scope, record.name);
        if (this.#entries.has(key)) throw new Error(`Duplicate managed tool name in ${scope} scope: ${record.name}`);
        this.#entries.set(key, {
          record,
          path,
          scope,
          definition: compileDefinition(record, scope, this.#workspace),
        });
      } catch (error) {
        this.#diagnostics.push(`${path}: ${message(error)}`);
      }
    }
  }

  #matching(name: string): StoredManagedTool[] {
    const normalized = normalizeName(name);
    return [...this.#entries.values()].filter((entry) => normalizeName(entry.record.name) === normalized);
  }

  #activeEntries(): StoredManagedTool[] {
    const winners = new Map<string, StoredManagedTool>();
    for (const entry of this.#entries.values()) {
      const key = normalizeName(entry.record.name);
      const current = winners.get(key);
      if (current === undefined || (current.scope === "global" && entry.scope === "project")) winners.set(key, entry);
    }
    return [...winners.values()].sort((left, right) => compare(normalizeName(left.record.name), normalizeName(right.record.name)));
  }
}

export interface ManagedToolManagementOptions {
  store: ManagedToolStore;
  conflict(name: string): string | undefined;
  onChanged(): void | Promise<void>;
}

export function createManagedToolManagementTools(
  options: ManagedToolManagementOptions,
): readonly ToolDefinition<unknown>[] {
  const mainOnly = ["main"] as const;
  const registerTool: ToolDefinition<unknown> = {
    name: "RegisterTool",
    description: "Create a durable custom tool from JSON Schema and async JavaScript, then expose it immediately",
    inputSchema: RegisterManagedToolInputSchema,
    agents: mainOnly,
    paths: (rawInput) => {
      const parsed = RegisterManagedToolInputSchema.safeParse(rawInput);
      return parsed.success ? [options.store.directory(parsed.data.scope)] : [];
    },
    summarize: (rawInput) => {
      const parsed = RegisterManagedToolInputSchema.safeParse(rawInput);
      return parsed.success ? `${parsed.data.name} (${parsed.data.scope})` : undefined;
    },
    execute: async (rawInput, signal) => {
      signal.throwIfAborted();
      const input = RegisterManagedToolInputSchema.parse(rawInput);
      const conflict = options.conflict(input.name);
      if (conflict !== undefined) throw new Error(`Tool name "${input.name}" conflicts with ${conflict}`);
      const registered = await options.store.register(input);
      try {
        await options.onChanged();
      } catch (error) {
        await options.store.remove({ name: registered.name, scope: registered.scope });
        try { await options.onChanged(); } catch { /* Preserve the replacement failure. */ }
        throw error;
      }
      return { ...registered, availableImmediately: true };
    },
  };

  const removeTool: ToolDefinition<unknown> = {
    name: "RemoveTool",
    description: "Delete a durable tool previously created by RegisterTool and remove it from the current runtime immediately",
    inputSchema: RemoveManagedToolInputSchema,
    agents: mainOnly,
    paths: (rawInput) => options.store.removalPaths(rawInput as RemoveManagedToolInput),
    summarize: (rawInput) => {
      const parsed = RemoveManagedToolInputSchema.safeParse(rawInput);
      return parsed.success ? `${parsed.data.name}${parsed.data.scope === undefined ? "" : ` (${parsed.data.scope})`}` : undefined;
    },
    execute: async (rawInput, signal) => {
      signal.throwIfAborted();
      const removed = await options.store.remove(RemoveManagedToolInputSchema.parse(rawInput));
      await options.onChanged();
      return { ...removed, removedImmediately: true };
    },
  };

  const listTools: ToolDefinition<unknown> = {
    name: "ListRegisteredTools",
    description: "List durable tools created through RegisterTool, including scope, path, and active precedence",
    inputSchema: z.object({}).strict(),
    agents: mainOnly,
    paths: () => [],
    execute: async (_input, signal) => {
      signal.throwIfAborted();
      return options.store.list();
    },
  };

  return [registerTool, removeTool, listTools];
}

function compileDefinition(
  record: ManagedToolRecord,
  scope: ManagedToolScope,
  workspace: string,
): ToolDefinition<unknown> {
  let inputSchema: z.ZodType;
  try {
    inputSchema = z.fromJSONSchema(record.inputSchema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    throw new Error(`Invalid input schema for managed tool "${record.name}": ${message(error)}`);
  }
  const executor = compileExecutor(record.name, record.implementation);
  const context = Object.freeze({ workspace, scope, toolName: record.name });
  return {
    name: record.name,
    description: record.description,
    inputSchema,
    modelInputSchema: record.inputSchema,
    modelStrict: true,
    ...(record.agents === undefined ? {} : { agents: record.agents }),
    paths: () => [],
    execute: async (input, signal) => {
      signal.throwIfAborted();
      return executor(input, signal, context);
    },
  };
}

function compileExecutor(name: string, implementation: string): ManagedExecutor {
  const sourceUrl = `//# sourceURL=flavor-managed-tool-${name}.js`;
  const expression = implementation.trim().replace(/;+\s*$/, "");
  let expressionError: unknown;
  try {
    return new AsyncFunction(
      "input",
      "signal",
      "context",
      `"use strict";\nconst implementation = (${expression});\n`
        + `if (typeof implementation !== "function") { throw new TypeError("Managed tool implementation expression must evaluate to a function"); }\n`
        + `return await implementation(input, signal, context);\n${sourceUrl}`,
    );
  } catch (error) {
    expressionError = error;
  }

  try {
    return new AsyncFunction(
      "input",
      "signal",
      "context",
      `"use strict";\n${implementation}\n${sourceUrl}`,
    );
  } catch (bodyError) {
    throw new Error(
      `Invalid implementation for managed tool "${name}": expected a function body or a complete function/arrow expression. `
        + `Function body error: ${message(bodyError)}. Function expression error: ${message(expressionError)}`,
    );
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await link(temporary, path);
  } finally {
    try { await unlink(temporary); } catch { /* Temporary files are not loadable records. */ }
  }
}

function summary(entry: StoredManagedTool, active: boolean): ManagedToolSummary {
  return {
    name: entry.record.name,
    description: entry.record.description,
    scope: entry.scope,
    path: entry.path,
    createdAt: entry.record.createdAt,
    ...(entry.record.agents === undefined ? {} : { agents: [...entry.record.agents] }),
    active,
  };
}

function filename(name: string): string { return `${normalizeName(name)}.json`; }
function normalizeName(name: string): string { return name.toLowerCase(); }
function scopedKey(scope: ManagedToolScope, name: string): string { return `${scope}:${normalizeName(name)}`; }
function entryKey(entry: StoredManagedTool): string { return scopedKey(entry.scope, entry.record.name); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function compareScope(left: ManagedToolScope, right: ManagedToolScope): number {
  return left === right ? 0 : left === "global" ? -1 : 1;
}
function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
