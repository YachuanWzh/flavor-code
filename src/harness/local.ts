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
}

export class LocalHarness {
  readonly #options: LocalHarnessOptions;
  readonly main: HarnessProfile;

  constructor(options: LocalHarnessOptions) {
    this.#options = options;
    this.main = this.#createProfile(options.mainModelId, options.tools, "main", options.createContext(), options.approve);
  }

  createSubagent(task: TaskNode): SubagentHarness {
    const tools = this.#options.tools.filter((tool) => tool.name !== "Task");
    return {
      ...this.#createProfile(this.#options.subagentModelId, tools, "subagent", this.#options.createContext()),
      task,
    };
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
