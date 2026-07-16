import { describe, expect, it, vi } from "vitest";

import type { AgentEvent } from "../../src/agent/types.js";
import type { HallucinationGuard } from "../../src/hallucination/guard.js";
import { LoopOrchestrator, type LoopPersistence, type LoopRuntimeEvent } from "../../src/loop/orchestrator.js";
import type { LoopEvent, LoopState, LoopVerificationEvidence } from "../../src/loop/types.js";
import { buildLoopCyclePrompt } from "../../src/skills/builtin-loop.js";

class MemoryPersistence implements LoopPersistence {
  states: LoopState[] = [];
  events: LoopEvent[] = [];
  async create(state: LoopState) { this.states.push(structuredClone(state)); }
  async save(state: LoopState) { this.states.push(structuredClone(state)); }
  async append(event: LoopEvent) { this.events.push(structuredClone(event)); }
}

function verification(passed: boolean, summary = passed ? "all checks passed" : "tests failed"): LoopVerificationEvidence {
  return { passed, summary, commands: [] };
}

async function collect(source: AsyncIterable<LoopRuntimeEvent>): Promise<LoopRuntimeEvent[]> {
  const result: LoopRuntimeEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

function worker(events: AgentEvent[]): AsyncIterable<AgentEvent> {
  return (async function* () { yield* events; })();
}

function fixture(overrides: Partial<ConstructorParameters<typeof LoopOrchestrator>[0]> = {}) {
  const persistence = new MemoryPersistence();
  const prompts: string[] = [];
  const confirmations: Array<readonly string[]> = [];
  const verifierResults = [verification(true)];
  const orchestrator = new LoopOrchestrator({
    workspace: "C:/work/project",
    config: { maxCycles: 20, maxTokens: 500_000, isolation: "auto" },
    persistence,
    now: () => "2026-07-15T00:00:00.000Z",
    idFactory: () => "loop-test",
    prepareWorkspace: async () => ({ kind: "ready", workspace: { root: "C:/work/project", mode: "current" } }),
    inferVerification: async () => ({ commands: [{ label: "test", command: "npm", args: ["test"] }] }),
    runWorker: ({ prompt }) => {
      prompts.push(prompt);
      return worker([
        { type: "usage", inputTokens: 100, outputTokens: 50, totalInputTokens: 100, totalOutputTokens: 50 },
        { type: "done", usage: { inputTokens: 100, outputTokens: 50 } },
      ]);
    },
    runVerifier: async () => verifierResults.shift() ?? verification(true),
    confirmBudget: async (_state, dimensions) => { confirmations.push(dimensions); return "approved"; },
    fingerprint: async () => "fingerprint",
    ...overrides,
  });
  return { orchestrator, persistence, prompts, confirmations, verifierResults };
}

describe("built-in loop skill", () => {
  it("includes immutable goal, cycle, memory, verifier evidence, and forbids self-approval", () => {
    const prompt = buildLoopCyclePrompt({
      goal: "fix all tests", cycle: 2, memory: "cycle 1 changed auth.ts",
      verification: verification(false, "typecheck failed in auth.ts"),
    });
    expect(prompt).toContain("fix all tests");
    expect(prompt).toContain("Cycle: 2");
    expect(prompt).toContain("cycle 1 changed auth.ts");
    expect(prompt).toContain("typecheck failed in auth.ts");
    expect(prompt).toMatch(/cannot approve|宿主验证/i);
  });
});

describe("LoopOrchestrator", () => {
  it("marks success only after host verification passes", async () => {
    const f = fixture();
    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "succeeded" });
    expect(f.persistence.states.at(-1)).toMatchObject({ status: "succeeded", budget: { cyclesUsed: 1, inputTokens: 100, outputTokens: 50 } });
  });

  it("keeps low model confidence advisory after host verification passes", async () => {
    const guard = {
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      evaluate: vi.fn(async () => ({
        confidence: { confidence: 0.3, reason: "uncertain" },
        evaluationStatus: "completed" as const,
        retryViolations: [],
        circuitBreakerTripped: false,
        circuitBreakerDetail: null,
        passed: true,
        blockingReasons: [],
        warnings: ["advisory warning"],
      })),
    } as unknown as HallucinationGuard;
    const f = fixture({ hallucinationGuard: guard });

    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));

    expect(events.at(-1)).toMatchObject({
      type: "loop-terminal",
      status: "succeeded",
      reason: expect.stringContaining("advisory warning"),
    });
  });

  it("uses deterministic blocking reasons when the guard fails", async () => {
    const guard = {
      recordToolCall: vi.fn(),
      recordToolResult: vi.fn(),
      evaluate: vi.fn(async () => ({
        confidence: null,
        evaluationStatus: "skipped" as const,
        retryViolations: [{ toolName: "Read", retryCount: 3, maxRetries: 3, lastErrorCode: "denied" }],
        circuitBreakerTripped: false,
        circuitBreakerDetail: null,
        passed: false,
        blockingReasons: ["Read failed repeatedly"],
        warnings: [],
      })),
    } as unknown as HallucinationGuard;
    const f = fixture({ hallucinationGuard: guard });

    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));

    expect(events.at(-1)).toMatchObject({
      type: "loop-terminal",
      status: "failed",
      reason: "Read failed repeatedly",
    });
  });

  it("feeds failed host evidence into a fresh next-cycle prompt", async () => {
    let calls = 0;
    const f = fixture({
      runVerifier: async () => ++calls === 1 ? verification(false, "typecheck failed") : verification(true),
    });
    await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(f.prompts).toHaveLength(2);
    expect(f.prompts[1]).toContain("typecheck failed");
    expect(f.persistence.states.at(-1)).toMatchObject({ status: "succeeded", budget: { cyclesUsed: 2 } });
  });

  it("asks once at reached token and cycle checkpoints before another worker call", async () => {
    let verifies = 0;
    const f = fixture({
      config: { maxCycles: 1, maxTokens: 100, isolation: "auto" },
      runVerifier: async () => ++verifies === 1 ? verification(false) : verification(true),
    });
    await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(f.confirmations).toEqual([["cycles", "tokens"]]);
    expect(f.persistence.states.at(-1)).toMatchObject({
      status: "succeeded",
      budget: { cycleCheckpoint: 2, tokenCheckpoint: 200 },
    });
  });

  it("persists needs_human when confirmation is unavailable", async () => {
    const f = fixture({
      config: { maxCycles: 1, maxTokens: 100, isolation: "auto" },
      runVerifier: async () => verification(false),
      confirmBudget: async () => "unavailable",
    });
    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "needs_human" });
  });

  it("accounts for model tokens even when the worker fails", async () => {
    const f = fixture({
      runWorker: () => worker([
        { type: "usage", inputTokens: 70, outputTokens: 30, totalInputTokens: 70, totalOutputTokens: 30 },
        { type: "error", error: { code: "network", message: "worker failed" } },
      ]),
    });

    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));

    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "failed" });
    expect(f.persistence.states.at(-1)).toMatchObject({
      status: "failed", budget: { cyclesUsed: 1, inputTokens: 70, outputTokens: 30 },
    });
  });

  it("stops after three identical failures without workspace progress", async () => {
    const f = fixture({ runVerifier: async () => verification(false, "same failure") });
    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(f.prompts).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "no_progress" });
  });

  it("does not invoke a worker when isolation or verification needs a human", async () => {
    let workers = 0;
    const f = fixture({
      prepareWorkspace: async () => ({ kind: "needs_human", reason: "dirty workspace" }),
      runWorker: () => { workers += 1; return worker([]); },
    });
    const events = await collect(f.orchestrator.run({ goal: "fix tests", signal: new AbortController().signal }));
    expect(workers).toBe(0);
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "needs_human", reason: "dirty workspace" });
  });

  it("runs one verifier-discovery cycle before needs_human when no command can be inferred", async () => {
    let workers = 0;
    let discoveryPrompt = "";
    const f = fixture({
      inferVerification: async () => ({ commands: [], needsHumanReason: "No deterministic verification command was found." }),
      runWorker: ({ prompt }) => {
        workers += 1;
        discoveryPrompt = prompt;
        return worker([
          { type: "usage", inputTokens: 40, outputTokens: 10, totalInputTokens: 40, totalOutputTokens: 10 },
          { type: "done", usage: { inputTokens: 40, outputTokens: 10 } },
        ]);
      },
    });

    const events = await collect(f.orchestrator.run({ goal: "implement direction four", signal: new AbortController().signal }));

    expect(workers).toBe(1);
    expect(discoveryPrompt).toMatch(/No deterministic verification command|meaningful project-native/i);
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "needs_human" });
    expect(f.persistence.states.at(-1)).toMatchObject({
      status: "needs_human", budget: { cyclesUsed: 1, inputTokens: 40, outputTokens: 10 },
    });
  });

  it("re-infers and runs a verifier established by the discovery cycle", async () => {
    let inferenceCalls = 0;
    let verifierCalls = 0;
    const f = fixture({
      inferVerification: async () => ++inferenceCalls === 1
        ? { commands: [], needsHumanReason: "No deterministic verification command was found." }
        : { commands: [{ label: "test", command: "npm", args: ["test"] }] },
      runVerifier: async () => { verifierCalls += 1; return verification(true); },
    });

    const events = await collect(f.orchestrator.run({ goal: "implement direction four", signal: new AbortController().signal }));

    expect(inferenceCalls).toBe(2);
    expect(verifierCalls).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "loop-terminal", status: "succeeded" });
  });
});
