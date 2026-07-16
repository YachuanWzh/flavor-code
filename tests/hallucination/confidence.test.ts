import { describe, expect, it, vi } from "vitest";
import {
  confidenceCheck,
  HallucinationEvaluationTimeoutError,
} from "../../src/hallucination/confidence.js";
import type { EvidenceSnapshot } from "../../src/hallucination/evidence-ledger.js";
import { ModelRegistry } from "../../src/models/registry.js";
import type { ModelAdapter, ModelEvent, ModelRequest } from "../../src/models/types.js";

describe("confidenceCheck", () => {
  it("computes a weighted score from task, evidence, and process dimensions", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      scoreEvent({ taskAlignment: 0.9, evidenceGrounding: 0.8, processReliability: 0.7 }),
      doneEvent(),
    ]], requests));

    const result = await confidenceCheck(
      registry,
      "cheap:mini",
      "read src/a.ts",
      "Read completed through a fallback.",
      { evidence: fallbackEvidence() },
    );

    expect(result.confidence).toBeCloseTo(0.82);
    expect(result.scores).toEqual({
      taskAlignment: 0.9,
      evidenceGrounding: 0.8,
      processReliability: 0.7,
    });
    expect(result.unsupportedClaims).toEqual([]);
    const content = requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(content).toContain("Execution evidence:");
    expect(content).toMatch(/Read[\s\S]*missing[\s\S]*Shell[\s\S]*success/);
  });

  it("clamps each component before computing confidence", async () => {
    const registry = registryWith(fakeAdapter([[
      scoreEvent({ taskAlignment: 1.5, evidenceGrounding: -1, processReliability: 0.5 }),
      doneEvent(),
    ]]));

    const result = await confidenceCheck(registry, "cheap:mini", "query", "output");

    expect(result.scores).toEqual({
      taskAlignment: 1,
      evidenceGrounding: 0,
      processReliability: 0.5,
    });
    expect(result.confidence).toBeCloseTo(0.5);
  });

  it("keeps both the head and tail of a long final output", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      scoreEvent({ taskAlignment: 1, evidenceGrounding: 1, processReliability: 1 }),
      doneEvent(),
    ]], requests));
    const output = `HEAD-MARKER${"x".repeat(12_000)}TAIL-MARKER`;

    await confidenceCheck(registry, "cheap:mini", "query", output);

    const content = requests[0]?.messages.find((message) => message.role === "user")?.content ?? "";
    expect(content).toContain("HEAD-MARKER");
    expect(content).toContain("TAIL-MARKER");
    expect(content).toContain("[truncated]");
    expect(content.length).toBeLessThan(11_000);
  });

  it("does not retry malformed structured output", async () => {
    const requests: ModelRequest[] = [];
    const registry = registryWith(fakeAdapter([[
      {
        type: "invalid-tool-call",
        id: "bad",
        name: "flavor_confidence",
        rawInput: "{bad",
        error: { code: "invalid_tool_arguments", message: "bad JSON" },
      },
      doneEvent(),
    ]], requests));

    await expect(confidenceCheck(registry, "cheap:mini", "query", "output"))
      .rejects.toThrow("Confidence check failed");
    expect(requests).toHaveLength(1);
  });

  it("aborts and returns a typed timeout error at the configured deadline", async () => {
    vi.useFakeTimers();
    try {
      let observedAbort = false;
      const registry = registryWith({
        async *stream(request) {
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              observedAbort = true;
              reject(request.signal?.reason);
            }, { once: true });
          });
        },
      });

      const run = confidenceCheck(registry, "cheap:mini", "query", "output", { timeoutMs: 500 });
      const expectation = expect(run).rejects.toBeInstanceOf(HallucinationEvaluationTimeoutError);
      await vi.advanceTimersByTimeAsync(500);
      await expectation;
      expect(observedAbort).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fallbackEvidence(): EvidenceSnapshot {
  const events = [
    {
      callId: "read-1", toolName: "Read", status: "failure" as const,
      input: "src/a.ts", repeatCount: 1, sequence: 0, errorCode: "missing",
    },
    {
      callId: "shell-1", toolName: "Shell", status: "success" as const,
      input: "Get-Content src/a.ts", repeatCount: 1, sequence: 1,
      outputKind: "string", outputChars: 10, outputExcerpt: "success",
    },
  ];
  return {
    events,
    omittedCount: 0,
    foldedCount: 0,
    text: JSON.stringify({ omittedCount: 0, foldedCount: 0, events }),
  };
}

function scoreEvent(scores: {
  taskAlignment: number;
  evidenceGrounding: number;
  processReliability: number;
}): ModelEvent {
  return {
    type: "tool-call",
    id: "score",
    name: "flavor_confidence",
    input: {
      ...scores,
      reason: "The final claim is supported by the successful fallback.",
      unsupportedClaims: [],
    },
  };
}

function doneEvent(): ModelEvent {
  return { type: "done", usage: { inputTokens: 100, outputTokens: 20 } };
}

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
