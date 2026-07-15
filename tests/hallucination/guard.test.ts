import { describe, expect, it, vi } from "vitest";
import { HallucinationGuard } from "../../src/hallucination/guard.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";

describe("HallucinationGuard", () => {
  it("returns passed=true when confidence is high and no violations", async () => {
    const { guard } = createGuard(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.95, reason: "All good" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]));

    guard.recordToolCall("Read", { path: "/a" });
    guard.recordToolResult("Read", true);

    const report = await guard.evaluate("fix bug", "Bug was fixed");
    expect(report.passed).toBe(true);
    expect(report.confidence?.confidence).toBe(0.95);
    expect(report.retryViolations).toEqual([]);
    expect(report.circuitBreakerTripped).toBe(false);
  });

  it("returns passed=false when confidence is below threshold", async () => {
    const { guard } = createGuard(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.3, reason: "Output looks hallucinated" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]));

    const report = await guard.evaluate("fix critical bug", "I think it might work");
    expect(report.passed).toBe(false);
    expect(report.confidence?.confidence).toBe(0.3);
  });

  it("returns passed=false when retry violations exist", async () => {
    const { guard } = createGuard(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.9, reason: "Seems fine" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]), { maxToolRetries: 2 });

    // Trigger retry violations: 2 failures on same tool
    guard.recordToolCall("Read", { path: "/a" });
    guard.recordToolResult("Read", false, "tool_error");
    guard.recordToolCall("Read", { path: "/a" });
    guard.recordToolResult("Read", false, "tool_error");

    const report = await guard.evaluate("fix bug", "Bug fixed");
    expect(report.passed).toBe(false);
    expect(report.retryViolations).toHaveLength(1);
    expect(report.retryViolations[0]!.toolName).toBe("Read");
  });

  it("returns passed=false when circuit breaker trips", async () => {
    const { guard } = createGuard(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.85, reason: "OK" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]), { windowSize: 3, threshold: 2 });

    // Push same params to trigger sliding window trip
    for (let i = 0; i < 4; i++) {
      guard.recordToolCall("Write", { content: "same" });
      guard.recordToolResult("Write", true);
    }

    const report = await guard.evaluate("write file", "File written");
    expect(report.passed).toBe(false);
    expect(report.circuitBreakerTripped).toBe(true);
  });

  it("skips confidence check when cheap model is unavailable", async () => {
    const registry = new ModelRegistry(); // no cheap model registered
    const guard = new HallucinationGuard({ registry, cheapModelId: "nope:missing" });

    const report = await guard.evaluate("query", "output");
    expect(report.confidence).toBeNull();
    // Without confidence check, violations still matter
    expect(report.passed).toBe(true);
  });

  it("resets state after evaluate", async () => {
    vi.useFakeTimers();
    try {
      const { guard } = createGuard(fakeAdapter([
        [
          { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.9, reason: "ok" } },
          { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
        ],
        [
          { type: "tool-call", id: "c2", name: "flavor_confidence", input: { confidence: 0.95, reason: "still ok" } },
          { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
        ],
      ]), { maxToolRetries: 2 });

      guard.recordToolCall("Read", { path: "/a" });
      guard.recordToolResult("Read", false, "tool_error");

      const promise1 = guard.evaluate("query", "output");
      await vi.runAllTimersAsync();
      await promise1;

      // After evaluate + reset, state should be clean
      guard.recordToolCall("Write", { path: "/b" });
      guard.recordToolResult("Write", true);

      const promise2 = guard.evaluate("query2", "output2");
      await vi.runAllTimersAsync();
      const report = await promise2;
      expect(report.retryViolations).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("records tool call failures correctly", async () => {
    const { guard } = createGuard(fakeAdapter([[
      { type: "tool-call", id: "c1", name: "flavor_confidence", input: { confidence: 0.9, reason: "ok" } },
      { type: "done", usage: { inputTokens: 100, outputTokens: 20 } },
    ]]));

    guard.recordToolCall("Glob", { pattern: "*.ts" });
    guard.recordToolResult("Glob", false, "permission_denied");
    guard.recordToolCall("Glob", { pattern: "*.ts" });
    guard.recordToolResult("Glob", false, "permission_denied");
    guard.recordToolCall("Glob", { pattern: "*.ts" });
    guard.recordToolResult("Glob", false, "permission_denied");

    const report = await guard.evaluate("find files", "no files found");
    expect(report.retryViolations).toHaveLength(1);
    expect(report.retryViolations[0]!.retryCount).toBe(3);
  });
});

function createGuard(adapter: ModelAdapter, config?: { maxToolRetries?: number; windowSize?: number; threshold?: number }) {
  const registry = new ModelRegistry().register("cheap", adapter);
  const guard = new HallucinationGuard({
    registry,
    cheapModelId: "cheap:mini",
    maxToolRetries: config?.maxToolRetries ?? 3,
    ...(config?.windowSize !== undefined ? { windowSize: config.windowSize } : {}),
    ...(config?.threshold !== undefined ? { threshold: config.threshold } : {}),
  });
  return { guard, registry };
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
