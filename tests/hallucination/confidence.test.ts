import { describe, expect, it, vi } from "vitest";
import { confidenceCheck } from "../../src/hallucination/confidence.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";

describe("confidenceCheck", () => {
  it("returns high confidence when cheap model confirms task completion", async () => {
    const registry = registryWith(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.95, reason: "All tasks match the query" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]));

    const result = await confidenceCheck(registry, "cheap:mini", "fix the bug", "The bug was fixed by updating line 42.");
    expect(result.confidence).toBe(0.95);
    expect(result.reason).toBe("All tasks match the query");
  });

  it("returns low confidence when cheap model detects mismatch", async () => {
    const registry = registryWith(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.25, reason: "Output addresses a different file than requested" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]));

    const result = await confidenceCheck(registry, "cheap:mini", "fix login bug", "I updated the README.");
    expect(result.confidence).toBe(0.25);
    expect(result.reason).toBe("Output addresses a different file than requested");
  });

  it("clamps confidence to 0-1 range", async () => {
    vi.useFakeTimers();
    try {
      const registry = registryWith(fakeAdapter([[
        { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 1.5, reason: "overconfident" } },
        { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
      ]]));

      const promise = confidenceCheck(registry, "cheap:mini", "query", "output");
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.confidence).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles repair retry and returns final result", async () => {
    vi.useFakeTimers();
    try {
      const requests: ModelRequest[] = [];
      const registry = registryWith(fakeAdapter([
        [
          { type: "invalid-tool-call", id: "c1", name: "flavor_confidence", rawInput: "{bad", error: { code: "invalid_tool_arguments", message: "bad JSON" } },
          { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
        ],
        [
          { type: "tool-call", id: "c2", name: "flavor_confidence", input: { confidence: 0.8, reason: "good after repair" } },
          { type: "done", usage: { inputTokens: 150, outputTokens: 30 } },
        ],
      ], requests));

      const promise = confidenceCheck(registry, "cheap:mini", "query", "output");
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.confidence).toBe(0.8);
      expect(result.reason).toBe("good after repair");
      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws when all repair attempts fail", async () => {
    vi.useFakeTimers();
    try {
      const registry = registryWith(fakeAdapter([
        [{ type: "invalid-tool-call", id: "c1", name: "flavor_confidence", rawInput: "{bad", error: { code: "invalid_tool_arguments", message: "bad 1" } }, { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
        [{ type: "invalid-tool-call", id: "c2", name: "flavor_confidence", rawInput: "{bad", error: { code: "invalid_tool_arguments", message: "bad 2" } }, { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
        [{ type: "invalid-tool-call", id: "c3", name: "flavor_confidence", rawInput: "{bad", error: { code: "invalid_tool_arguments", message: "bad 3" } }, { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
        [{ type: "invalid-tool-call", id: "c4", name: "flavor_confidence", rawInput: "{bad", error: { code: "invalid_tool_arguments", message: "bad 4" } }, { type: "done", usage: { inputTokens: 100, outputTokens: 20 } }],
      ]));

      const promise = confidenceCheck(registry, "cheap:mini", "query", "output");
      await vi.runAllTimersAsync();
      await expect(promise).rejects.toThrow("Confidence check failed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("truncates long input to reasonable size", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.5, reason: "ok" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]], requests));

    const longOutput = "x".repeat(20_000);
    const result = await confidenceCheck(registry, "cheap:mini", "query", longOutput);
    const content = requests[0]?.messages.find((m) => m.role === "user")?.content ?? "";
    expect(content.length).toBeLessThan(longOutput.length + 500); // truncated
    expect(result.confidence).toBe(0.5);
  });
});

function registryWith(adapter: ModelAdapter): ModelRegistry {
  return new ModelRegistry().register("cheap", adapter);
}

function fakeAdapter(streams: ModelEvent[][], requests: ModelRequest[] = []): ModelAdapter {
  let index = 0;
  return {
    async *stream(request) {
      requests.push(request);
      for (const event of streams[index++] ?? []) yield event;
    },
  };
}
