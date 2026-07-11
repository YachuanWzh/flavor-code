import type { ProviderErrorCode } from "../models/types.js";
import type { ToolResult } from "../tools/types.js";

export interface AgentRunRequest {
  prompt: string;
  signal?: AbortSignal;
  /** Prompt-scoped system context, such as a matched skill body. It is never stored. */
  additionalContext?: string;
}

export type AgentErrorCode = ProviderErrorCode | "iteration_limit" | "incomplete_stream";

export interface AgentError {
  code: AgentErrorCode;
  message: string;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown }
  | { type: "tool-end"; id: string; name: string; result: ToolResult }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalInputTokens: number; totalOutputTokens: number }
  | { type: "compacted" }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; error: AgentError };
