import { basename } from "node:path";
import { z } from "zod";

import type { HookBus } from "../hooks/bus.js";
import { type PermissionEngine, type PermissionRequest, getToolCategory, type ToolCategory } from "../permissions/engine.js";
import { getToolPresentation, type ToolCall, type ToolContext, type ToolDefinition, type ToolResult } from "./types.js";
import { message } from "../utils/error.js";

export type ApprovalDecision = "once" | "always" | "deny";

export type ApprovalCallback = (
  request: PermissionRequest & { reason?: string }, signal: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;

export interface ToolRuntimeOptions {
  tools: readonly ToolDefinition<unknown>[];
  hooks: HookBus;
  permissions: PermissionEngine;
  approve?: ApprovalCallback;
  /** Categories that should skip the approval callback. Destructive is never added. */
  alwaysAllowed?: ToolCategory[];
}

export type ToolInputValidation =
  | { ok: true; input: unknown }
  | { ok: false; error: { code: "unknown_tool" | "invalid_input"; message: string } };

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
  readonly #alwaysAllowed: Set<string>;
  readonly #disposeSchemas: Array<() => void>;
  #disposed = false;

  constructor(options: ToolRuntimeOptions) {
    this.#tools = new Map(options.tools.map((tool) => [tool.name, tool]));
    this.#hooks = options.hooks;
    this.#permissions = options.permissions;
    this.#approve = options.approve;
    this.#alwaysAllowed = new Set(options.alwaysAllowed ?? []);
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

  definition(name: string): ToolDefinition<unknown> | undefined {
    return this.#tools.get(name);
  }

  replaceTools(tools: readonly ToolDefinition<unknown>[]): void {
    if (this.#disposed) throw new Error("ToolRuntime is disposed");
    this.#tools.clear();
    for (const tool of tools) this.#tools.set(tool.name, tool);
  }

  validate(call: ToolCall): ToolInputValidation {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) {
      return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${call.name}` } };
    }
    try {
      return { ok: true, input: tool.inputSchema.parse(call.input) };
    } catch (primary) {
      if (typeof call.input !== "string") {
        return { ok: false, error: { code: "invalid_input", message: message(primary) } };
      }
      try {
        return {
          ok: true,
          input: tool.inputSchema.parse(JSON.parse(call.input) as unknown),
        };
      } catch (secondary) {
        return { ok: false, error: { code: "invalid_input", message: message(secondary) } };
      }
    }
  }

  label(call: ToolCall): string | undefined {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) return undefined;
    try {
      const input = tool.inputSchema.parse(call.input);
      const paths = tool.paths(input);
      if (paths.length === 0) return undefined;
      return paths.map((p) => basename(p)).join(", ");
    } catch {
      return undefined;
    }
  }

  hint(call: ToolCall): string | undefined {
    const tool = this.#tools.get(call.name);
    if (tool === undefined || tool.summarize === undefined) return undefined;
    try {
      const input = tool.inputSchema.parse(call.input);
      const value = tool.summarize(input);
      return value === undefined || value === "" ? undefined : value;
    } catch {
      return undefined;
    }
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (tool === undefined) return { ok: false, error: { code: "unknown_tool", message: `Unknown tool: ${call.name}` } };
    const signal = context.signal ?? new AbortController().signal;

    const validation = this.validate(call);
    if (!validation.ok) {
      return this.#fail(call.name, call.input, context.agent, validation.error.code, validation.error.message);
    }
    let input = validation.input;

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

        // When a PermissionRequest hook handler explicitly approves:
        // - "allow"        → skip the prompt for this call only (like typing "y")
        // - "allow all"    → persist for the session (like typing "a")
        if (this.#hooks.hasListeners("PermissionRequest") && requestDecision.decision === "allow") {
          const ctx = requestDecision.additionalContext ?? "";
          if (ctx.includes("codeisland:allow-all")) {
            const category = getToolCategory(tool.name);
            if (category !== "destructive") this.#alwaysAllowed.add(category);
          }
        } else if (context.agent !== "main") {
          return this.#fail(tool.name, input, context.agent, "approval_required", reason);
        } else if (signal.aborted) {
          throw signal.reason;
        } else {
          // Check if this tool's category has been always-allowed for this session.
          const category = getToolCategory(tool.name);
          if (this.#alwaysAllowed.has(category)) {
            // Skip the approval callback — already authorized for this tool type.
          } else if (this.#approve === undefined) {
            return this.#fail(tool.name, input, context.agent, "permission_denied", reason);
          } else {
            const decision = await this.#approve({ ...request, reason }, signal);
            if (decision === "deny") {
              return this.#fail(tool.name, input, context.agent, "permission_denied", reason);
            }
            if (decision === "always" && category !== "destructive") {
              this.#alwaysAllowed.add(category);
            }
          }
        }
      }

      if (signal.aborted) throw signal.reason;
      const output = await tool.execute(input, signal);
      await this.#hooks.emit({
        version: 1, type: "PostToolUse", payload: { tool: tool.name, input, agent: context.agent, output },
      });
      const presentation = getToolPresentation(output);
      return { ok: true, output, ...(presentation === undefined ? {} : { presentation }) };
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
