import { describe, expect, it } from "vitest";

import { summarizeWithModel } from "../../src/context/summarizer.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelMessage, ModelRequest } from "../../src/models/types.js";

describe("summarizeWithModel", () => {
  it("uses the current model for a one-turn no-tools structured summary", async () => {
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      async *stream(request) {
        requests.push(request);
        yield { type: "text", text: "<analysis>draft</analysis><summary>structured result</summary>" };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    const registry = new ModelRegistry().register("fake", adapter);

    const result = await summarizeWithModel({
      registry,
      modelId: () => "fake:current",
      messages: [{ role: "user", content: "history" }],
    });

    expect(result).toBe("structured result");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe("current");
    expect(requests[0]?.tools).toEqual([]);
    expect(requests[0]?.messages.at(-1)?.content).toContain("Respond with TEXT ONLY");
    expect(requests[0]?.messages.at(-1)?.content).toContain("Optional Next Step");
  });

  it("advances summary streaming progress in ten-percent steps capped at eighty", async () => {
    const adapter: ModelAdapter = {
      async *stream() {
        yield { type: "text", text: "<summary>" };
        yield { type: "text", text: "structured " };
        yield { type: "text", text: "result</summary>" };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 3 } };
      },
    };
    const progress: number[] = [];

    await summarizeWithModel({
      registry: new ModelRegistry().register("fake", adapter),
      modelId: () => "fake:current",
      messages: [{ role: "user", content: "history" }],
      onProgress: (percentage) => { progress.push(percentage); },
    });

    expect(progress).toEqual([20, 30, 40, 50, 80]);
  });

  it("reports compaction model usage exactly once per attempt", async () => {
    const adapter: ModelAdapter = {
      async *stream() {
        yield { type: "usage", inputTokens: 12, outputTokens: 3 };
        yield { type: "done", usage: { inputTokens: 12, outputTokens: 3 } };
      },
    };
    const usage: Array<{ inputTokens: number; outputTokens: number }> = [];

    await expect(summarizeWithModel({
      registry: new ModelRegistry().register("fake", adapter),
      modelId: () => "fake:model",
      messages: [{ role: "user", content: "history" }],
      onUsage: (item) => usage.push(item),
    })).rejects.toThrow(/empty/i);

    expect(usage).toEqual([{ inputTokens: 12, outputTokens: 3 }]);
  });

  it("drops oldest complete API rounds and succeeds on the third PTL attempt", async () => {
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
      async *stream(request) {
        requests.push(request);
        if (requests.length < 3) {
          yield { type: "error", error: { code: "context_overflow", message: "prompt too long" } };
          return;
        }
        yield { type: "text", text: "<summary>recovered</summary>" };
        yield { type: "done", usage: { inputTokens: 10, outputTokens: 2 } };
      },
    };
    const messages: ModelMessage[] = [
      { role: "user", content: "oldest" },
      { role: "assistant", content: "older reply" },
      { role: "user", content: "recent" },
      { role: "assistant", content: "latest reply" },
    ];

    const result = await summarizeWithModel({
      registry: new ModelRegistry().register("fake", adapter),
      modelId: () => "fake:model",
      messages,
      maxPromptTooLongAttempts: 3,
    });

    expect(result).toBe("recovered");
    expect(requests).toHaveLength(3);
    expect(requests[0]!.messages.length).toBeGreaterThan(requests[1]!.messages.length);
    expect(requests[1]!.messages.length).toBeGreaterThan(requests[2]!.messages.length);
    expect(messages.map((message) => message.content)).toEqual(["oldest", "older reply", "recent", "latest reply"]);
  });

  it("stops after the configured PTL attempt limit", async () => {
    let requests = 0;
    const adapter: ModelAdapter = {
      async *stream() {
        requests += 1;
        yield { type: "error", error: { code: "context_overflow", message: "still too long" } };
      },
    };

    await expect(summarizeWithModel({
      registry: new ModelRegistry().register("fake", adapter),
      modelId: () => "fake:model",
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "assistant", content: "three" },
      ],
      maxPromptTooLongAttempts: 3,
    })).rejects.toMatchObject({ code: "context_overflow" });
    expect(requests).toBe(3);
  });

  it("does not retry non-overflow errors and rejects empty responses", async () => {
    let failures = 0;
    const failing: ModelAdapter = {
      async *stream() {
        failures += 1;
        yield { type: "error", error: { code: "rate_limit", message: "slow down" } };
      },
    };
    await expect(summarizeWithModel({
      registry: new ModelRegistry().register("fake", failing),
      modelId: () => "fake:model",
      messages: [{ role: "user", content: "history" }],
    })).rejects.toMatchObject({ code: "rate_limit" });
    expect(failures).toBe(1);

    const empty: ModelAdapter = { async *stream() { yield { type: "done", usage: { inputTokens: 1, outputTokens: 0 } }; } };
    await expect(summarizeWithModel({
      registry: new ModelRegistry().register("empty", empty),
      modelId: () => "empty:model",
      messages: [{ role: "user", content: "history" }],
    })).rejects.toThrow(/empty/i);
  });
});
