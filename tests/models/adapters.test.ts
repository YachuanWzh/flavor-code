import { describe, expect, it, vi } from "vitest";

import {
  AnthropicModelAdapter,
  type AnthropicClient,
} from "../../src/models/anthropic.js";
import { OpenAIModelAdapter, type OpenAIClient } from "../../src/models/openai.js";
import { normalizeProviderError } from "../../src/models/types.js";
import type { ModelEvent, ModelRequest } from "../../src/models/types.js";

const signal = new AbortController().signal;
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
  signal,
};

async function* events(...values: unknown[]): AsyncIterable<unknown> {
  yield* values;
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

function asOpenAIClient(client: unknown): OpenAIClient {
  return client as OpenAIClient;
}

function asAnthropicClient(client: unknown): AnthropicClient {
  return client as AnthropicClient;
}

describe("OpenAIModelAdapter", () => {
  it("normalizes Responses API text, tool calls, usage, and completion", async () => {
    const stream = vi.fn(() =>
      events(
        { type: "response.output_text.delta", delta: "Hello" },
        {
          type: "response.output_item.added",
          output_index: 1,
          item: { type: "function_call", call_id: "call_1", name: "weather" },
        },
        {
          type: "response.function_call_arguments.done",
          item_id: "item_1",
          output_index: 1,
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

    const output = await collect(
      new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request),
    );

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
      { signal },
    );
  });

  it("turns provider stream errors into stable error events", async () => {
    const client = {
      responses: {
        stream: () => events({ type: "error", code: "rate_limit_exceeded", message: "slow down" }),
      },
    };

    await expect(
      collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "error", error: { code: "rate_limit", message: "slow down" } },
    ]);
  });

  it("preserves usage and emits a terminal error for incomplete responses", async () => {
    const client = {
      responses: {
        stream: () =>
          events({
            type: "response.incomplete",
            response: {
              usage: { input_tokens: 6, output_tokens: 7 },
              incomplete_details: { reason: "max_output_tokens" },
            },
          }),
      },
    };

    await expect(
      collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "usage", inputTokens: 6, outputTokens: 7 },
      {
        type: "error",
        error: { code: "unknown", message: "Response incomplete: max_output_tokens" },
      },
    ]);
  });

  it("maps tool results and function schemas to the Responses request", async () => {
    const stream = vi.fn(() => events());
    const client = { responses: { stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "system", content: "rules" },
        { role: "assistant", content: "checking" },
        { role: "tool", toolCallId: "call_7", content: "sunny" },
      ],
    };

    await collect(
      new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(mappingRequest),
    );

    expect(stream).toHaveBeenCalledWith(
      {
        model: "example-model",
        input: [
          { role: "system", content: "rules" },
          { role: "assistant", content: "checking" },
          { type: "function_call_output", call_id: "call_7", output: "sunny" },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Get weather",
            parameters: request.tools[0]?.inputSchema,
            strict: false,
          },
        ],
      },
      { signal },
    );
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

    const output = await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request),
    );

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
      { signal },
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

    await expect(
      collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "error", error: { code: "authentication", message: "bad key" } },
    ]);
  });

  it("includes cumulative cache tokens in input usage without double counting snapshots", async () => {
    const cumulativeUsage = {
      input_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 2,
    };
    const client = {
      messages: {
        stream: () =>
          events(
            { type: "message_start", message: { usage: cumulativeUsage } },
            { type: "message_delta", delta: {}, usage: cumulativeUsage },
            { type: "message_stop" },
          ),
      },
    };

    await expect(
      collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "usage", inputTokens: 10, outputTokens: 2 },
      { type: "done", usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
  });

  it("retains prior cumulative input components when a later snapshot contains nulls", async () => {
    const client = {
      messages: {
        stream: () =>
          events(
            {
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 5,
                  cache_creation_input_tokens: 2,
                  cache_read_input_tokens: 3,
                  output_tokens: 0,
                },
              },
            },
            {
              type: "message_delta",
              delta: {},
              usage: {
                input_tokens: null,
                cache_creation_input_tokens: null,
                cache_read_input_tokens: 4,
                output_tokens: 2,
              },
            },
            { type: "message_stop" },
          ),
      },
    };

    await expect(
      collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "usage", inputTokens: 11, outputTokens: 2 },
      { type: "done", usage: { inputTokens: 11, outputTokens: 2 } },
    ]);
  });

  it("maps system prompts and tool results to the Messages request", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
        { role: "assistant", content: "checking" },
        { role: "tool", toolCallId: "tool_7", content: "sunny" },
      ],
    };

    await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(mappingRequest),
    );

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        system: "first\n\nsecond",
        messages: [
          { role: "assistant", content: "checking" },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_7", content: "sunny" }],
          },
        ],
        tools: [
          {
            name: "weather",
            description: "Get weather",
            input_schema: request.tools[0]?.inputSchema,
          },
        ],
      }),
      { signal },
    );
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
