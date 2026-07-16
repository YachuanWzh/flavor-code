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

  it("preserves malformed OpenAI tool arguments for structured repair", async () => {
    const raw = String.raw`{"path":"C:\Users\wangzh"}`;
    const client = {
      responses: {
        stream: () => events(
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", call_id: "call_bad", name: "weather" },
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            name: "weather",
            arguments: raw,
          },
          {
            type: "response.completed",
            response: { usage: { input_tokens: 4, output_tokens: 3 } },
          },
        ),
      },
    };

    const output = await collect(
      new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request),
    );

    expect(output).toContainEqual(expect.objectContaining({
      type: "invalid-tool-call",
      id: "call_bad",
      name: "weather",
      rawInput: raw,
      error: expect.objectContaining({ code: "invalid_tool_arguments" }),
    }));
    expect(output).not.toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "unknown" }),
    }));
  });

  it("honors non-strict schemas for externally supplied tools", async () => {
    const stream = vi.fn(() => events());
    const client = { responses: { stream } };

    await collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream({
      ...request,
      tools: [{ ...request.tools[0]!, strict: false }],
    }));

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [expect.objectContaining({ name: "weather", strict: false })],
      }),
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

  it("preserves response usage before a failed response error", async () => {
    const client = { responses: { stream: () => events({
      type: "response.failed",
      response: { usage: { input_tokens: 8, output_tokens: 3 }, error: { message: "failed" } },
    }) } };
    await expect(collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request))).resolves.toEqual([
      { type: "usage", inputTokens: 8, outputTokens: 3 },
      { type: "error", error: { code: "unknown", message: "failed" } },
    ]);
  });

  it("maps tool results and function schemas to the Responses request", async () => {
    const stream = vi.fn(() => events());
    const client = { responses: { stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "system", content: "rules" },
        { role: "assistant", content: "checking", toolCalls: [{ id: "call_7", name: "weather", input: { city: "Paris" } }] },
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
          { type: "function_call", call_id: "call_7", name: "weather", arguments: "{\"city\":\"Paris\"}" },
          { type: "function_call_output", call_id: "call_7", output: "sunny" },
        ],
        tools: [
          {
            type: "function",
            name: "weather",
            description: "Get weather",
            parameters: request.tools[0]?.inputSchema,
            strict: true,
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
    const client = { messages: { create: stream } };

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
      expect.objectContaining({ model: "example-model", max_tokens: 32_768 }),
      { signal },
    );
  });

  it("preserves Anthropic tool arguments with invalid escapes before SDK snapshot parsing", async () => {
    const raw = String.raw`{"path":"C:\Users\wangzh"}`;
    const client = {
      messages: {
        create: () => events(
          { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "tool_use", id: "tool_bad", name: "weather", input: {} },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: raw },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
            usage: { output_tokens: 4 },
          },
          { type: "message_stop" },
        ),
      },
    };

    const output = await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request),
    );

    expect(output).toContainEqual(expect.objectContaining({
      type: "invalid-tool-call",
      id: "tool_bad",
      name: "weather",
      rawInput: raw,
      error: expect.objectContaining({ code: "invalid_tool_arguments" }),
    }));
    expect(output).not.toContainEqual(expect.objectContaining({
      type: "error",
      error: expect.objectContaining({ code: "unknown" }),
    }));
  });

  it("does not emit a truncated tool call when the provider reaches max_tokens", async () => {
    const client = {
      messages: {
        create: () =>
          events(
            { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tool_1", name: "weather", input: {} },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "max_tokens", stop_sequence: null },
              usage: { output_tokens: 4096 },
            },
            { type: "message_stop" },
          ),
      },
    };

    await expect(
      collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request)),
    ).resolves.toEqual([
      { type: "usage", inputTokens: 5, outputTokens: 4096 },
      {
        type: "error",
        error: {
          code: "output_limit",
          message: "Provider stopped at the 32768-token output limit; incomplete tool calls were discarded",
        },
      },
    ]);
  });

  it("reports malformed tool-call JSON instead of normalizing it to an empty object", async () => {
    const client = {
      messages: {
        create: () =>
          events(
            { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
            {
              type: "content_block_start",
              index: 1,
              content_block: { type: "tool_use", id: "tool_1", name: "weather", input: {} },
            },
            {
              type: "content_block_delta",
              index: 1,
              delta: { type: "input_json_delta", partial_json: '{"city":"Par' },
            },
            { type: "content_block_stop", index: 1 },
            {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 12 },
            },
            { type: "message_stop" },
          ),
      },
    };

    const output = await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request),
    );

    expect(output).toHaveLength(3);
    expect(output[0]).toMatchObject({
      type: "invalid-tool-call",
      id: "tool_1",
      name: "weather",
      error: {
        code: "invalid_tool_arguments",
        message: expect.stringContaining('Invalid tool-call input for "weather"'),
      },
    });
    expect(output[1]).toEqual({ type: "usage", inputTokens: 5, outputTokens: 12 });
    expect(output[2]).toEqual({ type: "done", usage: { inputTokens: 5, outputTokens: 12 } });
    expect(output).not.toContainEqual(expect.objectContaining({ type: "tool-call", input: {} }));
  });

  it("uses a configured Anthropic output token limit", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };

    await collect(
      new AnthropicModelAdapter({
        client: asAnthropicClient(client),
        maxOutputTokens: 65_536,
      }).stream(request),
    );

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({ max_tokens: 65_536 }),
      { signal },
    );
  });

  it("normalizes rejected SDK streams without throwing provider-specific errors", async () => {
    const client = {
      messages: {
        create: () => {
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

  it("emits accumulated usage before an Anthropic stream error", async () => {
    const client = { messages: { create: () => (async function* () {
      yield { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } };
      yield { type: "message_delta", delta: {}, usage: { output_tokens: 2 } };
      throw new Error("stream broke");
    })() } };
    await expect(collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request))).resolves.toEqual([
      { type: "usage", inputTokens: 5, outputTokens: 2 },
      { type: "error", error: { code: "unknown", message: "stream broke" } },
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
        create: () =>
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
        create: () =>
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

  it("merges consecutive tool messages into a single user message", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "assistant", content: "", toolCalls: [
          { id: "t1", name: "weather", input: { city: "Paris" } },
          { id: "t2", name: "weather", input: { city: "London" } },
        ]},
        { role: "tool", toolCallId: "t1", content: "sunny" },
        { role: "tool", toolCallId: "t2", content: "rainy" },
      ],
    };

    await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(mappingRequest),
    );

    expect(stream).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "weather", input: { city: "Paris" } },
              { type: "tool_use", id: "t2", name: "weather", input: { city: "London" } },
            ],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "sunny" },
              { type: "tool_result", tool_use_id: "t2", content: "rainy" },
            ],
          },
        ],
      }),
      { signal },
    );
  });

  it("maps system prompts and tool results to the Messages request", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "second" },
        { role: "assistant", content: "checking", toolCalls: [{ id: "tool_7", name: "weather", input: { city: "Paris" } }] },
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
          {
            role: "assistant",
            content: [
              { type: "text", text: "checking" },
              { type: "tool_use", id: "tool_7", name: "weather", input: { city: "Paris" } },
            ],
          },
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
