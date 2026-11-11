import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAIModelAdapter } from "../../src/models/openai.js";
import type { ModelEvent, ModelRequest } from "../../src/models/types.js";

const request: ModelRequest = {
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const created = {
  type: "response.created",
  sequence_number: 0,
  response: {
    id: "resp_1", object: "response", created_at: 1,
    status: "in_progress", model: request.model, output: [],
  },
};

const metadata = {
  type: "response.metadata",
  sequence_number: 5,
  response_id: "resp_1",
  metadata: {
    openai_chatgpt_moderation_metadata: {
      prompt: { omnimod: { outputs: [{ is_blocked: false }] } },
      generation: {}, tool_call: {}, tool_response: {}, commentary: {},
    },
  },
};

function mockSSE(events: readonly Record<string, unknown>[]) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(
    events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "Content-Type": "text/event-stream" } },
  ));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

async function collect(overrides: Partial<ModelRequest> = {}): Promise<ModelEvent[]> {
  const adapter = new OpenAIModelAdapter({ apiKey: "test-key", baseURL: "https://gateway.example.test/v1" });
  const output: ModelEvent[] = [];
  for await (const event of adapter.stream({ ...request, ...overrides })) output.push(event);
  return output;
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAI SDK streaming transport", () => {
  it("continues text, tool calls and usage across metadata and future extension events", async () => {
    const message = {
      type: "message", id: "msg_1", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "Hello world", annotations: [] }],
    };
    const call = {
      type: "function_call", id: "fc_1", call_id: "call_1", name: "weather",
      arguments: '{"city":"Paris"}', status: "completed",
    };
    const fetch = mockSSE([
      created,
      { type: "response.output_item.added", output_index: 0,
        item: { ...message, status: "in_progress", content: [] } },
      { type: "response.content_part.added", item_id: "msg_1", output_index: 0,
        content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "Hello" },
      metadata,
      { type: "response.future_extension", sequence_number: 6, response_id: "resp_1" },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: " world" },
      { type: "response.output_item.done", output_index: 0, item: message },
      { type: "response.output_item.added", output_index: 1,
        item: { ...call, arguments: "", status: "in_progress" } },
      { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 1,
        name: call.name, arguments: call.arguments },
      { type: "response.output_item.done", output_index: 1, item: call },
      { type: "response.completed", response: {
        ...created.response, status: "completed", output: [message, call],
        usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7,
          input_tokens_details: { cached_tokens: 1 } },
      } },
    ]);

    expect(await collect()).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
      { type: "tool-call", id: "call_1", name: "weather", input: { city: "Paris" } },
      { type: "usage", inputTokens: 4, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 },
      { type: "done", usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 } },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe("https://gateway.example.test/v1/responses");
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      model: request.model, stream: true, reasoning: { effort: "high", summary: "auto" },
    });
  });

  it.each([
    {
      name: "provider errors",
      terminal: { type: "error", code: "rate_limit_exceeded", message: "slow down" },
      error: { code: "rate_limit", message: "slow down" },
    },
    {
      name: "failed responses",
      terminal: { type: "response.failed", response: {
        ...created.response, status: "failed", error: { code: "server_error", message: "failed" },
      } },
      error: { code: "unknown", message: "failed" },
    },
    {
      name: "incomplete responses",
      terminal: { type: "response.incomplete", response: {
        ...created.response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      } },
      error: { code: "output_limit", message: "Response incomplete: max_output_tokens; raise maxOutputTokens for this provider" },
    },
  ])("preserves $name after metadata", async ({ terminal, error }) => {
    mockSSE([created, metadata, terminal]);
    const output = await collect();
    expect(output.at(-1)).toEqual({ type: "error", error });
    expect(output.some((event) => event.type === "done")).toBe(false);
  });

  it("reports an early end after metadata instead of marking the response complete", async () => {
    mockSSE([created, metadata]);
    expect(await collect()).toEqual([
      { type: "error", error: { code: "incomplete_stream", message: "OpenAI response stream ended before completion" } },
    ]);
  });

  it("preserves cancellation when the raw SDK stream ends after an abort", async () => {
    const controller = new AbortController();
    mockSSE([
      created,
      { type: "response.output_item.added", output_index: 0, item: {
        type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [],
      } },
      { type: "response.content_part.added", item_id: "msg_1", output_index: 0,
        content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
      { type: "response.output_text.delta", item_id: "msg_1", output_index: 0, content_index: 0, delta: "partial" },
    ]);
    const adapter = new OpenAIModelAdapter({ apiKey: "test-key", baseURL: "https://gateway.example.test/v1" });
    const output: ModelEvent[] = [];
    for await (const event of adapter.stream({ ...request, signal: controller.signal })) {
      output.push(event);
      if (event.type === "text") controller.abort();
    }
    expect(output).toEqual([
      { type: "text", text: "partial" },
      { type: "error", error: { code: "cancelled", message: "Request was aborted." } },
    ]);
  });
});
