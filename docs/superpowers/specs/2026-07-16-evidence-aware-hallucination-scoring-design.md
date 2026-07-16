# Evidence-Aware Hallucination Scoring Design

## Problem

The hallucination guard currently combines a deterministic retry monitor with a cheap-model confidence check. The model receives only the original query and accumulated final text, so it cannot distinguish unsupported claims from claims grounded by successful tool calls. A failed first-choice tool followed by a successful fallback, such as `Read` followed by `Shell`, is invisible to the scorer. The scorer also produces a single loosely calibrated number, retries malformed structured output up to three times, and has no independent deadline.

The deterministic path has a separate counting defect: `RetryMonitor.recordCall()` pushes an invocation into the sliding window and `recordError()` pushes the same failed invocation again. This double-counts one failure and makes the circuit breaker more sensitive than configured. In engineering-loop mode, a low LLM score currently fails the loop, so subjective scoring can block verified downstream work.

## Goals

- Preserve hallucination detection while making it aware of bounded execution evidence.
- Treat successful fallback behavior as recovery, not as evidence of hallucination.
- Evaluate task coverage, factual grounding, and process reliability separately.
- Keep the scorer to one cheap-model request with a configurable hard deadline.
- Make LLM scoring advisory; only deterministic retry and loop violations may block a loop.
- Bound prompt size, memory use, and retained tool-result content regardless of run length.
- Preserve the existing public report fields and legacy guard recording calls.

## Non-Goals

- Replaying or storing the complete agent transcript.
- Adding another LLM call to summarize tool history.
- Building a configurable rule engine or per-tool semantic parser.
- Using multiple scorers, voting, or provider-specific scoring behavior.
- Guaranteeing that an LLM score is objectively calibrated across all model providers.

## Decision

Use an in-memory, bounded `EvidenceLedger` alongside the existing deterministic `RetryMonitor`. Each tool call and result contributes a compact event. At evaluation time the ledger deterministically selects and serializes the most useful evidence, and one cheap-model request scores the query, final output, and compact evidence together.

The alternative of skipping LLM evaluation for locally classified low-risk tasks was rejected because the risk classifier would introduce another difficult-to-calibrate threshold and could silently miss hallucinations. Multiple parallel scorers were rejected because their extra latency and token cost conflict with the lightweight requirement.

## Architecture

### Evidence Ledger

`src/hallucination/evidence-ledger.ts` owns process-evidence capture and compaction. It has no model dependency. Call sites provide a call ID, tool name, input, and final `ToolResult`. The ID correctly correlates results when the same tool name appears more than once in a turn.

The ledger records compact values rather than retaining arbitrary raw objects indefinitely. Sanitization recursively limits depth, array length, object keys, and string length; redacts sensitive key names and well-known credential patterns; and catches serialization errors. Tool output evidence contains success state, error code, output kind and size, plus a sanitized excerpt capped at 240 characters. Consecutive identical events are folded into one event with a repeat count.

At scoring time, compaction keeps at most 24 events and at most 6,000 serialized characters. Selection priority is:

1. Likely verification and test evidence, identified only for retention priority by lightweight tool-name and parameter keywords.
2. Mutating operations such as writes and patches.
3. Unresolved failures.
4. Adjacent failure-to-success candidates that give the scorer enough context to judge recovery.
5. The newest remaining events.

The serialized evidence includes counts for omitted and folded events. A failed `Read` followed by a successful `Shell` remains in order when both events are selected; the scorer, not the ledger, decides whether the later success resolved the earlier failure. Retention keywords never affect pass/fail, and tool-name choice alone has no negative meaning.

### Deterministic Monitor

`RetryMonitor.recordCall()` remains the only place that inserts a call into the sliding window. `recordError()` updates per-tool failure state without inserting the same invocation again. A later success continues to clear that tool's consecutive error state.

Retry-threshold violations and repeated identical-call circuit breaking remain deterministic blocking conditions. The LLM score never contributes to `HallucinationReport.passed`.

### Process-Aware Scorer

`confidenceCheck` receives a structured evaluation input containing:

- Query: at most 5,000 characters.
- Final output: head-and-tail truncation totaling at most 10,000 characters.
- Compact evidence: at most 24 events and 6,000 serialized characters.

The structured model returns three scores from 0 through 1:

- `taskAlignment`: whether the response covers the requested work.
- `evidenceGrounding`: whether important final claims are supported by the supplied evidence.
- `processReliability`: whether unresolved errors, contradictions, or false success claims remain.

The application computes the public `confidence` value using fixed weights:

```text
confidence = 0.40 * taskAlignment
           + 0.40 * evidenceGrounding
           + 0.20 * processReliability
```

