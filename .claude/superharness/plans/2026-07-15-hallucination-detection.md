# Hallucination Detection Mechanism

## Goal
Implement a three-layer hallucination detection system for the agent:
1. Pre-completion cheap-model confidence check
2. Tool call retry monitoring against project thresholds
3. Parameter sliding-window circuit breaker for stuck retry loops

## Files
- `src/hallucination/types.ts` — shared types
- `src/hallucination/sliding-window.ts` — sliding window + hash
- `src/hallucination/confidence.ts` — cheap model confidence check
- `src/hallucination/retry-monitor.ts` — retry counter + sliding window integration
- `src/hallucination/guard.ts` — HallucinationGuard top-level facade
- `src/hallucination/index.ts` — barrel export
- `tests/hallucination/sliding-window.test.ts`
- `tests/hallucination/confidence.test.ts`
- `tests/hallucination/retry-monitor.test.ts`
- `tests/hallucination/guard.test.ts`

## Tasks (TDD)

### Task 1: SlidingWindow circuit breaker (sliding-window.ts)
- RED: Write tests for hash computation, window push, threshold detection
- GREEN: Implement `SlidingWindow` with hash = SHA256(toolName + sorted_params)
- Default config: windowSize=20, threshold=15

### Task 2: Cheap model confidence check (confidence.ts)
- RED: Write tests using fake adapter
- GREEN: Implement `confidenceCheck()` using `withStructuredOutput` + cheap model
- Schema: { confidence: number(0-1), reason: string }

### Task 3: RetryMonitor (retry-monitor.ts)
- RED: Write tests for retry counting and sliding window integration
- GREEN: Implement `RetryMonitor` with per-tool retry counts and threshold checks
- Default maxToolRetries: 3 (matching existing model retry count)

### Task 4: HallucinationGuard (guard.ts)
- RED: Write integration tests
- GREEN: Wire together confidence check + retry monitor + sliding window

### Task 5: Integration
- Wire `HallucinationGuard` into `AgentLoop` (via tool call events)
- Wire confidence check before loop orchestrator success declaration

## Assumptions
- The cheap model is configured via existing `fallbackModelId`/`cheapModel`
- Tool retry = same tool name called again after a failure
- Sliding window hash includes tool name + sorted JSON of params
- Guard failures are advisory warnings, not hard stops (unless confidence < threshold)
