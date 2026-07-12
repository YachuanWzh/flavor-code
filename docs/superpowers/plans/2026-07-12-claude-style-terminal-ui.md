# Claude-style Terminal UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the conflicting raw terminal renderer with an append-only Claude Code-style transcript and stable bottom prompt.

**Architecture:** Ink exclusively renders the UI. Completed turns are frozen through `Static`; one active turn and the prompt form the small dynamic tail, while a pure reducer maps session events into display state.

**Tech Stack:** TypeScript 7, React 19, Ink 7, marked, Vitest 4

## Global Constraints

- Preserve existing uncommitted user changes outside the files explicitly changed by this plan.
- Do not emit DECSTBM or absolute cursor-position escapes from application code.
- Mouse wheel/Page Up/Page Down remain owned by terminal scrollback; only Up/Down navigate query history.
- Submitted queries must become visible synchronously on Enter.
- Markdown control markers must not appear in finalized assistant output.

---

### Task 1: Append-only transcript reducer

**Files:**
- Create: `src/ui/transcript.ts`
- Create: `tests/ui/transcript.test.ts`

**Interfaces:**
- Produces: `TranscriptState`, `TranscriptAction`, `transcriptReducer(state, action)`, and `createTranscriptState()`.
- Consumes: `SessionOutput` from `src/ui/session.ts`.

- [ ] **Step 1: Write failing reducer tests**

Cover `submit` creating a visible active prompt, text chunks concatenating in order, tool/status events appending blocks, `done` moving the active turn to `completed`, an error retaining the prompt, a second turn appending after the first, and `clear` emptying display state.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: FAIL because `src/ui/transcript.ts` does not exist.

- [ ] **Step 3: Implement the pure state model**

Define stable turn IDs, separate user text from assistant event blocks, and return new state objects for every action. `finish` must append rather than replace:

```ts
export interface TranscriptState {
  completed: TranscriptTurn[];
  active?: TranscriptTurn;
  nextId: number;
}

export type TranscriptAction =
  | { type: "submit"; prompt: string }
  | { type: "session"; event: SessionOutput }
  | { type: "submit-error"; message: string }
  | { type: "finish" }
  | { type: "clear" };
```

- [ ] **Step 4: Run the focused tests**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: PASS.

### Task 2: Semantic assistant renderer

**Files:**
- Modify: `src/ui/markdown.tsx`
- Modify: `src/ui/assistant-text.tsx`
- Modify: `tests/ui/assistant-text.test.ts`
- Create: `tests/ui/markdown.test.tsx`

**Interfaces:**
- Produces: `AssistantText({ text })` that renders semantic terminal content without literal Markdown fences or emphasis markers.
- Consumes: assistant text blocks from `TranscriptTurn`.

- [ ] **Step 1: Write failing renderer tests**

Render representative prose, `**bold**`, headings, lists, inline code, and fenced TypeScript. Assert visible output contains semantic text/code and excludes `**`, leading `#`, and triple backticks.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/ui/assistant-text.test.ts tests/ui/markdown.test.tsx`

Expected: FAIL because the current plain renderer exposes Markdown markers or the render contract is absent.

- [ ] **Step 3: Consolidate semantic rendering**

Make `AssistantText` delegate to the Markdown token renderer. Keep the 50,000-character fallback, but sanitize fence/emphasis markers in that fallback. Preserve fenced code whitespace and language labels without printing fences.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/ui/assistant-text.test.ts tests/ui/markdown.test.tsx`

Expected: PASS.

### Task 3: Replace raw terminal painting with Static transcript

**Files:**
- Modify: `src/ui/app.tsx`
- Delete: `src/ui/raw-stream.ts`
- Delete: `src/ui/scroll-region.ts`
- Delete: `tests/ui/raw-stream.test.ts`
- Delete: `tests/ui/scroll-region.test.ts`
- Create: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: `transcriptReducer`, `TranscriptTurn`, `AssistantText`, and existing `SessionOutput`.
- Produces: an Ink tree with a `Static` completed transcript and dynamic active turn/input tail.

- [ ] **Step 1: Write failing app rendering tests**

Use Ink's test renderer with a fake runtime seam. Assert Enter immediately shows the submitted prompt, streamed chunks appear above the divider, completing two turns preserves both in order, and captured output contains neither `\x1B[...r` nor application-generated absolute cursor moves.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/ui/app-render.test.tsx`

Expected: FAIL against the current raw stream/scroll-region architecture.

- [ ] **Step 3: Implement the single-renderer tree**

Replace `renderedMessages`, `bandLines`, `RawStreamHandle`, terminal row reservation, resize bookkeeping, and DECSTBM effects with `useReducer(transcriptReducer, ...)`. Render completed turns using Ink `Static`, then the active turn, approvals, a dim full-width divider, `PromptLine`, and the hint. Dispatch `submit` before invoking `session.submit` and dispatch every `SessionOutput` into the reducer.

- [ ] **Step 4: Remove obsolete raw renderer files and imports**

Delete the raw stream and scroll-region implementation/tests only after no production imports remain.

- [ ] **Step 5: Run UI tests**

Run: `npm test -- tests/ui`

Expected: PASS.

### Task 4: Terminal-owned scrolling and history-only arrows

**Files:**
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Produces: `applyHistoryKey(...)` or an equivalent pure helper used by `useInput`.
- Consumes: prompt history, cursor position, and Ink key metadata.

- [ ] **Step 1: Write failing input tests**

Assert Up/Down traverse the 200-entry prompt history; Page Up/Page Down do not mutate input/history cursor; ordinary typing after history recall edits the recalled value; and Unicode cursor editing still passes.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/ui/input.test.ts`

Expected: FAIL until history behavior is isolated behind the pure helper.

- [ ] **Step 3: Implement isolated history navigation**

Keep only `key.upArrow` and `key.downArrow` in the history path. Return without state changes for `pageUp`/`pageDown`, allowing the host terminal to interpret mouse-generated scroll events outside application input handling.

- [ ] **Step 4: Run focused tests**

Run: `npm test -- tests/ui/input.test.ts`

Expected: PASS.

### Task 5: Full verification

**Files:**
- Modify only files needed to fix regressions introduced by Tasks 1–4.

**Interfaces:**
- Consumes: the completed UI implementation.
- Produces: verified build artifacts and test evidence.

- [ ] **Step 1: Run all tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 2: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Build the package**

Run: `npm run build`

Expected: exit code 0 and refreshed `dist/` output.

- [ ] **Step 4: Run install smoke test**

Run: `npm run smoke:install`

Expected: exit code 0 with working `flavor --version` and `flavor --help` checks.
