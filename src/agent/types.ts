import type { ModelMessage, ProviderErrorCode } from "../models/types.js";
import type { ToolResult } from "../tools/types.js";
import type { TaskGraph } from "./planner.js";
import type { SubagentState } from "./subagents.js";
import type { TaskPlan } from "./task-plan.js";

export interface AgentRunRequest {
  prompt: string;
  /** Optional rich initial user message. Text-only routing continues to use prompt. */
  initialUserMessage?: Extract<ModelMessage, { role: "user" }>;
  signal?: AbortSignal;
  /** Prompt-scoped system context, such as a matched skill body. It is never stored. */
  additionalContext?: string;
  /** Messages supplied while a tool batch is running, injected before the next model call. */
  getSteeringMessages?(): readonly string[];
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

export interface TurnDeliverable {
  path: string;
  operation: "create" | "update" | "delete";
  added: number;
  removed: number;
}

export type AgentEvent =
  | { type: "model-start"; id: string }
  | { type: "model-end"; id: string }
  | { type: "text"; text: string }
  | { type: "tool-start"; id: string; name: string; input: unknown; label?: string; hint?: string; presentation?: import("../tools/types.js").ToolPresentation }
  | { type: "tool-end"; id: string; name: string; result: ToolResult; label?: string; hint?: string }
  | { type: "tasks"; snapshot: TaskSnapshot }
  | { type: "tasks-cleared" }
  | { type: "deliverables"; files: readonly TurnDeliverable[] }
  | {
    type: "usage";
    inputTokens: number;
    outputTokens: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }
  | { type: "model-retry"; attempt: number; maxAttempts: number; delayMs: number }
  | {
    type: "structured-output-retry";
    tool: string;
    modelId: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    error: string;
  }
  | {
    type: "loop-progress";
    loopId: string;
    phase: "resolved" | "cycle" | "verification" | "budget" | "terminal";
    state: "running" | "completed" | "failed" | "cancelled" | "info";
    message: string;
  }
  | { type: "compact-progress"; progress: number }
  | { type: "compacted" }
  | { type: "notice"; message: string }
  | { type: "warning"; message: string }
  | { type: "limit_reached"; iteration: number; maxIterations: number; extended: boolean }
  | {
    type: "done";
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
  }
  | { type: "error"; error: AgentError };
