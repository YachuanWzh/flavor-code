# Model Call Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover main-agent model calls through three default-model attempts and two cheap-model attempts while auditing intermediate failures and hiding them from the frontend.

**Architecture:** Put retry policy and orchestration in `AgentLoop`, pass the cheap fallback through `LocalHarness`, and expose a model-neutral retry progress event through the existing session/transcript pipeline. Preserve per-attempt hooks so production auditing records every failure.

**Tech Stack:** TypeScript 7, Node.js 20+, React/Ink, Vitest 4.

## Global Constraints

- Work directly on `main` as requested.
- Retry only `network`, `rate_limit`, `unknown`, and `incomplete_stream` with no provider output.
- Use five total attempts with model phases `main, main, main, cheap, cheap` and delays `1000, 2000, 4000, 8000` milliseconds.
- Never include default/cheap model identity or raw intermediate error text in frontend retry events.
- Preserve existing context-overflow compaction behavior.

---

### Task 1: Specify retry and fallback behavior

**Files:**
- Modify: `tests/agent/loop.test.ts`

**Interfaces:**
- Consumes: `AgentLoop.run()`, `ModelRegistry`, `AfterModelCall` hooks.
- Produces: regression coverage for five-attempt orchestration, eligibility, output safety, cancellation, and attempt audit metadata.

- [x] Add fake-timer tests that expect three main requests followed by two cheap requests and delays of 1/2/4/8 seconds.
- [x] Assert intermediate failures produce `model-retry`, never `error`, and the fifth failure alone produces the terminal error.
- [x] Assert auth failures and failures after visible output do not retry.
- [x] Assert aborting during backoff prevents the next request.
- [x] Run `npm test -- --run tests/agent/loop.test.ts` and verify the new tests fail for missing behavior.

### Task 2: Implement retry orchestration and harness fallback

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Modify: `src/harness/local.ts`

**Interfaces:**
- Produces: `AgentEvent` variant `{ type: "model-retry"; attempt: number; maxAttempts: number; delayMs: number }`.
- Produces: optional `fallbackModelId` support on `AgentLoop` and synchronized updates from `LocalHarness.setModel("subagent", id)`.

- [x] Add the typed model-neutral retry event and fallback model option.
- [x] Make incomplete streams typed attempt errors before `AfterModelCall` is emitted.
- [x] Implement abort-aware exponential backoff and the `main ×3, cheap ×2` schedule.
- [x] Preserve terminal handling for non-recoverable errors, partial output, and context compaction.
- [x] Run the focused loop tests and make them pass.

### Task 3: Render retry progress without leaking model errors

**Files:**
- Modify: `tests/ui/transcript.test.ts`
- Modify: `src/ui/transcript.ts`

**Interfaces:**
- Consumes: the `model-retry` event.
- Produces: one upserted informational transcript row such as `Retrying model call · attempt 4/5 in 4s`.

- [x] Write a reducer test proving multiple retry events update one row, display `/5`, and contain neither model IDs nor raw errors.
- [x] Run the reducer test and verify RED.
- [x] Add the reducer branch and run the test GREEN.

### Task 4: Persist per-attempt model failures in audit

**Files:**
- Modify: `tests/cli/production.test.ts`
- Modify: `src/utils/log.ts`
- Modify: `src/production.ts`

**Interfaces:**
- Consumes: `AfterModelCall.payload.attempt` and `maxAttempts`.
- Produces: optional `attempt` and `maxAttempts` JSONL fields for `ModelCallFailure`.

- [x] Write a production runtime audit test for attempt metadata and verify RED.
- [x] Extend `AuditEntry` and production's model-failure audit listener.
- [x] Run production audit and loop tests GREEN.

### Task 5: Verify the complete project

**Files:**
- Review all modified files.

- [x] Run `npm test`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run build`.
- [x] Run `git diff --check` and review `git diff --stat` plus `git status --short`.

Verification result on 2026-07-15:

- Focused retry, transcript, and production audit tests passed.
- Full suite: 488 passed, 3 failed, 2 skipped. The three failures are the pre-existing `tests/cli/production.test.ts` configuration/session baseline failures documented by the prior ApplyPatch plan.
- Build and `git diff --check` passed.
- Typecheck reports only pre-existing OAuth, task-progress, session fixture, and transcript narrowing errors; no error references the model resilience implementation.
