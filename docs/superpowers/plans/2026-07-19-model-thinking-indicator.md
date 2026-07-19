# Model Thinking Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show an animated, elapsed-time thinking row for every physical main-agent model call.

**Architecture:** Add balanced model-call lifecycle events at the agent boundary, reduce them into a transient transcript status block, and render the block through the existing animated status component. Visible text or a model-end event removes the transient block so ordinary output and tools take over cleanly.

**Tech Stack:** TypeScript, React 19, Ink-compatible terminal components, Vitest.

## Global Constraints

- Do not add dependencies.
- Do not create a worktree.
- Do not commit changes.
- Use `Flavoring… (<elapsed>s · thinking)` as the user-visible copy.

---

### Task 1: Model-call lifecycle events

**Files:**
- Modify: `src/agent/types.ts`
- Modify: `src/agent/loop.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Produces: `AgentEvent` variants `{ type: "model-start"; id: string }` and `{ type: "model-end"; id: string }`.
- Guarantees: every provider stream that emits `model-start` emits one matching `model-end` before retry, tool execution, terminal error, or completion handling.

- [ ] **Step 1: Write a failing lifecycle test**

Add a test that runs a response containing a tool call followed by a text response and asserts the filtered event order is `model-start`, `model-end`, `tool-start`, `tool-end`, `model-start`, `text`, `model-end` with distinct invocation ids.

- [ ] **Step 2: Verify the test fails**

Run: `npm test -- tests/agent/loop.test.ts`

Expected: FAIL because model lifecycle event variants are not emitted.

- [ ] **Step 3: Implement balanced events**

Add the two event variants and allocate a monotonically increasing id inside each `run()` invocation. Yield `model-start` immediately before consuming `adapter.stream()`, and yield the matching `model-end` after the stream and `AfterModelCall` hook finish, before retry or tool processing.

- [ ] **Step 4: Verify the focused test passes**

Run: `npm test -- tests/agent/loop.test.ts`

Expected: PASS.

### Task 2: Transient transcript state

**Files:**
- Modify: `src/ui/transcript.ts`
- Test: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: `model-start` and `model-end` events.
- Produces: a running status block with `activity: "model"`, id `model:<invocation id>`, and `startedAt`.
- Guarantees: visible text, model end, done, error, and finish paths cannot retain the transient block.

- [ ] **Step 1: Write failing reducer tests**

Assert that model start creates the activity block, first text removes it while preserving text, model end removes it for tool-only responses, and a second model start creates a new block with a new timestamp.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: FAIL because the reducer does not understand model lifecycle events.

- [ ] **Step 3: Implement minimal reducer behavior**

Extend status blocks with `activity?: "model"`, add a helper that removes model-activity blocks, and invoke it from lifecycle and terminal paths before applying the next visible state.

- [ ] **Step 4: Verify the reducer tests pass**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: PASS.

### Task 3: Animated Flavoring presentation

**Files:**
- Modify: `src/ui/task-progress-model.ts`
- Modify: `src/ui/task-progress.tsx`
- Test: `tests/ui/task-progress-model.test.ts`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: a running status block with `activity: "model"`.
- Produces: animated orange glyph, orange `Flavoring…`, elapsed seconds, and blue `thinking` label.

- [ ] **Step 1: Write failing presentation and render tests**

Assert the presentation at 6,000 ms contains `Flavoring… (6s · thinking)`, uses the activity frame, and the terminal layout renders the indicator beneath the submitted prompt.

- [ ] **Step 2: Verify the tests fail**

Run: `npm test -- tests/ui/task-progress-model.test.ts tests/ui/app-render.test.tsx`

Expected: FAIL because model activity has no dedicated presentation.

- [ ] **Step 3: Implement the presentation**

Add the model-activity branch before task presentation. Reuse `activityFrame()` and `formatElapsed()`, extend the independently colored suffix handling to render `thinking` in `#81c8f2`, and keep the row in the chronological transcript rather than the task panel.

- [ ] **Step 4: Verify focused tests pass**

Run: `npm test -- tests/ui/task-progress-model.test.ts tests/ui/app-render.test.tsx`

Expected: PASS.

### Task 4: Integration verification

**Files:**
- Verify only; fix scoped regressions in files from Tasks 1-3.

**Interfaces:**
- Consumes: the completed lifecycle, reducer, and presentation changes.
- Produces: verified source, tests, type declarations, and build output.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: all tests pass with zero failures.

- [ ] **Step 2: Run the compiler**

Run: `npm run typecheck`

Expected: exit code 0 with no diagnostics.

- [ ] **Step 3: Build the distributable**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 4: Review the working-tree diff**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; only the scoped source, tests, and design/plan documents are changed, with no commit created.
