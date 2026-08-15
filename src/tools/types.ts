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
  /** Additional files changed by the same atomic multi-file operation. */
  relatedChanges?: readonly FileChangePresentation[];
}

export interface ChangeSetPresentation {
  kind: "changeset";
  files: readonly {
    path: string;
    operation: "create" | "update" | "delete";
    added: number;
    removed: number;
  }[];
}

export interface GenericToolPresentation {
  kind: "generic";
  title: string;
  summary?: string;
  details?: string;
}

export interface TerminalToolPresentation {
  kind: "terminal";
  variant?: "command" | "terminal";
  title: string;
  command?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  state?: "running" | "completed" | "failed" | "cancelled";
  truncated?: boolean;
}

export interface WebToolPresentation {
  kind: "web";
  title: string;
  url?: string;
  summary?: string;
  items?: readonly { title: string; url: string; snippet?: string }[];
}

export interface JobToolPresentation {
  kind: "job";
  action: "start" | "list" | "read" | "wait" | "kill";
  id?: string;
  jobKind?: string;
  label?: string;
  state?: "running" | "completed" | "failed" | "cancelled";
  exitCode?: number | null;
  error?: string;
  output?: string;
  cursor?: number;
  truncated?: boolean;
  jobs?: readonly {
    id: string;
    kind: string;
    label: string;
    state: "running" | "completed" | "failed" | "cancelled";
    exitCode?: number | null;
  }[];
}

export type ToolPresentation = ChangeSetPresentation | FileChangePresentation | GenericToolPresentation | TerminalToolPresentation | WebToolPresentation | JobToolPresentation;

const TOOL_PRESENTATION = Symbol("flavor.tool-presentation");

type PresentedOutput = object & { [TOOL_PRESENTATION]?: ToolPresentation };

export function withToolPresentation<T extends object>(output: T, presentation: ToolPresentation): T {
  Object.defineProperty(output, TOOL_PRESENTATION, { value: presentation, enumerable: false });
  return output;
}

export function getToolPresentation(output: unknown): FileChangePresentation | undefined {
  return typeof output === "object" && output !== null
    ? (output as PresentedOutput)[TOOL_PRESENTATION] as FileChangePresentation | undefined
    : undefined;
}

export interface ToolDefinition<T, O = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  /** Optional validation for the canonical value produced by execute. */
  outputSchema?: z.ZodType<O>;
  /** Restrict a tool to selected agent roles. Omit to expose it to both roles. */
  agents?: readonly ToolContext["agent"][];
  /** Optional provider-facing JSON Schema when it must differ from runtime validation. */
  modelInputSchema?: Record<string, unknown>;
  /** Whether providers should enforce strict function arguments. Defaults to true. */
  modelStrict?: boolean;
  /** Declared read-only: allowed without approval, same as Read/Glob/Grep (including plan mode). */
  readOnly?: boolean;
  paths(input: T): string[];
  /**
   * Optional short human-readable parameter summary, rendered dimmed next to the tool name.
   * Must return plain text (no ANSI escapes). Return undefined or an empty string to omit the hint.
   */
  summarize?(input: T): string | undefined;
  /** Stable, model-facing serialization. Runtime output budgets are applied to this text. */
  renderForModel?(output: O, input: T): string;
  /** Renderer-neutral presentation available as soon as the call starts. */
  presentCall?(input: T): ToolPresentation | undefined;
  /** Renderer-neutral presentation of a completed call. */
  presentResult?(output: O, input: T): ToolPresentation | undefined;
  permissions?(input: T): ToolPermissionMetadata;
  /** Sanitized input shown to PermissionRequest hooks; omit raw secrets/content. */
  permissionInput?(input: T): unknown;
  execute(input: T, signal: AbortSignal, context?: ToolContext): Promise<O>;
}

export interface ToolCall {
  name: string;
  input: unknown;
}

export interface ToolContext {
  agent: "main" | "subagent";
  ownerId?: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  output?: unknown;
  /** Bounded model-facing content when the tool opts into the standard protocol. */
  content?: string;
  presentation?: ToolPresentation;
  /** Context discovered as a consequence of this successful call. */
  additionalContext?: readonly string[];
  error?: { code: string; message: string };
}
