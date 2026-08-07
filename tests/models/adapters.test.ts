import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AnthropicModelAdapter,
  type AnthropicClient,
} from "../../src/models/anthropic.js";
import { OpenAIModelAdapter, type OpenAIClient } from "../../src/models/openai.js";
import { normalizeProviderError } from "../../src/models/types.js";
import type { ModelEvent, ModelRequest } from "../../src/models/types.js";
import { setUsageSession } from "../../src/utils/log.js";

const signal = new AbortController().signal;
const imageRoots: string[] = [];
let usageRoot: string | undefined;
let previousUsageFile: string | undefined;

beforeEach(() => {
  usageRoot = undefined;
  previousUsageFile = process.env.FLAVOR_USAGE_FILE;
});

afterEach(async () => {
  await Promise.all(imageRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  if (usageRoot !== undefined) {
    await rm(usageRoot, { recursive: true, force: true });
  }
  if (previousUsageFile === undefined) {
    delete process.env.FLAVOR_USAGE_FILE;
  } else {
    process.env.FLAVOR_USAGE_FILE = previousUsageFile;
  }
});

async function usageLogFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-usage-"));
  usageRoot = root;
  process.env.FLAVOR_USAGE_FILE = join(root, "usage.jsonl");
  return process.env.FLAVOR_USAGE_FILE;
}

async function imageFile(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-adapter-image-"));
  imageRoots.push(root);
  const path = join(root, "screen.png");
  await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return path;
}
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
  it("maps local image blocks to OpenAI Responses input images", async () => {
    const path = await imageFile();
    const stream = vi.fn(() => events());
    const client = { responses: { stream } };

    await collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream({
      ...request,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot" },
          {
            type: "image", source: { type: "file", path }, mediaType: "image/png",
            sha256: "unused-in-adapter-test", bytes: 8, name: "screen.png",
          },
        ],
      }],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      input: [{
        role: "user",
        content: [
          { type: "input_text", text: "Inspect this screenshot" },
          {
            type: "input_image",
            image_url: "data:image/png;base64,iVBORw0KGgo=",
            detail: "auto",
          },
        ],
      }],
    }), { signal });
  });

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
      {
        type: "usage",
        inputTokens: 4,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        type: "done",
        usage: { inputTokens: 4, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
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

  it("keeps OpenAI automatic caching input free of provider-neutral metadata", async () => {
    const stream = vi.fn(() => events());
    const client = { responses: { stream } };

    await collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream({
      ...request,
      messages: [
        { role: "system", content: "shared system" },
        { role: "user", content: "shared history", cacheBreakpoint: true },
        { role: "user", content: "child directive" },
      ],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      input: [
        { role: "system", content: "shared system" },
        { role: "user", content: "shared history" },
        { role: "user", content: "child directive" },
      ],
    }), { signal });
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
      { type: "usage", inputTokens: 6, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
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
      { type: "usage", inputTokens: 8, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0 },
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

  it("logs OpenAI cache breakdown when debugUsage is enabled", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usagePath = await usageLogFile();
    const client = {
      responses: {
        stream: () => events({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 50,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 150 },
            },
          },
        }),
      },
    };

    await collect(
      new OpenAIModelAdapter({ client: asOpenAIClient(client), debugUsage: true }).stream(request),
    );

    const logged = stderr.mock.calls.map(([line]) => String(line)).join("");
    expect(logged).toContain('"event":"flavor-usage"');
    expect(logged).toContain('"cacheReadTokens":150');
    expect(logged).toContain('"cacheHitRatio":0.75');

    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"event":"flavor-usage"');
      expect(content).toContain('"provider":"openai"');
    });
    stderr.mockRestore();
  });

  it("keeps stderr silent but still writes the usage file when debugUsage is disabled", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usagePath = await usageLogFile();
    const client = {
      responses: {
        stream: () => events({
          type: "response.completed",
          response: { usage: { input_tokens: 50, output_tokens: 5 } },
        }),
      },
    };

    await collect(
      new OpenAIModelAdapter({ client: asOpenAIClient(client), debugUsage: false }).stream(request),
    );

    expect(stderr).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"event":"flavor-usage"');
      expect(content).toContain('"provider":"openai"');
    });
    stderr.mockRestore();
  });

  it("carries Responses cache tokens into usage and done events", async () => {
    const client = {
      responses: {
        stream: () => events({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 50,
              output_tokens: 5,
              input_tokens_details: { cached_tokens: 150 },
            },
          },
        }),
      },
    };

    await expect(
      collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request)),
    ).resolves.toEqual([
      {
        type: "usage",
        inputTokens: 50,
        outputTokens: 5,
        cacheReadTokens: 150,
        cacheCreationTokens: 0,
      },
      {
        type: "done",
        usage: {
          inputTokens: 50,
          outputTokens: 5,
          cacheReadTokens: 150,
          cacheCreationTokens: 0,
        },
      },
    ]);
  });

  it("carries DeepSeek-style cache tokens into usage and done events", async () => {
    const client = {
      responses: {
        stream: () => events({
          type: "response.completed",
          response: {
            usage: {
              input_tokens: 120,
              output_tokens: 4,
              prompt_cache_hit_tokens: 100,
              prompt_cache_miss_tokens: 20,
            },
          },
        }),
      },
    };

    await expect(
      collect(new OpenAIModelAdapter({ client: asOpenAIClient(client) }).stream(request)),
    ).resolves.toEqual([
      {
        type: "usage",
        inputTokens: 120,
        outputTokens: 4,
        cacheReadTokens: 100,
        cacheCreationTokens: 20,
      },
      {
        type: "done",
        usage: {
          inputTokens: 120,
          outputTokens: 4,
          cacheReadTokens: 100,
          cacheCreationTokens: 20,
        },
      },
    ]);
  });
});

