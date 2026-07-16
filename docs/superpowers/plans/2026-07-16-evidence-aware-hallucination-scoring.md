# Evidence-Aware Hallucination Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make hallucination scoring process-aware, bounded to one deadline-limited model call, and advisory while preserving deterministic loop protection.

**Architecture:** Add a deterministic bounded evidence ledger beside the retry monitor, feed its compact snapshot into a three-dimension cheap-model scorer, and compute the final score locally. The guard owns fail-open timeout handling and separates advisory warnings from deterministic blocking reasons.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, Vitest 4, existing `ModelRegistry` and structured-output adapter.

## Global Constraints

- Work directly on the current `main` branch; do not create a worktree.
- Do not add runtime dependencies or make a second LLM call.
- `evaluationTimeoutMs` defaults to `2000` and accepts integer values from `100` through `30000`.
- Scoring inputs are capped at 5,000 query characters, 10,000 head-and-tail output characters, 24 evidence events, and 6,000 evidence characters.
- Structured scoring uses `maxRetries: 0` and fails open on timeout, provider failure, unavailable model, or invalid structured output.
- LLM confidence below 0.7 is advisory; only deterministic retry/circuit-breaker violations can make `passed` false.
- Preserve legacy `recordToolCall(toolName, params)` and `recordToolResult(toolName, ok, errorCode?)` calls.

---

## File Structure

- Create `src/hallucination/evidence-ledger.ts`: bounded evidence capture, sanitization, folding, prioritization, and snapshot serialization.
- Create `tests/hallucination/evidence-ledger.test.ts`: evidence budgets, recovery sequence, repetition, and redaction coverage.
- Modify `src/hallucination/types.ts`: scoring dimensions, evaluation status, blocking reasons, and timeout constant.
- Modify `src/config/schema.ts`, `src/production.ts`, and `tests/config/load.test.ts`: timeout configuration.
- Modify `src/hallucination/confidence.ts` and `tests/hallucination/confidence.test.ts`: one-shot three-dimension scoring, evidence prompt, head/tail truncation, and timeout.
- Modify `src/hallucination/retry-monitor.ts` and `tests/hallucination/retry-monitor.test.ts`: remove failed-call double counting.
- Modify `src/hallucination/guard.ts`, `src/hallucination/messages.ts`, and `tests/hallucination/guard.test.ts`: advisory scoring, fail-open status, rich tool results, and deterministic blocking reasons.
- Modify `src/agent/loop.ts`, `src/loop/orchestrator.ts`, `tests/hallucination/integration.test.ts`, and `tests/loop/orchestrator.test.ts`: pass call IDs/full outcomes and preserve advisory loop success.
- Modify `src/hallucination/index.ts` and `技术方案报告.md`: exports and architecture documentation.

---

### Task 1: Configuration and Additive Public Types

**Files:**
- Modify: `src/hallucination/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/production.ts`
- Modify: `tests/config/load.test.ts`

**Interfaces:**
- Produces: `DEFAULT_EVALUATION_TIMEOUT_MS`, `ConfidenceScores`, `HallucinationEvaluationStatus`, `FlavorConfig.hallucination.evaluationTimeoutMs`.
- Consumes: existing `FlavorConfigSchema` and `HallucinationGuardConfig`.

- [ ] **Step 1: Write failing configuration tests**

Add to `tests/config/load.test.ts`:

```ts
it("uses the hallucination evaluation timeout default and validates overrides", () => {
  expect(FlavorConfigSchema.parse({}).hallucination).toEqual({
    showWarnings: false,
    evaluationTimeoutMs: 2_000,
  });
  expect(FlavorConfigSchema.parse({ hallucination: {
    showWarnings: true,
    evaluationTimeoutMs: 750,
  } }).hallucination).toEqual({ showWarnings: true, evaluationTimeoutMs: 750 });
  for (const value of [99, 30_001, 1.5]) {
    expect(() => FlavorConfigSchema.parse({ hallucination: { evaluationTimeoutMs: value } })).toThrow();
  }
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run tests/config/load.test.ts`

Expected: FAIL because `evaluationTimeoutMs` is absent and not validated.

- [ ] **Step 3: Add the types, schema field, and production wiring**

Add to `src/hallucination/types.ts`:

```ts
export interface ConfidenceScores {
  taskAlignment: number;
  evidenceGrounding: number;
  processReliability: number;
}

export type HallucinationEvaluationStatus = "completed" | "timeout" | "unavailable" | "skipped";
export const DEFAULT_EVALUATION_TIMEOUT_MS = 2_000;

export interface ConfidenceResult {
  confidence: number;
  reason: string;
  scores?: ConfidenceScores;
  unsupportedClaims?: string[];
}
```

Task 4 will extend `HallucinationReport` when the guard can populate the new required fields. Extend the hallucination schema with:

