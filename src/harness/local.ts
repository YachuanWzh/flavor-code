import { AgentLoop } from "../agent/loop.js";
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
  createContext(): ContextManager;
  permissionMode?: PermissionMode;
  approve?: ApprovalCallback;
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
  readonly #contexts = new WeakSet<ContextManager>();
  readonly #children = new Set<SubagentHarness>();
  readonly main: HarnessProfile;

  constructor(options: LocalHarnessOptions) {
    this.#options = options;
    const context = options.createContext();
    this.#claimContext(context);
    this.main = this.#createProfile(options.mainModelId, options.tools, "main", context, options.approve);
  }

  createSubagent(task: TaskNode): SubagentHarness {
    const tools = this.#options.tools.filter((tool) => tool.name !== "Task");
    const context = this.#options.createContext();
    this.#claimContext(context);
    const profile = this.#createProfile(this.#options.subagentModelId, tools, "subagent", context);
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
    const child = this.createSubagent(task);
    try {
      signal.throwIfAborted();
      return await execute(child, signal);
    } finally {
      await child[Symbol.asyncDispose]();
    }
  }

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
    const runtime = new ToolRuntime({
      tools: definitions,
      hooks: this.#options.hooks,
      permissions,
      ...(agent === "main" && approve !== undefined ? { approve } : {}),
    });
    const tools = definitions.map(toModelTool);
    const loop = new AgentLoop({
      registry: this.#options.registry,
      modelId,
      context,
      runtime,
      hooks: this.#options.hooks,
      tools,
      agent,
    });
    return { modelId, context, runtime, tools, loop };
  }
}

function toModelTool(tool: ToolDefinition<unknown>): ModelTool {
  return { name: tool.name, description: tool.description, inputSchema: { ...z.toJSONSchema(tool.inputSchema) } };
}