describe("AnthropicModelAdapter", () => {
  it("maps local image blocks to Anthropic base64 image sources", async () => {
    const path = await imageFile();
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };

    await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream({
      ...request,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot" },
          {
            type: "image", source: { type: "file", path }, mediaType: "image/png",
            sha256: "unused-in-adapter-test", bytes: 8, name: "screen.png",
          },
        ],
      }],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot" },
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      }],
    }), { signal });
  });

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
      {
        type: "usage",
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      },
      {
        type: "done",
        usage: { inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
      },
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
      { type: "usage", inputTokens: 5, outputTokens: 4096, cacheReadTokens: 0, cacheCreationTokens: 0 },
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
    expect(output[1]).toEqual({ type: "usage", inputTokens: 5, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 });
    expect(output[2]).toEqual({ type: "done", usage: { inputTokens: 5, outputTokens: 12, cacheReadTokens: 0, cacheCreationTokens: 0 } });
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
      { type: "usage", inputTokens: 5, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
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
      { type: "usage", inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 2 },
      { type: "done", usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 2 } },
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
      { type: "usage", inputTokens: 11, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 2 },
      { type: "done", usage: { inputTokens: 11, outputTokens: 2, cacheReadTokens: 4, cacheCreationTokens: 2 } },
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
              {
                type: "tool_result",
                tool_use_id: "t2",
                content: "rainy",
                cache_control: { type: "ephemeral" },
              },
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
            content: [{
              type: "tool_result",
              tool_use_id: "tool_7",
              content: "sunny",
              cache_control: { type: "ephemeral" },
            }],
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

  it("maps a fork cache boundary to the exact Anthropic content block", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };
    const mappingRequest: ModelRequest = {
      ...request,
      messages: [
        { role: "system", content: "shared system" },
        { role: "user", content: "shared parent history", cacheBreakpoint: true },
        { role: "user", content: "child-only directive" },
      ],
    };

    await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(mappingRequest));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      system: "shared system",
      messages: [
        {
          role: "user",
          content: [{
            type: "text",
            text: "shared parent history",
            cache_control: { type: "ephemeral" },
          }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "child-only directive", cache_control: { type: "ephemeral" } }],
        },
      ],
    }), { signal });
  });

  it("supports an Anthropic cache boundary on a system-only fork", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };

    await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream({
      ...request,
      messages: [
        { role: "system", content: "first" },
        { role: "system", content: "last shared system", cacheBreakpoint: true },
        { role: "user", content: "child directive" },
      ],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      system: [
        { type: "text", text: "first" },
        { type: "text", text: "last shared system", cache_control: { type: "ephemeral" } },
      ],
    }), { signal });
  });

  it("adds a rolling cache marker to the final message of the conversation", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };

    await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream({
      ...request,
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first reply" },
        { role: "user", content: "second turn" },
      ],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      messages: [
        { role: "user", content: "first turn" },
        { role: "assistant", content: "first reply" },
        {
          role: "user",
          content: [{ type: "text", text: "second turn", cache_control: { type: "ephemeral" } }],
        },
      ],
    }), { signal });
  });

  it("evicts the least valuable marker to keep the rolling marker within the provider cap", async () => {
    const stream = vi.fn(() => events());
    const client = { messages: { create: stream } };

    await collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream({
      ...request,
      messages: [
        { role: "system", content: "s1", cacheBreakpoint: true },
        { role: "system", content: "s2", cacheBreakpoint: true },
        { role: "system", content: "s3", cacheBreakpoint: true },
        { role: "user", content: "history", cacheBreakpoint: true },
        { role: "assistant", content: "reply" },
        { role: "user", content: "latest" },
      ],
    }));

    expect(stream).toHaveBeenCalledWith(expect.objectContaining({
      system: [
        { type: "text", text: "s1", cache_control: { type: "ephemeral" } },
        { type: "text", text: "s2", cache_control: { type: "ephemeral" } },
        { type: "text", text: "s3" },
      ],
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "history", cache_control: { type: "ephemeral" } }],
        },
        { role: "assistant", content: "reply" },
        {
          role: "user",
          content: [{ type: "text", text: "latest", cache_control: { type: "ephemeral" } }],
        },
      ],
    }), { signal });
  });

  it("logs Anthropic cache breakdown when debugUsage is enabled", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usagePath = await usageLogFile();
    const client = {
      messages: {
        create: () =>
          events(
            {
              type: "message_start",
              message: {
                usage: {
                  input_tokens: 100,
                  cache_creation_input_tokens: 100,
                  cache_read_input_tokens: 200,
                  output_tokens: 0,
                },
              },
            },
            { type: "message_delta", delta: {}, usage: { output_tokens: 5 } },
            { type: "message_stop" },
          ),
      },
    };

    await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client), debugUsage: true }).stream(request),
    );

    const logged = stderr.mock.calls.map(([line]) => String(line)).join("");
    expect(logged).toContain('"event":"flavor-usage"');
    expect(logged).toContain('"sessionId"');
    expect(logged).toContain('"provider":"anthropic"');
    expect(logged).toContain('"cacheReadTokens":200');
    expect(logged).toContain('"cacheCreationTokens":100');
    expect(logged).toContain('"cacheHitRatio":0.5');

    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"provider":"anthropic"');
      expect(content).toContain('"cacheReadTokens":200');
    });
    stderr.mockRestore();
  });

  it("keeps stderr silent but still writes the usage file when debugUsage is disabled", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usagePath = await usageLogFile();
    const client = {
      messages: {
        create: () =>
          events(
            { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ),
      },
    };

    await collect(
      new AnthropicModelAdapter({ client: asAnthropicClient(client), debugUsage: false }).stream(request),
    );

    expect(stderr).not.toHaveBeenCalled();
    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"event":"flavor-usage"');
      expect(content).toContain('"provider":"anthropic"');
    });
    stderr.mockRestore();
  });

  it("tags usage lines with the session and overwrites the log when a new session starts", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const usagePath = await usageLogFile();
    const client = {
      messages: {
        create: () =>
          events(
            { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
            { type: "message_stop" },
          ),
      },
    };
    const adapter = new AnthropicModelAdapter({ client: asAnthropicClient(client) });

    setUsageSession("session-first");
    await collect(adapter.stream(request));
    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"sessionId":"session-first"');
    });

    setUsageSession("session-second");
    await collect(adapter.stream(request));
    await vi.waitFor(async () => {
      const content = await readFile(usagePath, "utf8").catch(() => "");
      expect(content).toContain('"sessionId":"session-second"');
      expect(content).not.toContain('"sessionId":"session-first"');
    });
    setUsageSession("unknown");
    stderr.mockRestore();
  });

  it("carries cache read and creation tokens into usage and done events", async () => {
    const client = {
      messages: {
        create: () => events(
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
          { type: "message_delta", delta: {}, usage: { output_tokens: 2 } },
          { type: "message_stop" },
        ),
      },
    };

    await expect(
      collect(new AnthropicModelAdapter({ client: asAnthropicClient(client) }).stream(request)),
    ).resolves.toEqual([
      {
        type: "usage",
        inputTokens: 10,
        outputTokens: 2,
        cacheReadTokens: 3,
        cacheCreationTokens: 2,
      },
      {
        type: "done",
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cacheReadTokens: 3,
          cacheCreationTokens: 2,
        },
      },
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
