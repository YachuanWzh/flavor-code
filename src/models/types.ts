export type ModelImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export interface ModelTextContentBlock {
  type: "text";
  text: string;
}

export interface ModelImageContentBlock {
  type: "image";
  source: { type: "file"; path: string };
  mediaType: ModelImageMediaType;
  sha256: string;
  bytes: number;
  name?: string | undefined;
}

export type ModelContentBlock = ModelTextContentBlock | ModelImageContentBlock;
export type ModelContent = string | ModelContentBlock[];

interface ModelMessageMetadata {
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  /** Provider-neutral marker for the end of a byte-stable reusable prompt prefix. */
  cacheBreakpoint?: boolean;
}

export type ModelMessage =
  | (ModelMessageMetadata & { role: "user"; content: ModelContent })
  | (ModelMessageMetadata & { role: "system" | "assistant" | "tool"; content: string });

export function modelContentText(content: ModelContent): string {
  if (typeof content === "string") return content;
  return content
    .filter((block): block is ModelTextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function modelContentTranscriptText(content: ModelContent): string {
  if (typeof content === "string") return content;
  let image = 0;
  return content.map((block) => block.type === "text"
    ? block.text
    : `[Image #${++image}]`).filter(Boolean).join("\n");
}

export function cloneModelContent(content: ModelContent): ModelContent {
  if (typeof content === "string") return content;
  return content.map((block) => block.type === "text"
    ? { ...block }
    : { ...block, source: { ...block.source } });
}

export interface ModelToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  strict?: boolean;
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools: ModelTool[];
  signal?: AbortSignal;
}

export type ProviderErrorCode =
  | "authentication"
  | "rate_limit"
  | "context_overflow"
  | "output_limit"
  | "model_not_found"
  | "network"
  | "cancelled"
  | "invalid_tool_arguments"
  | "structured_output_error"
  | "unknown";

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
}

export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | {
    type: "invalid-tool-call";
    id: string;
    name: string;
    rawInput: string;
    error: ProviderError;
  }
  | {
    type: "usage";
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  }
  | { type: "error"; error: ProviderError }
  | {
    type: "done";
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    };
  };

export interface ModelAdapter {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

interface ErrorLike {
  status?: unknown;
  code?: unknown;
  type?: unknown;
  name?: unknown;
  message?: unknown;
}

export function normalizeProviderError(error: unknown): ProviderError {
  const value: ErrorLike =
    typeof error === "object" && error !== null ? error : { message: String(error) };
  const status = typeof value.status === "number" ? value.status : undefined;
  const providerCode = [value.code, value.type]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  const message =
    typeof value.message === "string" ? value.message : "Unknown provider error";
  const searchable = `${providerCode} ${message}`.toLowerCase();

  let code: ProviderErrorCode = "unknown";
  if (value.name === "AbortError" || searchable.includes("abort") || searchable.includes("cancel")) {
    code = "cancelled";
  } else if (status === 401 || status === 403 || /auth|api.?key|unauthorized/.test(searchable)) {
    code = "authentication";
  } else if (status === 429 || /rate.?limit|overloaded/.test(searchable)) {
    code = "rate_limit";
  } else if (/context|too many tokens|prompt.*long/.test(searchable)) {
    code = "context_overflow";
  } else if (status === 404 || /model.*not.?found|not.?found.*model/.test(searchable)) {
    code = "model_not_found";
  } else if (status !== undefined && status >= 500 && status <= 599) {
    code = "network";
  } else if (
    status === undefined &&
    /econn|enet|socket|network|fetch failed|connection|timeout/.test(searchable)
  ) {
    code = "network";
  }

  return { code, message };
}
