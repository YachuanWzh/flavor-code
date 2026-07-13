# File Diff Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render accurate Claude Code-style file diffs for successful file creation and modification tool calls.

**Architecture:** File tools attach non-enumerable, presentation-only metadata to their existing output objects. `ToolRuntime` exposes that metadata on UI events without serializing it into model tool results; the transcript stores it and `TerminalLayout` renders a dedicated diff block.

**Tech Stack:** TypeScript 7, React 19, Ink 7, Vitest 4, custom Claude Ink renderer.

## Global Constraints

- Work directly on `main`; do not create a worktree.
- Preserve unrelated changes in `README.md` and `技术方案报告.md`.
- Existing-file changes made by `Edit` and `ApplyPatch` display a contextual diff.
- New files created by `Write` display their contents as added lines; overwritten text files display removed and added lines.
- Do not add file-deletion capability; only keep the presentation type capable of representing deletion later.
- Diff content is `#f8f8f2`; removed backgrounds are `#3d0100`; added backgrounds are `#022800`.
- Removed and added line numbers/markers remain red and green respectively; unchanged line numbers are subdued.
- Limit a preview to 120 rows, inserting a neutral omission row while retaining full added/removed counts.

---

### Task 1: Structured file-diff presentation model

**Files:**
- Create: `src/tools/file-diff.ts`
- Modify: `src/tools/types.ts`
- Create: `tests/tools/file-diff.test.ts`

**Interfaces:**
- Produces: `FileChangePresentation`, `FileDiffLine`, `withToolPresentation()`, and `getToolPresentation()` from `src/tools/types.ts`.
- Produces: `buildFileChangePresentation(path, before, after, operation)` and `buildPatchPresentation(path, created, hunks)` from `src/tools/file-diff.ts`.

- [ ] **Step 1: Write failing presentation-model tests**

Cover a contiguous update with three context lines, file creation, old/new line numbering, exact full counts, patch hunk conversion, and 120-row truncation:

```ts
const preview = buildFileChangePresentation("notes.md", before, after, "update");
expect(preview).toMatchObject({ kind: "file-change", operation: "update", added: 1, removed: 1 });
expect(preview.lines).toContainEqual({ kind: "removed", oldLine: 4, text: "old" });
expect(preview.lines).toContainEqual({ kind: "added", newLine: 4, text: "new" });
expect(preview.lines.length).toBeLessThanOrEqual(120);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/tools/file-diff.test.ts`

Expected: FAIL because `src/tools/file-diff.ts` and the presentation interfaces do not exist.

- [ ] **Step 3: Implement presentation types and builders**

Use these exact public shapes:

```ts
export interface FileDiffLine {
  kind: "context" | "removed" | "added" | "omitted";
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileChangePresentation {
  kind: "file-change";
  operation: "create" | "update" | "delete";
  path: string;
  added: number;
  removed: number;
  lines: FileDiffLine[];
}
```

Attach metadata through a module-private symbol defined in `types.ts`. Add it with `Object.defineProperty(..., { enumerable: false })` so `JSON.stringify(output)` remains unchanged. For ordinary file comparisons, remove the shared line prefix/suffix, retain up to three surrounding context lines, assign old/new numbers, then truncate. For parsed patch hunks, translate the existing ` `, `-`, and `+` prefixes while advancing old/new counters.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm test -- tests/tools/file-diff.test.ts`

Expected: all file-diff tests PASS.

### Task 2: Attach previews to successful file-tool results without model-context cost

**Files:**
- Modify: `src/tools/files.ts`
- Modify: `src/tools/runtime.ts`
- Modify: `src/tools/types.ts`
- Modify: `tests/tools/files.test.ts`
- Modify: `tests/tools/runtime.test.ts`

**Interfaces:**
- Consumes: builders and symbol helpers from Task 1.
- Produces: `ToolResult.presentation?: FileChangePresentation` for UI consumers while preserving the existing `ToolResult.output` JSON.

- [ ] **Step 1: Write failing file-tool and runtime tests**

Assert that successful `Edit`, `ApplyPatch`, new-file `Write`, and overwrite `Write` outputs carry the expected preview through `getToolPresentation()`. Assert runtime behavior with:

```ts
const result = await runtime.execute(call, { agent: "main" });
expect(result.presentation).toMatchObject({ kind: "file-change", operation: "update" });
expect(JSON.stringify(result.output)).toBe('{"path":"...","replacements":1}');
```

Use structural JSON assertions rather than a platform-specific absolute path string.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm test -- tests/tools/files.test.ts tests/tools/runtime.test.ts`

