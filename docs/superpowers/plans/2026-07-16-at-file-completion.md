# `@` File Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an ignore-aware workspace file menu opened by `@`, with mouse selection, Up/Down navigation, Tab completion, and Escape dismissal.

**Architecture:** Keep deterministic mention parsing, ranking, windowing, and replacement in a focused `mention-completion` module. Reuse `createGlobTool` for bounded workspace discovery, let `App` own active-menu state and key routing, and keep `TerminalLayout` responsible for clickable rendering only.

**Tech Stack:** TypeScript 7, React 19, the repository's Ink-compatible terminal renderer, Vitest 4, and the existing ripgrep/Node glob implementation.

## Global Constraints

- Work directly on the existing `main` branch; do not create a worktree.
- The reference screenshot is the visual baseline.
- Discover at most 10,000 ignore-aware workspace files; do not add dependencies.
- Display at most six rows.
- Up and Down wrap selection, Tab completes, Escape dismisses, and clicking a nonblank row completes it.
- Do not embed file contents, show directories, add fuzzy matching, or alter agent-side prompt semantics.
- Existing slash completion, prompt editing, history navigation, approvals, and active-session input behavior must remain unchanged.

---

### Task 1: Mention Completion Model

**Files:**
- Create: `src/ui/mention-completion.ts`
- Create: `tests/ui/mention-completion.test.ts`

**Interfaces:**
- Consumes: workspace-relative path strings and prompt text represented by Unicode code points.
- Produces: `MentionCompletion`, `buildMentionCandidates()`, `deriveMentionCompletion()`, `moveMentionSelection()`, and `completeMentionSelection()`.

- [ ] **Step 1: Write failing model tests**

Create tests covering activation, rejection of email-like text, ranking, wrapping, visible window movement, surrounding-text preservation, and escaped spaces:

```ts
import { describe, expect, it } from "vitest";
import {
  buildMentionCandidates,
  completeMentionSelection,
  deriveMentionCompletion,
  moveMentionSelection,
} from "../../src/ui/mention-completion.js";

describe("mention completion", () => {
  const candidates = buildMentionCandidates([
    "src/ui/app.tsx", "docs/app-notes.md", "src/app.test.ts", "docs/my notes.md",
  ]);

  it("opens for a whitespace-delimited at token and rejects email text", () => {
    expect(deriveMentionCompletion("review @app", 11, candidates, 0)?.items)
      .toEqual(["src/app.test.ts", "src/ui/app.tsx", "docs/app-notes.md"]);
    expect(deriveMentionCompletion("me@example.com", 14, candidates, 0)).toBeNull();
  });

  it("wraps selection and keeps the selected row in a bounded window", () => {
    expect(moveMentionSelection(0, -1, 3)).toBe(2);
    expect(moveMentionSelection(2, 1, 3)).toBe(0);
    expect(deriveMentionCompletion("@", 1, Array.from({ length: 8 }, (_, i) => `${i}.ts`), 7, 6)?.windowStart)
      .toBe(2);
  });

  it("replaces only the active token and escapes spaces", () => {
    expect(completeMentionSelection("review @my later", 10, "docs/my notes.md"))
      .toEqual({ text: "review @docs/my\\ notes.md later", cursor: 26 });
  });
});
```

- [ ] **Step 2: Run the model test and verify the missing-module failure**

Run: `npx vitest run tests/ui/mention-completion.test.ts`

Expected: FAIL because `src/ui/mention-completion.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure model**

Define these exact interfaces and functions:

```ts
export interface MentionCompletion {
  query: string;
  items: string[];
  selectedIndex: number;
  windowStart: number;
}

