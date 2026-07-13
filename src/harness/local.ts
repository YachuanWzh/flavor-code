import { AgentLoop } from "../agent/loop.js";
import { MAIN_TASK_TOOL_NAMES } from "../agent/task-tools.js";
import { z } from "zod";
import type { TaskNode } from "../agent/planner.js";
import type { PermissionMode } from "../permissions/engine.js";
import { PermissionEngine } from "../permissions/engine.js";
import type { ContextManager } from "../context/manager.js";
import type { HookBus } from "../hooks/bus.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ModelTool } from "../models/types.js";
import { ToolRuntime, type ApprovalCallback } from "../tools/runtime.js";
import type { ToolDefinition } from "../tools/types.js";

export interface LocalHarnessOptions {
  registry: ModelRegistry;
  hooks: HookBus;
  workspace: string;
  mainModelId: string;
  subagentModelId: string;
  tools: readonly ToolDefinition<unknown>[];
  createContext(
    agent: "main" | "subagent",
    tools: readonly ToolDefinition<unknown>[],
  ): ContextManager;
  permissionMode?: PermissionMode;
  approve?: ApprovalCallback;
  maxIterationsMain?: number;
  maxIterationsSubagent?: number;
  hasActiveProgress?(): boolean;
}

export interface HarnessProfile {
  modelId: string;
  context: ContextManager;
  runtime: ToolRuntime;
  tools: readonly ModelTool[];
  loop: AgentLoop;
}

export interface SubagentHarness extends HarnessProfile {
  task: TaskNode;
  dispose(): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export class LocalHarness {
  readonly #options: LocalHarnessOptions;
  #subagentModelId: string;
  #mainPermissions!: PermissionEngine;
  readonly #contexts = new WeakSet<ContextManager>();
  readonly #children = new Set<SubagentHarness>();
  readonly main: HarnessProfile;
  #disposed = false;

  constructor(options: LocalHarnessOptions) {
    this.#options = options;
    this.#subagentModelId = options.subagentModelId;
    const context = options.createContext("main", options.tools);
    this.#claimContext(context);
    this.main = this.#createProfile(options.mainModelId, options.tools, "main", context, options.approve);
  }

  get mainModelId(): string { return this.main.loop.modelId; }
  get subagentModelId(): string { return this.#subagentModelId; }
  get permissionMode(): PermissionMode { return this.#mainPermissions.mode; }

  setModel(role: "main" | "subagent", modelId: string): void {
    this.#options.registry.get(modelId);
    if (role === "main") this.main.loop.setModel(modelId);
    else this.#subagentModelId = modelId;
  }

  setPermissionMode(mode: PermissionMode): void { this.#mainPermissions.setMode(mode); }

  createSubagent(task: TaskNode): SubagentHarness {
    if (this.#disposed) throw new Error("LocalHarness is disposed");
    const tools = this.#options.tools.filter((tool) => !MAIN_TASK_TOOL_NAMES.has(tool.name));
    const context = this.#options.createContext("subagent", tools);
    this.#claimContext(context);
    const profile = this.#createProfile(this.#subagentModelId, tools, "subagent", context);
    let disposed = false;
    const child: SubagentHarness = {
      ...profile,
      task,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        profile.runtime.dispose();
        this.#children.delete(child);
      },
      async [Symbol.asyncDispose]() {
        child.dispose();
      },
    };
    this.#children.add(child);
    return child;
  }

  async runSubagent<T>(
    task: TaskNode,
    execute: (harness: SubagentHarness, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<T> {
    if (this.#disposed) throw new Error("LocalHarness is disposed");
    const child = this.createSubagent(task);
    try {
      signal.throwIfAborted();
      return await execute(child, signal);
    } finally {
      await child[Symbol.asyncDispose]();
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const child of [...this.#children]) child.dispose();
    this.main.runtime.dispose();
  }

  async [Symbol.asyncDispose](): Promise<void> { this.dispose(); }

  #claimContext(context: ContextManager): void {
    if (this.#contexts.has(context)) {
      throw new Error("createContext must return a fresh ContextManager for main and every subagent");
    }
    this.#contexts.add(context);
  }

  #createProfile(
    modelId: string,
    definitions: readonly ToolDefinition<unknown>[],
    agent: "main" | "subagent",
    context: ContextManager,
    approve?: ApprovalCallback,
  ): HarnessProfile {
    const permissions = new PermissionEngine({
      workspace: this.#options.workspace,
      mode: agent === "subagent" ? "workspace" : (this.#options.permissionMode ?? "workspace"),
    });
    if (agent === "main") this.#mainPermissions = permissions;
    const runtime = new ToolRuntime({
      tools: definitions,
      hooks: this.#options.hooks,
      permissions,
      ...(agent === "main" && approve !== undefined ? { approve } : {}),
    });
    try {
      const tools = definitions.map(toModelTool);
      const isMain = agent === "main";
      const maxIterations = isMain ? this.#options.maxIterationsMain : this.#options.maxIterationsSubagent;
      const loop = new AgentLoop({
        registry: this.#options.registry,
        modelId,
        context,
        runtime,
        hooks: this.#options.hooks,
        tools,
        agent,
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(isMain && this.#options.hasActiveProgress !== undefined ? { hasActiveProgress: this.#options.hasActiveProgress } : {}),
      });
      return { get modelId() { return loop.modelId; }, context, runtime, tools, loop };
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }
}

function ensureStrictSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema.type !== "object" || typeof schema.properties !== "object" || schema.properties === null) {
    return schema;
  }
  const required: string[] = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const requiredSet = new Set(required);
  const properties: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema.properties)) {
    const child =
      typeof value === "object" && value !== null
        ? ensureStrictSchema(value as Record<string, unknown>)
        : value;
    if (requiredSet.has(key)) {
      properties[key] = child;
    } else {
      // Strict mode requires every property to be in "required".  Wrap optional
      // fields so the model can send null instead of omitting them.
      properties[key] = { anyOf: [child, { type: "null" }] };
      requiredSet.add(key);
    }
  }
  return { ...schema, additionalProperties: false, required: [...requiredSet], properties };
}

function toModelTool(tool: ToolDefinition<unknown>): ModelTool {
  const raw = z.toJSONSchema(tool.inputSchema);
  const schema = ensureStrictSchema(raw as Record<string, unknown>);
  return { name: tool.name, description: tool.description, inputSchema: schema };
}
