import { z } from "zod";

import type { HookBus } from "../hooks/bus.js";
import type { PermissionEngine, PermissionRequest } from "../permissions/engine.js";
import type { ToolCall, ToolContext, ToolDefinition, ToolResult } from "./types.js";

export type ApprovalCallback = (request: PermissionRequest & { reason?: string }) => boolean | Promise<boolean>;

export interface ToolRuntimeOptions {
  tools: readonly ToolDefinition<unknown>[];
  hooks: HookBus;
  permissions: PermissionEngine;
  approve?: ApprovalCallback;
}

const PreToolUsePayload = z.object({
  tool: z.string(),
  input: z.unknown(),
  agent: z.enum(["main", "subagent"]),
});
const PermissionRequestPayload = PreToolUsePayload.extend({ reason: z.string().optional() });
const PostToolUsePayload = PreToolUsePayload.extend({ output: z.unknown() });
const PostToolUseFailurePayload = PreToolUsePayload.extend({
  error: z.object({ code: z.string(), message: z.string() }),
});

export class ToolRuntime {
  readonly #tools: Map<string, ToolDefinition<unknown>>;
  readonly #hooks: HookBus;
  readonly #permissions: PermissionEngine;
  readonly #approve: ApprovalCallback | undefined;
  readonly #disposeSchemas: Array<() => void>;
  #disposed = false;

  constructor(options: ToolRuntimeOptions) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#hooks = options.hooks;
    this.#permissions = options.permissions;
    this.#approve = options.approve;
    this.#disposeSchemas = [
      this.#hooks.registerPayloadSchema("PreToolUse", PreToolUsePayload),
      this.#hooks.registerPayloadSchema("PermissionRequest", PermissionRequestPayload),
      this.#hooks.registerPayloadSchema("PostToolUse", PostToolUsePayload),
      this.#hooks.registerPayloadSchema("PostToolUseFailure", PostToolUseFailurePayload),
    ];
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const dispose of this.#disposeSchemas) dispose();
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${call.name}` } };

    let input: unknown;
    try {
      input = tool.inputSchema.parse(call.input);
    } catch (error) {
      return this.#fail(call.name, call.input, context.agent, "invalid_input", message(error));
    }

    try {
      const pre = await this.#hooks.emit({
        version: 1, type: "PreToolUse", payload: { tool: tool.name, input, agent: context.agent },
      });
      if (pre.updatedInput !== undefined) {
        const payload = PreToolUsePayload.parse(pre.updatedInput);
        if (payload.tool !== tool.name || payload.agent !== context.agent) {
          return this.#fail(tool.name, input, context.agent, "invalid_input", "PreToolUse cannot change the tool or agent");
        }
        try { input = tool.inputSchema.parse(payload.input); }
        catch (error) { return this.#fail(tool.name, payload.input, context.agent, "invalid_input", message(error)); }
      }
      if (pre.decision === "deny") {
        return this.#fail(tool.name, input, context.agent, "hook_denied", pre.reason ?? "Tool use denied by hook");
      }

      const request: PermissionRequest = {
        agent: context.agent,
        tool: tool.name,
        ...(tool.permissions?.(input) ?? { paths: tool.paths(input) }),
      };
      const permission = this.#permissions.decide(request);
      if (permission.decision === "deny") {
        return this.#fail(tool.name, input, context.agent, "permission_denied", permission.reason ?? "Tool use denied");
      }
      if (pre.decision === "ask" || permission.decision === "ask") {
        const reason = [pre.reason, permission.reason].filter((value): value is string => value !== undefined).join("\n") || "Approval required";
        const requestDecision = await this.#hooks.emit({
          version: 1,
          type: "PermissionRequest",
          payload: { tool: tool.name, input, agent: context.agent, reason },
        });
        if (requestDecision.decision === "deny") {
          return this.#fail(tool.name, input, context.agent, "permission_denied", requestDecision.reason ?? "Permission request denied");
        }
        if (requestDecision.updatedInput !== undefined) {
          return this.#fail(tool.name, input, context.agent, "invalid_input", "PermissionRequest cannot modify an already-authorized tool call");
        }
        if (context.agent !== "main") {
          return this.#fail(tool.name, input, context.agent, "approval_required", reason);
        }
        if (this.#approve === undefined || !(await this.#approve({ ...request, reason }))) {
          return this.#fail(tool.name, input, context.agent, "permission_denied", reason);
        }
      }

      const signal = context.signal ?? new AbortController().signal;
      if (signal.aborted) throw signal.reason;
      const output = await tool.execute(input, signal);
      await this.#hooks.emit({
        version: 1, type: "PostToolUse", payload: { tool: tool.name, input, agent: context.agent, output },
      });
      return { ok: true, output };
    } catch (error) {
      return this.#fail(tool.name, input, context.agent, "tool_error", message(error));
    }
  }

  async #fail(tool: string, input: unknown, agent: ToolContext["agent"], code: string, errorMessage: string): Promise<ToolResult> {
    const result: ToolResult = { ok: false, error: { code, message: errorMessage } };
    try {
      await this.#hooks.emit({
        version: 1, type: "PostToolUseFailure", payload: { tool, input, agent, error: result.error },
      });
    } catch {
      // Preserve the original tool failure when a failure-reporting hook also fails.
    }
    return result;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