Expected: FAIL because file tools do not attach presentations and runtime does not expose them.

- [ ] **Step 3: Attach previews in file tools**

- `Edit`: build the preview from the already-read original and computed updated text before `atomicWrite`.
- `ApplyPatch`: retain `newStart` in `PatchHunk`, create a preview from the validated hunk, and attach it to `{ files }`.
- `Write`: read existing text only for presentation; missing destinations become `create`, text destinations become `update`, and unreadable/binary presentation data falls back to the current status without preventing the write.
- Never alter the existing enumerable tool output fields.

- [ ] **Step 4: Extract presentation in ToolRuntime**

After execution and `PostToolUse`, read the non-enumerable presentation and return:

```ts
return {
  ok: true,
  output,
  ...(presentation === undefined ? {} : { presentation }),
};
```

Keep `toolResultMessage()` unchanged so the model still receives only `result.output`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- tests/tools/files.test.ts tests/tools/runtime.test.ts tests/agent/loop.test.ts`

Expected: all selected tests PASS and existing tool event/result assertions remain valid.

### Task 3: Preserve previews in transcript state

**Files:**
- Modify: `src/ui/transcript.ts`
- Modify: `tests/ui/transcript.test.ts`

**Interfaces:**
- Consumes: `ToolResult.presentation` from Task 2.
- Produces: optional `presentation` on non-task status blocks.

- [ ] **Step 1: Write a failing reducer test**

Start `Edit`, finish it with a successful result containing a file-change presentation, and assert the same presentation is stored on `tool:<id>` while chronological text/tool ordering remains unchanged.

- [ ] **Step 2: Run the reducer test and verify RED**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: FAIL because status blocks discard the presentation.

- [ ] **Step 3: Store presentation only for successful tool ends**

Extend the status block type with `presentation?: FileChangePresentation`. On `tool-end`, copy `event.result.presentation` only when `event.result.ok`; keep failed, cancelled, running, task, and informational blocks unchanged.

- [ ] **Step 4: Run the reducer test and verify GREEN**

Run: `npm test -- tests/ui/transcript.test.ts`

Expected: all transcript tests PASS.

### Task 4: Render the Claude Code-style diff block

**Files:**
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: `FileChangePresentation` stored on completed status blocks.
- Produces: `FileDiffView` and `FileDiffRow` terminal components.

- [ ] **Step 1: Write a failing render test**

Create a completed turn containing one file-change block and assert the plain output contains `● Update(notes.md)`, `Added 1 line, removed 1 line`, aligned `-`/`+` rows, and content. Assert the raw ANSI output contains:

```ts
expect(raw).toContain("\x1b[48;2;61;1;0m");   // #3d0100 removed background
expect(raw).toContain("\x1b[48;2;2;40;0m");  // #022800 added background
expect(raw).toContain("\x1b[38;2;248;248;242m"); // #f8f8f2 white content
```

- [ ] **Step 2: Run the render test and verify RED**

Run: `npm test -- tests/ui/app-render.test.tsx`

Expected: FAIL because completed file changes still render as one-line statuses.

- [ ] **Step 3: Implement the dedicated view**

In `TurnView`, render `FileDiffView` when a non-task status has `state === "completed"` and a file-change presentation. Use `basename(path)` in the title, English singular/plural summary copy, the maximum visible line number to align the gutter, full-width row boxes for colored backgrounds, white content text, and colored marker/line-number text. Render deletion as only `● Delete(file)` without summary or rows.

- [ ] **Step 4: Run the render test and verify GREEN**

Run: `npm test -- tests/ui/app-render.test.tsx`

Expected: all app rendering tests PASS.

### Task 5: Full verification

**Files:**
- Modify only files required to fix regressions caused by Tasks 1–4.

**Interfaces:**
- Consumes: all prior task deliverables.
- Produces: a verified build ready for the user's manual terminal test.

- [ ] **Step 1: Run the complete automated test suite**

Run: `npm test`

Expected: all test files and tests PASS with zero failures.

- [ ] **Step 2: Run static type checking**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: exit code 0 and updated `dist` output with no build errors.

- [ ] **Step 4: Review scope and working tree**

Run: `git diff --check` and `git status --short`.

Expected: no whitespace errors; user-owned `README.md` and `技术方案报告.md` changes remain untouched and unstaged.
