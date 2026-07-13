import type { z } from "zod";
import type { PermissionRequest } from "../permissions/engine.js";

export type ToolPermissionMetadata = Omit<PermissionRequest, "agent" | "tool">;

export interface FileDiffLine {
  kind: "context" | "removed" | "added" | "omitted";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileChangePresentation {
  kind: "file-change";
  operation: "create" | "update" | "delete";
  path: string;
  added: number;
  removed: number;
  lines: FileDiffLine[];
}

export type ToolPresentation = FileChangePresentation;

const TOOL_PRESENTATION = Symbol("flavor.tool-presentation");

type PresentedOutput = object & { [TOOL_PRESENTATION]?: ToolPresentation };

export function withToolPresentation<T extends object>(output: T, presentation: ToolPresentation): T {
  Object.defineProperty(output, TOOL_PRESENTATION, { value: presentation, enumerable: false });
  return output;
}

export function getToolPresentation(output: unknown): ToolPresentation | undefined {
  return typeof output === "object" && output !== null
    ? (output as PresentedOutput)[TOOL_PRESENTATION]
    : undefined;
}

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
  presentation?: ToolPresentation;
  error?: { code: string; message: string };
}