```ts
evaluationTimeoutMs: z.number().int().min(100).max(30_000).default(2_000),
```

Pass `config.hallucination.evaluationTimeoutMs` to `new HallucinationGuard(...)` in `src/production.ts`.

- [ ] **Step 4: Run focused tests and typecheck**

Run: `npx vitest run tests/config/load.test.ts && npm run typecheck`

Expected: configuration tests and typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hallucination/types.ts src/config/schema.ts src/production.ts tests/config/load.test.ts
git commit -m "feat(hallucination): configure evaluation timeout"
```

### Task 2: Bounded Evidence Ledger

**Files:**
- Create: `src/hallucination/evidence-ledger.ts`
- Create: `tests/hallucination/evidence-ledger.test.ts`

**Interfaces:**
- Consumes: `ToolResult` from `src/tools/types.ts` and `redactErrorText` from `src/utils/redact.ts`.
- Produces: `EvidenceLedger.recordCall(callId, toolName, input)`, `recordResult(callId, toolName, result)`, `snapshot()`, and `reset()`.

- [ ] **Step 1: Write failing recovery, folding, budget, and redaction tests**

Create `tests/hallucination/evidence-ledger.test.ts` with tests equivalent to:

```ts
it("keeps a failed read before a successful shell fallback", () => {
  const ledger = new EvidenceLedger();
  ledger.recordCall("read-1", "Read", { path: "src/a.ts" });
  ledger.recordResult("read-1", "Read", { ok: false, error: { code: "missing", message: "not found" } });
  ledger.recordCall("shell-1", "Shell", { command: "Get-Content src/a.ts" });
  ledger.recordResult("shell-1", "Shell", { ok: true, output: "export const value = 1" });
  const snapshot = ledger.snapshot();
  expect(snapshot.text).toMatch(/Read[\s\S]*missing[\s\S]*Shell[\s\S]*success/);
});

it("folds consecutive identical outcomes", () => {
  const ledger = new EvidenceLedger();
  for (let index = 0; index < 3; index += 1) {
    ledger.recordCall(`read-${index}`, "Read", { path: "same.ts" });
    ledger.recordResult(`read-${index}`, "Read", { ok: true, output: "same" });
  }
  expect(ledger.snapshot().events).toHaveLength(1);
  expect(ledger.snapshot().events[0]?.repeatCount).toBe(3);
});

it("bounds and redacts evidence", () => {
  const ledger = new EvidenceLedger();
  for (let index = 0; index < 40; index += 1) {
    ledger.recordCall(`call-${index}`, "Read", { path: `${index}.ts`, apiKey: "sk-secret" });
    ledger.recordResult(`call-${index}`, "Read", { ok: true, output: `token=secret-${index} ${"x".repeat(500)}` });
  }
  const snapshot = ledger.snapshot();
  expect(snapshot.events.length).toBeLessThanOrEqual(24);
  expect(snapshot.text.length).toBeLessThanOrEqual(6_000);
  expect(snapshot.text).not.toContain("sk-secret");
  expect(snapshot.omittedCount).toBeGreaterThan(0);
});
```

Also cover circular inputs, sensitive keys (`password`, `token`, `authorization`, `cookie`, `secret`, `apiKey`), reset, and priority retention of failure/mutation/verification-like events.

- [ ] **Step 2: Run the new suite and verify RED**

Run: `npx vitest run tests/hallucination/evidence-ledger.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal ledger**

Define focused types and constants:

```ts
export const MAX_EVIDENCE_EVENTS = 24;
export const MAX_EVIDENCE_CHARS = 6_000;

export interface EvidenceSnapshot {
  events: CompactEvidenceEvent[];
  omittedCount: number;
  foldedCount: number;
  text: string;
}

export class EvidenceLedger {
  recordCall(callId: string, toolName: string, input: unknown): void;
  recordResult(callId: string, toolName: string, result: ToolResult): void;
  snapshot(): EvidenceSnapshot;
  reset(): void;
}
```

Sanitize on insertion, not at evaluation. Cap tool names at 80 characters, input summaries at 240 characters, result excerpts at 240 characters, recursion depth at 3, arrays at 8 items, and objects at 12 keys. Fold only consecutive finalized events with identical tool, input summary, status, error code, and output summary. Select by retention priority, then restore sequence order and remove the lowest-priority oldest event until serialized text is at most 6,000 characters.

- [ ] **Step 4: Run the ledger tests and verify GREEN**

Run: `npx vitest run tests/hallucination/evidence-ledger.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hallucination/evidence-ledger.ts tests/hallucination/evidence-ledger.test.ts
git commit -m "feat(hallucination): add bounded evidence ledger"
```

### Task 3: One-Shot Process-Aware Confidence Scoring

