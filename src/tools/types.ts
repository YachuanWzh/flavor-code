import type { z } from "zod";
import type { PermissionRequest } from "../permissions/engine.js";

export type ToolPermissionMetadata = Omit<PermissionRequest, "agent" | "tool">;

export interface ToolDefinition<T> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  paths(input: T): string[];
  permissions?(input: T): ToolPermissionMetadata;
  execute(input: T, signal: AbortSignal): Promise<unknown>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ToolContext {
  agent: "main" | "subagent";
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
}
