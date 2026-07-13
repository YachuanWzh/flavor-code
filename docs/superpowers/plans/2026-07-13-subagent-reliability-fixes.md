# Subagent Reliability Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent completed or cancelled subagents from being reported as failed, reject invalid Grep file-type values before execution, and identify delegated work with a `/ subagent` suffix.

**Architecture:** Keep the existing DAG scheduler and generic `TaskOutput` tool. Convert a successful subagent `TaskOutput` event directly into the scheduler's strict `SubagentResult`, use only the final assistant message as a JSON compatibility fallback, and represent cancellation as a state without synthesizing a result. Harden Grep with a finite friendly file-type vocabulary and render the existing subagent role consistently in interactive and static task rows.

**Tech Stack:** TypeScript, Zod, Vitest, Ink terminal UI.

## Global Constraints

- Preserve the existing two-attempt repair path for providers that return final JSON instead of calling `TaskOutput`.
- Do not expose hidden reasoning or complete child transcripts to the main context.
- A user abort must surface as `cancelled`, not `failed`, and must still drain every started child.
- Main-agent task copy remains unchanged; only delegated DAG nodes receive `/ subagent`.
- Grep filtering must behave consistently with ripgrep and the Node fallback.

---

### Task 1: Structured subagent completion

**Files:**
- Modify: `src/agent/subagents.ts`
- Modify: `src/production.ts`
- Modify: `src/tools/task-output.ts`
- Test: `tests/agent/subagents.test.ts`

**Interfaces:**
- Consumes: successful `AgentEvent` values for `TaskOutput` and the child context snapshot.
- Produces: `subagentResultFromTaskOutput(taskId, output)` and `parseFinalSubagentMessage(messages)` helpers returning strict scheduler input.

- [ ] Add regression tests proving a successful `TaskOutput` payload becomes a completed `SubagentResult` even when earlier text exists.
- [ ] Run `npm test -- tests/agent/subagents.test.ts` and confirm the new tests fail because the helpers do not exist.
- [ ] Export the `TaskOutputResult` type, add the conversion/final-message helpers, and make `runChild` prefer the tool result over the final-message fallback.
- [ ] Re-run `npm test -- tests/agent/subagents.test.ts` and confirm it passes.

### Task 2: Cancellation state propagation

**Files:**
- Modify: `src/agent/subagents.ts`
- Modify: `src/production.ts`
- Modify: `src/session/store.ts`
- Modify: `src/ui/transcript.ts`
- Test: `tests/agent/subagents.test.ts`
- Test: `tests/session/store.test.ts`
- Test: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: an aborted scheduler signal.
- Produces: `SubagentState` including `cancelled`; `SubagentStop.payload.status === "cancelled"`; persisted and rendered cancelled task snapshots.

- [ ] Extend scheduler tests to assert the stop hook receives `cancelled` on abort.
- [ ] Extend session/UI tests to reject the old state vocabulary and require a cancelled subagent row.
- [ ] Run the focused tests and confirm the expected failures.
- [ ] Add `cancelled` to state-only schemas/unions and map it to the UI cancelled state without creating a fake failed result.
- [ ] Re-run the focused tests and confirm they pass.

### Task 3: Grep file-type validation

**Files:**
- Modify: `src/tools/search.ts`
- Test: `tests/tools/search.test.ts`

**Interfaces:**
- Consumes: `fileType` from a finite Zod enum.
- Produces: consistent extension filtering in both ripgrep and Node search backends, including the friendly `text` type.

- [ ] Add tests that `file`, `files`, and `path` fail input validation while `text` searches `.txt` files in both backends.
- [ ] Run `npm test -- tests/tools/search.test.ts` and confirm invalid values are currently accepted or reach ripgrep.
- [ ] Centralize the supported type-to-extension map, derive the schema enum from it, and make ripgrep filter with those extensions rather than its environment-dependent built-in type names.
- [ ] Re-run the search tests and confirm they pass.

### Task 4: Delegated-task copy

**Files:**
- Modify: `src/ui/task-progress-model.ts`
- Modify: `src/ui/transcript.ts`
- Test: `tests/ui/task-progress-model.test.ts`
- Test: `tests/ui/transcript.test.ts`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: the existing `task.role` and DAG snapshot.
- Produces: `description / subagent · status` in static and terminal rows and `description / subagent` while running interactively.

- [ ] Add failing assertions for running, completed, failed, and cancelled subagent rows.
- [ ] Run the focused UI tests and confirm `/ subagent` is absent.
- [ ] Add the suffix in the presentation and snapshot-rendering paths without changing main task labels.
- [ ] Re-run the focused UI tests and confirm they pass.

### Task 5: Verification

**Files:**
- Modify only if verification exposes a regression.

**Interfaces:**
- Consumes: all changes above.
- Produces: a buildable package with no test regression.

- [ ] Run `npm test` and confirm all suites pass.
- [ ] Run `npm run typecheck` and confirm zero diagnostics.
- [ ] Run `npm run build` and confirm the distributable compiles.
- [ ] Review `git diff --check` and `git diff` for whitespace errors, unrelated changes, and accidental secrets.