**Files:**
- Modify: `src/hallucination/confidence.ts`
- Modify: `tests/hallucination/confidence.test.ts`

**Interfaces:**
- Consumes: `ConfidenceScores`, `EvidenceSnapshot`, `awaitWithSignal`, and existing `ModelRegistry`.
- Produces: `confidenceCheck(registry, modelId, query, output, options?)` with `evidence` and `timeoutMs` options; `HallucinationEvaluationTimeoutError`.

- [ ] **Step 1: Replace single-score fixtures with failing multidimensional tests**

Use fake adapters that return:

```ts
{
  taskAlignment: 0.9,
  evidenceGrounding: 0.8,
  processReliability: 0.7,
  reason: "The final claim is supported by the successful fallback.",
  unsupportedClaims: [],
}
```

Assert confidence is `0.82`, component scores are returned, the prompt contains `Execution evidence`, and failed `Read` plus successful `Shell` evidence is visible. Add tests proving long output includes both a unique head marker and tail marker, invalid structured output makes exactly one request, unsupported claims are limited to three, and a never-ending adapter rejects with `HallucinationEvaluationTimeoutError` around the configured fake-timer deadline.

- [ ] **Step 2: Run scoring tests and verify RED**

Run: `npx vitest run tests/hallucination/confidence.test.ts`

Expected: FAIL because the old schema accepts only `confidence/reason`, omits evidence, retries repair, and has no deadline.

- [ ] **Step 3: Implement schema, prompt, weighting, and timeout**

Use this schema shape:

```ts
const ConfidenceSchema = z.object({
  taskAlignment: z.number(),
  evidenceGrounding: z.number(),
  processReliability: z.number(),
  reason: z.string(),
  unsupportedClaims: z.array(z.string()).max(3),
});
```

Clamp each score, compute `0.4 * taskAlignment + 0.4 * evidenceGrounding + 0.2 * processReliability`, and configure:

```ts
retry: { maxRetries: 0, backoffMs: [] },
```

Build head-and-tail output truncation totaling 10,000 characters. Start an abort timer, call `awaitWithSignal(model.invoke({ messages, signal }), signal)`, convert the deadline abort into `HallucinationEvaluationTimeoutError`, and clear the timer in `finally`.

- [ ] **Step 4: Run scoring tests and verify GREEN**

Run: `npx vitest run tests/hallucination/confidence.test.ts`

Expected: PASS with one request per evaluation.

- [ ] **Step 5: Commit**

```bash
git add src/hallucination/confidence.ts tests/hallucination/confidence.test.ts
git commit -m "feat(hallucination): score bounded execution evidence"
```

### Task 4: Guard Semantics and Deterministic Counting

**Files:**
- Modify: `src/hallucination/types.ts`
- Modify: `src/hallucination/retry-monitor.ts`
- Modify: `src/hallucination/guard.ts`
- Modify: `src/hallucination/messages.ts`
- Modify: `tests/hallucination/retry-monitor.test.ts`
- Modify: `tests/hallucination/guard.test.ts`

**Interfaces:**
- Consumes: `EvidenceLedger`, `confidenceCheck`, `ToolResult`, `evaluationTimeoutMs`.
- Produces: advisory confidence warnings, required evaluation status, and deterministic `blockingReasons`.

- [ ] **Step 1: Write failing retry and guard behavior tests**

Add a retry regression where a three-entry window with threshold two receives one failed call and one unrelated call; assert it does not trip. Update guard fixtures to return multidimensional scores. Add assertions:

```ts
expect(lowScoreReport.passed).toBe(true);
expect(lowScoreReport.warnings).toHaveLength(1);
expect(lowScoreReport.evaluationStatus).toBe("completed");

expect(deterministicFailure.passed).toBe(false);
expect(deterministicFailure.blockingReasons[0]).toBeTruthy();

expect(timeoutReport).toMatchObject({
  passed: true,
  confidence: null,
  evaluationStatus: "timeout",
  warnings: [],
});
```

Cover `showWarnings=false` returning `skipped`, full-result evidence capture through call IDs, legacy boolean result calls, unavailable model, and state reset after timeout.

- [ ] **Step 2: Run retry and guard tests and verify RED**

Run: `npx vitest run tests/hallucination/retry-monitor.test.ts tests/hallucination/guard.test.ts`

Expected: FAIL on double counting, advisory semantics, status, and blocking reasons.

- [ ] **Step 3: Remove double insertion and implement guard orchestration**

Change `RetryMonitor.recordError` to update only `#errorStates`. In `HallucinationGuard`, add the ledger and timeout, accept optional call IDs, and provide overloads:

```ts
recordToolResult(toolName: string, ok: boolean, errorCode?: string): void;
recordToolResult(toolName: string, result: ToolResult, callId?: string): void;
```

