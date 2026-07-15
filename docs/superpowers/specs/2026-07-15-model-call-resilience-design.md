# Model Call Resilience Design

## Problem

`AgentLoop` currently turns the first provider failure into a terminal `error` event. The transcript renders that raw provider message immediately, so transient network, rate-limit, service, and prematurely-ended-stream failures terminate otherwise recoverable runs. Model-call failures are audited through `AfterModelCall`, but there is no retry progress event and the main agent never falls back to the configured cheap model.

## Goals

- Make at most five attempts for a recoverable main-agent model call: three with the selected main model, then two with the configured cheap/subagent model.
- Wait 1, 2, 4, and 8 seconds before attempts 2 through 5.
- Show one model-neutral retry progress row in the frontend, including the next attempt and the five-attempt total.
- Audit every failed attempt without exposing its raw error to the frontend.
- Emit the final provider error only after all five attempts fail.

## Retry Eligibility

Retry `network`, `rate_limit`, `unknown`, and `incomplete_stream`. Treat authentication, model lookup, cancellation, context overflow, output limit, hook denial/failure, iteration limit, and failures after provider text or tool-call output as terminal. Existing reactive context compaction remains separate and unchanged.

## Architecture

`AgentLoop` owns retry orchestration because it observes streamed output, typed provider errors, hooks, cancellation, and context state. It receives an optional fallback model ID from `LocalHarness`. Each physical attempt resolves its own model, emits `BeforeModelCall` and `AfterModelCall`, and clears attempt-local text/tool-call buffers before retrying.

After a recoverable failed attempt with no output, the loop emits a model-neutral `model-retry` event containing only the next attempt number, total attempts, and delay. It then waits using an abort-aware timer. The transcript upserts these events into one informational status row. It never receives an intermediate provider error.

The `AfterModelCall` payload includes attempt metadata. Production's existing audit hook writes every failed attempt to `.flavor/audit.jsonl`, extended with the attempt number and five-attempt total.

## Safety

- The main model selection is never mutated by fallback; later turns start with the main model again.
- A changed subagent model also becomes the main loop's next fallback model.
- Cancellation during backoff stops immediately and prevents another provider request.
- Partial streamed output is never replayed.
- Subagents already use the cheap model and retain their current behavior; the five-attempt default-to-cheap chain applies to the main agent.

## Verification

Use fake model adapters and fake timers to prove default retries, cheap fallback, exponential delays, terminal filtering, cancellation, partial-output safety, audit metadata, and frontend rendering. Then run the full test suite, typecheck, build, and `git diff --check`.