export function buildMentionCandidates(paths: readonly string[]): string[];
export function deriveMentionCompletion(
  input: string,
  cursor: number,
  candidates: readonly string[],
  selectedIndex: number,
  visibleLimit?: number,
): MentionCompletion | null;
export function moveMentionSelection(index: number, delta: -1 | 1, count: number): number;
export function completeMentionSelection(
  input: string,
  cursor: number,
  path: string,
): { text: string; cursor: number };
```

Normalize `\\` to `/`, remove duplicate paths, and sort with `/`-aware `localeCompare`. Detect the active token by scanning backward from the code-point cursor for an unescaped whitespace boundary and requiring `@` at that boundary. Scan forward through escaped spaces to find the replacement end. Rank filename-prefix matches first, then whole-path-prefix matches, then other substring matches; use path order as the tie-breaker. Escape literal spaces as `\ ` on insertion.

- [ ] **Step 4: Run model tests**

Run: `npx vitest run tests/ui/mention-completion.test.ts`

Expected: all mention-completion tests PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/ui/mention-completion.ts tests/ui/mention-completion.test.ts
git commit -m "feat(ui): add at file completion model"
```

### Task 2: App State, File Discovery, and Keyboard Routing

**Files:**
- Modify: `src/ui/app.tsx:1-360`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Consumes: Task 1 exports, `createGlobTool(workspace)`, and `SearchResult<string>`.
- Produces: `CompletionKeyAction`, `completionKeyAction()`, ignore-aware mention candidates, and derived mention state passed to `TerminalLayout`.

- [ ] **Step 1: Add failing key-routing tests**

Replace slash-only routing coverage with the active-menu-neutral helper and keep a slash regression assertion:

```ts
import { completionKeyAction } from "../../src/ui/app.js";

it("routes selection keys only while a completion menu is open", () => {
  const open = true;
  expect(completionKeyAction({ upArrow: true, downArrow: false, tab: false, escape: false }, open))
    .toEqual({ type: "select", delta: -1 });
  expect(completionKeyAction({ upArrow: false, downArrow: true, tab: false, escape: false }, open))
    .toEqual({ type: "select", delta: 1 });
  expect(completionKeyAction({ upArrow: false, downArrow: false, tab: true, escape: false }, open))
    .toEqual({ type: "complete" });
  expect(completionKeyAction({ upArrow: false, downArrow: false, tab: false, escape: true }, open))
    .toEqual({ type: "dismiss" });
  expect(completionKeyAction({ upArrow: true, downArrow: false, tab: false, escape: false }, false))
    .toBeNull();
});
```

- [ ] **Step 2: Run the routing test and verify failure**

Run: `npx vitest run tests/ui/input.test.ts`

Expected: FAIL because `completionKeyAction` is not exported.

- [ ] **Step 3: Generalize key routing without changing slash behavior**

Add:

```ts
export type CompletionKeyAction =
  | { type: "select"; delta: -1 | 1 }
  | { type: "complete" }
  | { type: "dismiss" };

export function completionKeyAction(
  key: Pick<Key, "upArrow" | "downArrow" | "tab" | "escape">,
  menuOpen: boolean,
): CompletionKeyAction | null;
```

Have the existing `slashKeyAction()` delegate to `completionKeyAction(key, completion !== null)` so its public behavior and existing tests remain intact.

- [ ] **Step 4: Add candidate discovery and mention state**

Import `createGlobTool` and `SearchResult`, start an abortable mount effect, and use:

```ts
const result = await createGlobTool(workspace, { defaultLimit: 10_000 }).execute(
  { pattern: "**", limit: 10_000 },
  controller.signal,
) as SearchResult<string>;
setMentionCandidates(buildMentionCandidates(result.matches));
```

Contain discovery errors unless the effect is still active and the error represents an explicit abort. Add `mentionCandidates`, `mentionSelection`, and `dismissedMentionInput` state. Derive mention completion only when slash completion is null and no session, approval, or question UI is active.

- [ ] **Step 5: Route keyboard completion and expose a shared insertion callback**

Before history navigation, route keys to slash completion first and mention completion second. For mention selection call `moveMentionSelection`; for Tab call `completeMentionSelection`; for Escape record the current input. Add a local `selectMention(path: string)` callback that applies the same completion operation so mouse and Tab cannot drift. Reset mention selection and dismissal on text edits and prompt submission.

- [ ] **Step 6: Run focused routing and model tests**

