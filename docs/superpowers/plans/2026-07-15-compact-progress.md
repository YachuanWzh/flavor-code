# Compact Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a ten-cell blue/gray progress indicator while full context compaction runs.

**Architecture:** Context compaction publishes discrete progress through an optional observer. Production forwards main-agent progress as a session event; the transcript updates one status block in place and the terminal renders ten colored cells.

**Tech Stack:** TypeScript, React 19, Ink-compatible terminal renderer, Vitest.

## Global Constraints

- Work directly on the existing `main` branch.
- Render exactly ten cells; one blue cell represents each completed 10%.
- Preserve compaction transactionality, cancellation, and existing completion notices.
- Do not publish subagent compaction progress into the main terminal.

---

### Task 1: Define observable compaction progress

**Files:**
- Modify: `src/context/manager.ts`
- Modify: `src/context/summarizer.ts`
- Modify: `src/production.ts`
- Modify: `src/agent/types.ts`
- Test: `tests/context/manager.test.ts`
- Test: `tests/context/summarizer.test.ts`

**Interfaces:**
- Produces: `onCompactProgress?(percentage: number): void` and `{ type: "compact-progress"; progress: number }`.

- [ ] **Step 1: Write failing tests** for `[0, 10, 80, 90, 100]` manager milestones and summary streaming increments.
- [ ] **Step 2: Run tests to verify RED** with `npx vitest run tests/context/manager.test.ts tests/context/summarizer.test.ts`.
- [ ] **Step 3: Implement minimal progress callbacks** at existing lifecycle boundaries, clamp to ten-percent increments, and forward only main-agent events from production.
- [ ] **Step 4: Run tests to verify GREEN** with the same Vitest command.

### Task 2: Render the ten-cell progress row

**Files:**
- Modify: `src/ui/transcript.ts`
- Modify: `src/ui/app.tsx`
- Test: `tests/ui/transcript.test.ts`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: `{ type: "compact-progress"; progress: number }`.
- Produces: one `compact:progress` status block with `progress`, plus a ten-cell terminal row.

- [ ] **Step 1: Write failing reducer and render tests** that require in-place updates and exactly three blue/seven gray cells at 30%.
- [ ] **Step 2: Run tests to verify RED** with `npx vitest run tests/ui/transcript.test.ts tests/ui/app-render.test.tsx`.
- [ ] **Step 3: Implement minimal reducer and renderer changes** using `#5b8cff` for completed cells and `#525761` for remaining cells.
- [ ] **Step 4: Run tests to verify GREEN** with the same Vitest command.

### Task 3: Verify integration

**Files:**
- Modify only if verification exposes a defect.

- [ ] **Step 1: Run targeted tests** with `npx vitest run tests/context/manager.test.ts tests/context/summarizer.test.ts tests/ui/transcript.test.ts tests/ui/app-render.test.tsx tests/cli/session.test.ts`.
- [ ] **Step 2: Run the full suite** with `npm test`.
- [ ] **Step 3: Run static and build checks** with `npm run typecheck` and `npm run build`.
- [ ] **Step 4: Inspect `git diff --check` and the final diff** for whitespace, unrelated changes, and requirement coverage.
