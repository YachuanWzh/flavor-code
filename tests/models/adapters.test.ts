import { describe, expect, it, vi } from "vitest";

import { AnthropicModelAdapter } from "../../src/models/anthropic.js";
import { OpenAIModelAdapter } from "../../src/models/openai.js";
import { normalizeProviderError } from "../../src/models/types.js";
import type { ModelEvent, ModelRequest } from "../../src/models/types.js";

const request: ModelRequest = {
  model: "example-model",
  messages: [{ role: "user", content: "hello" }],
  tools: [
    {
      name: "weather",
      description: "Get weather",
      inputSchema: { type: "object", properties: { city: { type: "string" } } },
    },
  ],
};

async function* events(...values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("OpenAIModelAdapter", () => {
  it("normalizes Responses API text, tool calls, usage, and completion", async () => {
    const stream = vi.fn(() =>
      events(
        { type: "response.output_text.delta", delta: "Hello" },
        {
          type: "response.output_item.added",
          item: { type: "function_call", id: "item_1", call_id: "call_1", name: "weather" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "item_1",
          name: "weather",
          arguments: '{"city":"Paris"}',
        },
        {
          type: "response.completed",
          response: { usage: { input_tokens: 4, output_tokens: 3 } },
        },
      ),
    );
    const client = { responses: { stream } };

    const output = await collect(new OpenAIModelAdapter({ client }).stream(request));

    expect(output).toEqual([
      { type: "text", text: "Hello" },
      {
        type: "tool-call",
        id: "call_1",
        name: "weather",
        input: { city: "Paris" },
      },
      { type: "usage", inputTokens: 4, outputTokens: 3 },
      { type: "done", usage: { inputTokens: 4, outputTokens: 3 } },
    ]);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "example-model", input: request.messages }),
      expect.anything(),
    );
  });

  it("turns provider stream errors into stable error events", async () => {
    const client = {
      responses: {
        stream: () => events({ type: "error", code: "rate_limit_exceeded", message: "slow down" }),
      },
    };

    await expect(collect(new OpenAIModelAdapter({ client }).stream(request))).resolves.toEqual([
      { type: "error", error: { code: "rate_limit", message: "slow down" } },
    ]);
  });
});

describe("AnthropicModelAdapter", () => {
  it("accumulates content block JSON and normalizes text, usage, and completion", async () => {
    const stream = vi.fn(() =>
      events(
        { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "tool_1", name: "weather", input: {} },
        },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"city":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"Paris"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
        { type: "message_stop" },
      ),
    );
    const client = { messages: { stream } };

    const output = await collect(new AnthropicModelAdapter({ client }).stream(request));

    expect(output).toEqual([
      { type: "text", text: "Hi" },
      {
        type: "tool-call",
        id: "tool_1",
        name: "weather",
        input: { city: "Paris" },
      },
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "done", usage: { inputTokens: 5, outputTokens: 2 } },
    ]);
    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ model: "example-model", max_tokens: 4096 }),
      expect.anything(),
    );
  });

  it("normalizes rejected SDK streams without throwing provider-specific errors", async () => {
    const client = {
      messages: {
        stream: () => {
          throw Object.assign(new Error("bad key"), { status: 401 });
        },
      },
    };

    await expect(collect(new AnthropicModelAdapter({ client }).stream(request))).resolves.toEqual([
      { type: "error", error: { code: "authentication", message: "bad key" } },
    ]);
  });
});

describe("normalizeProviderError", () => {
  it.each([
    [{ status: 401, message: "bad key" }, "authentication"],
    [{ status: 429, message: "slow" }, "rate_limit"],
    [{ status: 404, message: "model not found" }, "model_not_found"],
    [{ code: "context_length_exceeded", message: "too long" }, "context_overflow"],
    [{ name: "AbortError", message: "aborted" }, "cancelled"],
    [{ code: "ECONNRESET", message: "socket" }, "network"],
    [{ message: "surprise" }, "unknown"],
  ])("maps %o to %s", (error, code) => {
    expect(normalizeProviderError(error).code).toBe(code);
  });
});
