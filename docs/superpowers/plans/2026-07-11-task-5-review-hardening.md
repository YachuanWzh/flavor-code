# Task 5 Review Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce the reviewed tool-runtime ordering, lifecycle, read bounds, and conservative single-file patch invariants.

**Architecture:** Keep orchestration in `ToolRuntime` and filesystem policy inside the file factories. Fail closed on ambiguous hook decisions, filesystem errors, unsupported patch shapes, malformed hunks, and multi-file diffs.

**Tech Stack:** TypeScript 7, Node.js 20+, Zod 4, Vitest 4.

## Global Constraints

- Use the existing `HookBus` and `PermissionEngine` contracts.
- Follow RED/GREEN TDD for every behavior change.
- Keep all paths workspace-limited and cross-platform.
- Run focused tests, the full suite, and `npm run typecheck` before commit.

---

### Task 1: Runtime ordering and lifecycle

**Files:**
- Modify: `tests/tools/runtime.test.ts`
- Modify: `src/tools/runtime.ts`

**Interfaces:**
- Consumes: `HookBus.emit`, `HookBus.registerPayloadSchema`, `PermissionEngine.decide`.
- Produces: ordered `ToolRuntime.execute(call, context)` and idempotent `ToolRuntime.dispose(): void`.

- [ ] Add tests proving `PermissionRequest` occurs only after permission/pre-hook asks, its deny blocks execution, one main approval is shared across asks, subagents never invoke approval, and `dispose()` releases schema ownership.
- [ ] Run `npm test -- tests/tools/runtime.test.ts` and confirm failures identify current double-prompt/ignored-decision/missing-dispose behavior.
- [ ] Consolidate asks into one permission-request phase, inspect its decision, approve at most once for main, and retain/invoke schema disposers idempotently.
- [ ] Re-run `npm test -- tests/tools/runtime.test.ts` and confirm GREEN.

### Task 2: Bounded reads and safe writes

**Files:**
- Modify: `tests/tools/files.test.ts`
- Modify: `src/tools/files.ts`

**Interfaces:**
- Produces: `Read` that reads at most `maxBytes + 1`, validates the entire accepted buffer, and `Write`/`Edit` atomic cleanup observable by directory scan.

- [ ] Add tests for late NUL, late invalid UTF-8, actual byte-bound enforcement, and randomized temporary-file cleanup.
- [ ] Run `npm test -- tests/tools/files.test.ts` and confirm expected failures.
- [ ] Replace stat-then-unbounded-read with a bounded file-handle read and validate the full returned buffer; strengthen temp cleanup assertion.
- [ ] Re-run the focused file suite and confirm GREEN.

### Task 3: Conservative single-file ApplyPatch

**Files:**
- Modify: `tests/tools/files.test.ts`
- Modify: `src/tools/files.ts`

**Interfaces:**
- Produces: single-file creation/update patches only; deletion, rename/different headers, multi-file patches, malformed counts, no-final-newline markers, existing creation targets, and non-ENOENT creation errors fail before writes.

- [ ] Add tests covering each rejected patch form and assert original files remain unchanged.
- [ ] Run `npm test -- tests/tools/files.test.ts` and confirm RED.
- [ ] Parse and validate header identity, file count, hunk counts, and unsupported markers before filesystem writes; require absent creation destinations and catch only `ENOENT`.
- [ ] Re-run the focused file suite and confirm GREEN.

### Task 4: Verification and handoff

**Files:**
- Modify: `.superpowers/sdd/task-5-report.md` (ignored handoff artifact)

- [ ] Run `npm test -- tests/tools/runtime.test.ts tests/tools/files.test.ts`.
- [ ] Run `npm test` exactly once for final verification.
- [ ] Run `npm run typecheck` and `git diff --check`.
- [ ] Append RED/GREEN evidence, file list, self-review, and remaining concerns to the report.
- [ ] Commit tracked changes with `git commit -m "fix: enforce guarded tool invariants"`.
