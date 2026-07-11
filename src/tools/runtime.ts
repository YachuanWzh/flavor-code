import { z } from "zod";

import type { HookBus } from "../hooks/bus.js";
import type { PermissionDecision, PermissionEngine, PermissionRequest } from "../permissions/engine.js";
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

  constructor(options: ToolRuntimeOptions) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#hooks = options.hooks;
    this.#permissions = options.permissions;
    this.#approve = options.approve;
    this.#hooks.registerPayloadSchema("PreToolUse", PreToolUsePayload);
    this.#hooks.registerPayloadSchema("PermissionRequest", PermissionRequestPayload);
    this.#hooks.registerPayloadSchema("PostToolUse", PostToolUsePayload);
    this.#hooks.registerPayloadSchema("PostToolUseFailure", PostToolUseFailurePayload);
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
      if (pre.decision === "ask" && !(await this.#requestApproval(tool, input, context, pre.reason))) {
        return this.#fail(tool.name, input, context.agent, context.agent === "main" ? "permission_denied" : "approval_required", pre.reason ?? "Approval required");
      }

      const request: PermissionRequest = { agent: context.agent, tool: tool.name, paths: tool.paths(input) };
      const permission = this.#permissions.decide(request);
      if (!(await this.#allowed(permission, request, input, context))) {
        const code = permission.decision === "ask" && context.agent === "subagent" ? "approval_required" : "permission_denied";
        return this.#fail(tool.name, input, context.agent, code, permission.reason ?? "Tool use denied");
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

  async #allowed(decision: PermissionDecision, request: PermissionRequest, input: unknown, context: ToolContext): Promise<boolean> {
    if (decision.decision === "allow") return true;
    if (decision.decision === "deny") return false;
    return this.#requestApproval(this.#tools.get(request.tool)!, input, context, decision.reason, request);
  }

  async #requestApproval(
    tool: ToolDefinition<unknown>, input: unknown, context: ToolContext, reason?: string, existing?: PermissionRequest,
  ): Promise<boolean> {
    await this.#hooks.emit({
      version: 1,
      type: "PermissionRequest",
      payload: { tool: tool.name, input, agent: context.agent, ...(reason === undefined ? {} : { reason }) },
    });
    if (context.agent !== "main" || this.#approve === undefined) return false;
    const request = existing ?? { agent: context.agent, tool: tool.name, paths: tool.paths(input) };
    return this.#approve({ ...request, ...(reason === undefined ? {} : { reason }) });
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
