import { AgentLoop } from "../agent/loop.js";
import { MAIN_TASK_TOOL_NAMES } from "../agent/task-tools.js";
import type { TaskNode } from "../agent/planner.js";
import type { HallucinationGuard } from "../hallucination/guard.js";
import type { PermissionMode } from "../permissions/engine.js";
import { PermissionEngine } from "../permissions/engine.js";
import type { ContextManager } from "../context/manager.js";
import type { HookBus } from "../hooks/bus.js";
import type { ModelRegistry } from "../models/registry.js";
import type { ModelTool } from "../models/types.js";
import { modelToolFromZod } from "../models/structured.js";
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
    modelId: string,
  ): ContextManager;
  permissionMode?: PermissionMode;
  approve?: ApprovalCallback;
  maxIterationsMain?: number;
  maxIterationsSubagent?: number;
  hasActiveProgress?(): boolean;
  hallucinationGuard?: HallucinationGuard;
  /** When true, non-destructive tools skip the approval callback. Destructive tools still require confirmation. */
  loopMode?: boolean;
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
  readonly #mainDefinitions: ToolDefinition<unknown>[];
  readonly main: HarnessProfile;
  #disposed = false;

  constructor(options: LocalHarnessOptions) {
    this.#options = options;
    this.#subagentModelId = options.subagentModelId;
    const tools = [...this.#toolsForAgent("main")];
    this.#mainDefinitions = tools;
    const context = options.createContext("main", tools, options.mainModelId);
    this.#claimContext(context);
    this.main = this.#createProfile(
      options.mainModelId,
      tools,
      "main",
      context,
      options.approve,
      options.subagentModelId,
    );
  }

  get mainModelId(): string { return this.main.loop.modelId; }
  get subagentModelId(): string { return this.#subagentModelId; }
  get permissionMode(): PermissionMode { return this.#mainPermissions.mode; }

  setModel(role: "main" | "subagent", modelId: string): void {
    this.#options.registry.get(modelId);
    if (role === "main") this.main.loop.setModel(modelId);
    else {
      this.#subagentModelId = modelId;
      this.main.loop.setFallbackModel(modelId);
    }
  }

  setPermissionMode(mode: PermissionMode): void { this.#mainPermissions.setMode(mode); }

  replaceMainTools(definitions: readonly ToolDefinition<unknown>[]): void {
    if (this.#disposed) throw new Error("LocalHarness is disposed");
    const nextDefinitions = definitions.filter((tool) => tool.agents === undefined || tool.agents.includes("main"));
    this.#mainDefinitions.splice(0, this.#mainDefinitions.length, ...nextDefinitions);
    this.main.runtime.replaceTools(this.#mainDefinitions);
    const nextModelTools = this.#mainDefinitions.map(toModelTool);
    const modelTools = this.main.tools as ModelTool[];
    modelTools.splice(0, modelTools.length, ...nextModelTools);
  }

  createSubagent(task: TaskNode): SubagentHarness {
    if (this.#disposed) throw new Error("LocalHarness is disposed");
    const tools = this.#toolsForAgent("subagent").filter((tool) => !MAIN_TASK_TOOL_NAMES.has(tool.name));
    const context = this.#options.createContext("subagent", tools, this.#subagentModelId);
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

  #toolsForAgent(agent: "main" | "subagent"): readonly ToolDefinition<unknown>[] {
    return this.#options.tools.filter((tool) => tool.agents === undefined || tool.agents.includes(agent));
  }

  #createProfile(
    modelId: string,
    definitions: readonly ToolDefinition<unknown>[],
    agent: "main" | "subagent",
    context: ContextManager,
    approve?: ApprovalCallback,
    fallbackModelId?: string,
  ): HarnessProfile {
    const permissions = new PermissionEngine({
      workspace: this.#options.workspace,
      mode: this.#options.loopMode ? "full" : (agent === "subagent" ? "workspace" : (this.#options.permissionMode ?? "workspace")),
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
        ...(fallbackModelId === undefined ? {} : { fallbackModelId }),
        context,
        runtime,
        hooks: this.#options.hooks,
        tools,
        agent,
        ...(maxIterations === undefined ? {} : { maxIterations }),
        ...(isMain && this.#options.hasActiveProgress !== undefined ? { hasActiveProgress: this.#options.hasActiveProgress } : {}),
        ...(isMain && this.#options.hallucinationGuard !== undefined ? { hallucinationGuard: this.#options.hallucinationGuard } : {}),
      });
      return { get modelId() { return loop.modelId; }, context, runtime, tools, loop };
    } catch (error) {
      runtime.dispose();
      throw error;
    }
  }
}

function toModelTool(tool: ToolDefinition<unknown>): ModelTool {
  if (tool.modelInputSchema !== undefined) {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.modelInputSchema,
      ...(tool.modelStrict === undefined ? {} : { strict: tool.modelStrict }),
    };
  }
  const modelTool = modelToolFromZod(tool.name, tool.description, tool.inputSchema);
  return tool.modelStrict === undefined ? modelTool : { ...modelTool, strict: tool.modelStrict };
}
