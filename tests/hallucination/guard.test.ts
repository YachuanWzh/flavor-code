import { describe, expect, it, vi } from "vitest";
import { HallucinationGuard } from "../../src/hallucination/guard.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";

describe("HallucinationGuard", () => {
  it("passes a high-confidence run without warnings", async () => {
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.95), doneEvent()]]));
    guard.recordToolCall("Read", { path: "/a" });
    guard.recordToolResult("Read", true);

    const report = await guard.evaluate("fix bug", "Bug was fixed");

    expect(report).toMatchObject({
      passed: true,
      evaluationStatus: "completed",
      warnings: [],
      blockingReasons: [],
    });
    expect(report.confidence?.confidence).toBeCloseTo(0.95);
  });

  it("keeps a low LLM score advisory", async () => {
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.3, "Output is unsupported"), doneEvent()]]));

    const report = await guard.evaluate("fix critical bug", "I think it might work");

    expect(report.passed).toBe(true);
    expect(report.evaluationStatus).toBe("completed");
    expect(report.confidence?.confidence).toBeCloseTo(0.3);
    expect(report.warnings).toHaveLength(1);
    expect(report.warnings[0]).toContain("0.30");
    expect(report.blockingReasons).toEqual([]);
  });

  it("blocks deterministic retry violations with a reason", async () => {
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.9), doneEvent()]]), {
      maxToolRetries: 2,
    });
    for (let index = 0; index < 2; index += 1) {
      guard.recordToolCall("Read", { path: "/a" });
      guard.recordToolResult("Read", false, "tool_error");
    }

    const report = await guard.evaluate("fix bug", "Bug fixed");

    expect(report.passed).toBe(false);
    expect(report.retryViolations).toHaveLength(1);
    expect(report.blockingReasons[0]).toContain("Read");
  });

  it("blocks a deterministic circuit breaker with a reason", async () => {
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.9), doneEvent()]]), {
      windowSize: 3,
      threshold: 2,
    });
    for (let index = 0; index < 3; index += 1) {
      guard.recordToolCall("Write", { content: "same" });
      guard.recordToolResult("Write", true);
    }

    const report = await guard.evaluate("write file", "File written");

    expect(report.passed).toBe(false);
    expect(report.circuitBreakerTripped).toBe(true);
    expect(report.blockingReasons[0]).toContain("Write");
  });

  it("reports an unavailable scorer without blocking", async () => {
    const registry = new ModelRegistry();
    const guard = new HallucinationGuard({ registry, cheapModelId: "nope:missing" });

    const report = await guard.evaluate("query", "output");

    expect(report).toMatchObject({
      confidence: null,
      evaluationStatus: "unavailable",
      passed: true,
      warnings: [],
    });
  });

  it("skips the scorer when warnings are disabled but keeps deterministic reasons", async () => {
    const requests: ModelRequest[] = [];
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.9), doneEvent()]], requests), {
      showWarnings: false,
      maxToolRetries: 1,
    });
    guard.recordToolCall("Read", { path: "/a" });
    guard.recordToolResult("Read", false, "denied");

    const report = await guard.evaluate("query", "output");

    expect(requests).toHaveLength(0);
    expect(report.evaluationStatus).toBe("skipped");
    expect(report.passed).toBe(false);
    expect(report.warnings).toEqual([]);
    expect(report.blockingReasons[0]).toContain("Read");
  });

  it("fails open with timeout status and resets state", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ModelRegistry().register("cheap", {
        async *stream(request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
          });
        },
      });
      const guard = new HallucinationGuard({
        registry,
        cheapModelId: "cheap:mini",
        evaluationTimeoutMs: 500,
        maxToolRetries: 2,
      });
      guard.recordToolCall("Read", { path: "/a" });
      guard.recordToolResult("Read", false, "tool_error");

      const pending = guard.evaluate("query", "output");
      await vi.advanceTimersByTimeAsync(500);
      const report = await pending;
      expect(report).toMatchObject({
        confidence: null,
        evaluationStatus: "timeout",
        passed: true,
        warnings: [],
      });

      guard.recordToolCall("Write", { path: "/b" });
      guard.recordToolResult("Write", true);
      guard.reset();
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes full tool outcomes and call IDs into scoring evidence", async () => {
    const requests: ModelRequest[] = [];
    const { guard } = createGuard(fakeAdapter([[scoreEvent(0.9), doneEvent()]], requests));
    guard.recordToolCall("Read", { path: "src/a.ts" }, "read-1");
    guard.recordToolResult("Read", { ok: false, error: { code: "missing", message: "no file" } }, "read-1");
    guard.recordToolCall("Shell", { command: "Get-Content src/a.ts" }, "shell-1");
    guard.recordToolResult("Shell", { ok: true, output: "fallback success" }, "shell-1");

    await guard.evaluate("read the file", "done");

    const prompt = requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(prompt).toMatch(/read-1[\s\S]*missing[\s\S]*shell-1[\s\S]*fallback success/);
  });
});

interface GuardTestConfig {
  maxToolRetries?: number;
  windowSize?: number;
  threshold?: number;
  showWarnings?: boolean;
}

function createGuard(adapter: ModelAdapter, config: GuardTestConfig = {}) {
  const registry = new ModelRegistry().register("cheap", adapter);
  const guard = new HallucinationGuard({
    registry,
    cheapModelId: "cheap:mini",
    maxToolRetries: config.maxToolRetries ?? 3,
    ...(config.windowSize === undefined ? {} : { windowSize: config.windowSize }),
    ...(config.threshold === undefined ? {} : { threshold: config.threshold }),
    ...(config.showWarnings === undefined ? {} : { showWarnings: config.showWarnings }),
  });
  return { guard, registry };
}

function scoreEvent(score: number, reason = "grounded"): ModelEvent {
  return {
    type: "tool-call",
    id: "score",
    name: "flavor_confidence",
    input: {
      taskAlignment: score,
      evidenceGrounding: score,
      processReliability: score,
      reason,
      unsupportedClaims: score < 0.7 ? ["unsupported result"] : [],
    },
  };
}

function doneEvent(): ModelEvent {
  return { type: "done", usage: { inputTokens: 100, outputTokens: 20 } };
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