Run: `npx vitest run tests/ui/input.test.ts tests/ui/mention-completion.test.ts tests/ui/slash-completion.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 7: Commit app behavior**

```bash
git add src/ui/app.tsx tests/ui/input.test.ts
git commit -m "feat(ui): route at file completion input"
```

### Task 3: Clickable Mention Menu Rendering

**Files:**
- Modify: `src/ui/app.tsx:378-530`
- Modify: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: `MentionCompletion` and `onMentionSelect?: (path: string) => void` from `App`.
- Produces: exported `MentionMenu`, clickable candidate rows, match highlighting, and menu-aware bottom layout.

- [ ] **Step 1: Add failing render and click-binding tests**

Render `TerminalLayout` with a mention completion and assert the paths, selected marker, highlighted query ANSI, and footer copy are present. Also call the exported `MentionMenu` directly, find its first row element, invoke its `onClick` once with `{ cellIsBlank: false }` and once with `{ cellIsBlank: true }`, and assert the callback receives the path only for the nonblank click.

Use this completion fixture:

```ts
const completion: MentionCompletion = {
  query: "app",
  items: ["src/app.test.ts", "src/ui/app.tsx"],
  selectedIndex: 1,
  windowStart: 0,
};
```

Expected plain-text footer: `Up/Down select · Tab complete · click choose · Esc close` using the repository's existing middle-dot glyph.

- [ ] **Step 2: Run render tests and verify failure**

Run: `npx vitest run tests/ui/app-render.test.tsx`

Expected: FAIL because `TerminalLayout` has no mention props and `MentionMenu` does not exist.

- [ ] **Step 3: Extend layout props and row budgeting**

Add:

```ts
mentionCompletion?: MentionCompletion;
onMentionSelect?: (path: string) => void;
```

Calculate menu rows from whichever completion is active, render the mention menu in the same fixed-bottom slot as `SlashMenu`, and preserve every existing layout branch when neither menu is present.

- [ ] **Step 4: Implement clickable rows**

Export:

```tsx
export function MentionMenu({
  completion,
  onSelect,
}: {
  completion: MentionCompletion;
  onSelect?: (path: string) => void;
}): React.JSX.Element;
```

Render each row as a width-constrained `Box` with:

```tsx
onClick={(event) => {
  if (!event.cellIsBlank) onSelect?.(path);
}}
```

Use `slashCandidatePresentation()` for the active marker and `HighlightedName` for query highlighting. Update the menu-open footer to include `click choose` while keeping the current slash and non-menu hints unchanged.

- [ ] **Step 5: Run focused UI tests**

Run: `npx vitest run tests/ui/app-render.test.tsx tests/ui/input.test.ts tests/ui/mention-completion.test.ts tests/ui/slash-completion.test.ts`

Expected: all focused UI tests PASS.

- [ ] **Step 6: Commit rendering**

```bash
git add src/ui/app.tsx tests/ui/app-render.test.tsx
git commit -m "feat(ui): add clickable at file menu"
```

### Task 4: Full Verification and Review

**Files:**
- Modify only files directly implicated by a verification failure.

**Interfaces:**
- Consumes: the complete mention model, App integration, and clickable renderer.
- Produces: a verified `main` branch with no unrelated working-tree changes.

- [ ] **Step 1: Run the full test suite**

Run: `npm test`

Expected: every Vitest suite PASS.

- [ ] **Step 2: Run static type checking**

Run: `npm run typecheck`

Expected: exit code 0 and no TypeScript diagnostics.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: tsup completes successfully and writes the configured bundles.

- [ ] **Step 4: Inspect the cumulative diff**

Run: `git diff e382d00 --check && git diff --stat e382d00 && git status --short`

Expected: no whitespace errors, only the planned source/test/plan files, and no uncommitted implementation changes after the task commits.

- [ ] **Step 5: Review behavior against the design**

Confirm from tests and code that `@` opens only at a token boundary, Up/Down never enter history while the menu is open, Tab and clicks share the same insertion function, blank-cell clicks do nothing, ignored files are excluded by `createGlobTool`, and slash completion is unchanged.