Extend `HallucinationReport` in `src/hallucination/types.ts` with required `evaluationStatus` and `blockingReasons`. Create legacy call IDs internally when callers omit IDs. Snapshot evidence before scoring. Set `passed` only from retry violations and circuit breaking. Build low-score warnings only when confidence is below threshold, and build `blockingReasons` from deterministic findings regardless of `showWarnings`. Classify `HallucinationEvaluationTimeoutError` as `timeout`, other scorer failures as `unavailable`, and reset ledger/monitor/legacy ID queues in `finally`.

Extend localized low-confidence formatting to include available component scores and up to three unsupported claims.

- [ ] **Step 4: Run focused suites and verify GREEN**

Run: `npx vitest run tests/hallucination/retry-monitor.test.ts tests/hallucination/guard.test.ts tests/hallucination/sliding-window.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/hallucination/types.ts src/hallucination/retry-monitor.ts src/hallucination/guard.ts src/hallucination/messages.ts tests/hallucination/retry-monitor.test.ts tests/hallucination/guard.test.ts
git commit -m "fix(hallucination): make model scoring advisory"
```

### Task 5: Agent and Engineering-Loop Integration

**Files:**
- Modify: `src/agent/loop.ts`
- Modify: `src/loop/orchestrator.ts`
- Modify: `tests/hallucination/integration.test.ts`
- Modify: `tests/loop/orchestrator.test.ts`

**Interfaces:**
- Consumes: enriched `HallucinationGuard.recordToolCall` and `recordToolResult` APIs.
- Produces: call-ID/full-result evidence and non-blocking low-score engineering-loop completion.

- [ ] **Step 1: Write failing integration expectations**

Update the AgentLoop spy assertions to:

```ts
expect(recordToolCallSpy).toHaveBeenCalledWith("echo", { value: "hello" }, "call-1");
expect(recordToolResultSpy).toHaveBeenCalledWith(
  "echo",
  expect.objectContaining({ ok: true, output: { value: "hello" } }),
  "call-1",
);
```

Add an orchestrator test using a guard stub whose report has low confidence, warnings, `passed: true`, and no blocking reasons; assert terminal status is `succeeded` and its reason includes the advisory warning. Add a deterministic-failure report and assert terminal status is `failed` with the non-empty blocking reason.

- [ ] **Step 2: Run integration tests and verify RED**

Run: `npx vitest run tests/hallucination/integration.test.ts tests/loop/orchestrator.test.ts`

Expected: FAIL because call IDs/full results are not passed and the orchestrator discards advisory warnings.

- [ ] **Step 3: Wire rich outcomes and separate advisory/blocking reasons**

In both loops, pass event/call IDs on start and the full `ToolResult` on end. In `LoopOrchestrator`, fail only when `report.passed` is false and use `report.blockingReasons.join("; ")` as the failure reason. When the report passes with warnings, append them to the successful terminal reason without changing the status.

- [ ] **Step 4: Run integration tests and verify GREEN**

Run: `npx vitest run tests/hallucination/integration.test.ts tests/loop/orchestrator.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/loop.ts src/loop/orchestrator.ts tests/hallucination/integration.test.ts tests/loop/orchestrator.test.ts
git commit -m "feat(hallucination): propagate tool evidence through loops"
```

### Task 6: Exports, Documentation, and Full Verification

**Files:**
- Modify: `src/hallucination/index.ts`
- Modify: `技术方案报告.md`

**Interfaces:**
- Produces: public additive exports and accurate architecture/configuration documentation.

- [ ] **Step 1: Add an export smoke assertion**

In the most focused existing hallucination test, import `EvidenceLedger` and `DEFAULT_EVALUATION_TIMEOUT_MS` from `src/hallucination/index.ts`; assert the constructor is defined and the default equals 2,000.

- [ ] **Step 2: Run the assertion and verify RED**

Run: `npx vitest run tests/hallucination/evidence-ledger.test.ts`

Expected: FAIL because the barrel exports are absent.

- [ ] **Step 3: Add exports and update documentation**

Export `EvidenceLedger`, evidence snapshot types, score/status types, and `DEFAULT_EVALUATION_TIMEOUT_MS`. Update section 5.4 of `技术方案报告.md` to describe bounded process evidence, three weighted dimensions, one-shot deadline behavior, advisory LLM scoring, deterministic blockers, and the `evaluationTimeoutMs` example.

- [ ] **Step 4: Run complete verification**

Run in order:

```bash
npx vitest run tests/hallucination tests/config/load.test.ts tests/loop/orchestrator.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0; no warnings or whitespace errors attributable to the change.

- [ ] **Step 5: Commit**

```bash
git add src/hallucination/index.ts tests/hallucination/evidence-ledger.test.ts 技术方案报告.md
git commit -m "docs(hallucination): document evidence-aware scoring"
```