The result also contains a concise reason and no more than three unsupported claims. The prompt defines these calibration rules:

- Do not penalize the choice of tool.
- Treat a successful fallback after a failed tool as normal recovery.
- Do not penalize resolved intermediate failures.
- Penalize only unresolved failures relevant to the final conclusion.
- Do not require tool evidence for explanation, reasoning, or creative tasks that do not need tools.
- Treat omitted evidence as unknown, not as proof that an action did not occur.
- Do not invent evidence beyond the supplied query, output, and compact ledger.

The existing 0.7 threshold continues to decide whether a low-confidence warning is produced. It does not decide whether the guard passes.

### Deadline and Failure Behavior

The scorer configures structured output with `maxRetries: 0`, so malformed output never triggers a repair request. Each evaluation creates an `AbortController`, passes its signal to the model request, and races completion through `awaitWithSignal`. A timer aborts at the configured deadline and is always cleared.

Timeouts, provider errors, unavailable models, and invalid structured output all fail open: the report contains `confidence: null`, records the evaluation status, produces no low-confidence warning, and does not block downstream work. The ledger and retry monitor reset in a `finally` path so state cannot leak into the next evaluation.

## Configuration

Add one field to `.flavor/flavor.json` configuration:

```json
{
  "hallucination": {
    "showWarnings": true,
    "evaluationTimeoutMs": 2000
  }
}
```

`evaluationTimeoutMs` defaults to `2000`, must be an integer, and accepts values from `100` through `30000`. `src/config/schema.ts` validates it and `src/production.ts` passes it into `HallucinationGuard`.

When `showWarnings` is false, the current cost-saving behavior remains: the LLM scorer is skipped, while deterministic retry monitoring still runs.

## Interfaces and Compatibility

`ConfidenceResult` keeps its required `confidence` and `reason` fields. Optional additive fields expose the three component scores and unsupported claims.

`HallucinationReport` keeps its existing fields and adds:

- `evaluationStatus`: `completed`, `timeout`, `unavailable`, or `skipped`.
- `blockingReasons`: deterministic reasons independent of warning visibility.

The engineering loop uses `blockingReasons` when a deterministic violation fails the loop. This prevents an empty terminal reason when `showWarnings` is false.

The agent and engineering loops pass call IDs and complete `ToolResult` values into the guard. Existing `recordToolCall(toolName, params)` and `recordToolResult(toolName, ok, errorCode?)` usage remains accepted through compatible overloads; new internal calls include IDs and full results so the evidence ledger receives richer data.

## Data Flow

1. A tool starts. The loop records its ID, name, and bounded input summary in both the retry monitor and evidence ledger.
2. The tool ends. The loop records its complete result; the ledger immediately sanitizes and bounds the retained representation.
3. The main agent is ready to finish. The guard obtains deterministic violations and a compact evidence snapshot.
4. If warnings are enabled, one cheap-model request evaluates the query, output, and evidence under the configured deadline.
5. The guard computes weighted confidence locally and builds advisory warnings.
6. The guard computes `passed` solely from deterministic violations and supplies independent blocking reasons.
7. All per-run state resets, regardless of scorer outcome.

## Warning Behavior

A completed score below 0.7 produces one localized warning containing the total score, the three component scores, the concise reason, and up to three unsupported claims. The warning is advisory in both interactive and engineering-loop execution.

Deterministic violations may still block engineering-loop completion. Interactive execution retains its current behavior of displaying configured warnings and finishing normally. Scorer timeout or unavailability is silent at the user-facing warning layer and remains observable through `evaluationStatus` and debug logging.

## Verification

Tests will prove:

- Configuration uses a 2,000 ms default, accepts in-range overrides, and rejects non-integers and out-of-range values.
- A failed invocation enters the sliding window once, not twice.
- A failed `Read` followed by a successful `Shell` is retained in order, and scorer calibration treats supported fallback success as recovery.
- Evidence folding, selection priority, event count, character budget, serialization safety, and sensitive-value redaction are deterministic.
- Scoring input contains the query, head and tail of long final output, and compact execution evidence.
- Structured scoring makes at most one provider request and computes the documented weighted value.
- A low LLM score produces a warning while leaving `passed` true.
- Retry and circuit-breaker violations still set `passed` false and provide non-empty blocking reasons even when warnings are hidden.
- Timeout returns near the configured deadline, aborts the provider request, skips retry, leaves confidence null, and does not block.
- Scorer errors and malformed structured output fail open and reset state.
- Agent-loop and engineering-loop integration pass call IDs and full tool outcomes and preserve their intended terminal behavior.

Verification commands are the focused hallucination and configuration tests, the full Vitest suite, TypeScript typecheck, production build, and `git diff --check`.
