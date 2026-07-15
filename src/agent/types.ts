import type { ProviderErrorCode } from "../models/types.js";
import type { ToolResult } from "../tools/types.js";
import type { TaskGraph } from "./planner.js";
import type { SubagentState } from "./subagents.js";
import type { TaskPlan } from "./task-plan.js";

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

export interface TaskSnapshot {
  plan?: TaskPlan;
  subagents: {
    graph?: TaskGraph;
    states: Record<string, SubagentState>;
    /** Unix-ms timestamp captured when each subagent transitioned to "running". */
    startedAt?: Record<string, number>;
    /** Frozen elapsed-ms captured when each subagent reached a terminal state. */
    elapsedMs?: Record<string, number>;
  };
  foregroundTaskId?: string;
}

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown; label?: string; hint?: string }
  | { type: "tool-end"; id: string; name: string; result: ToolResult; label?: string; hint?: string }
  | { type: "tasks"; snapshot: TaskSnapshot }
  | { type: "usage"; inputTokens: number; outputTokens: number; totalInputTokens: number; totalOutputTokens: number }
  | { type: "model-retry"; attempt: number; maxAttempts: number; delayMs: number }
  | { type: "compact-progress"; progress: number }
  | { type: "compacted" }
  | { type: "warning"; message: string }
  | { type: "limit_reached"; iteration: number; maxIterations: number; extended: boolean }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } }
  | { type: "error"; error: AgentError };
