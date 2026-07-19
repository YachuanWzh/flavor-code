# Prompt Click-to-Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the editing cursor to a clicked position inside the bottom prompt input, while mapping clicks on collapsed paste labels to the end of their source paste.

**Architecture:** Keep mouse handling scoped to `PromptLine` and reuse the renderer's existing per-row `ClickEvent.localCol`. Add one pure mapping helper in `src/ui/app.tsx` that converts wrapped display coordinates to source-input code-point offsets using shared pasted-block spans, then wire its result to `App`'s existing `setPromptCursor` state owner.

**Tech Stack:** TypeScript 7, React 19, Ink-compatible `claude-ink` components, Vitest 4.

## Global Constraints

- Work directly on the current `main` checkout; do not create a worktree.
- Add click handling only to prompt input rows.
- Do not change transcript content, task panels, completion menus, selection behavior, or global mouse dispatch.
- A click anywhere inside a collapsed pasted-text label maps to the end of the original pasted block.
- Preserve existing drag selection and double-click selection behavior.
- Preserve unrelated dirty-worktree changes and stage only files changed by this feature.

---

## File Structure

- Modify `src/ui/app.tsx`: share pasted-block display spans, implement pure click-to-source mapping, and wire prompt-row clicks to `promptCursor`.
- Create `tests/ui/prompt-click.test.tsx`: cover coordinate mapping and prompt-only component wiring without adding test-only production APIs.

### Task 1: Pure Display-to-Source Cursor Mapping

**Files:**
- Modify: `src/ui/app.tsx:870-960`
- Create: `tests/ui/prompt-click.test.tsx`

**Interfaces:**
- Consumes: `wrapPromptInput(input, cursor, { columns, indent })`, `charWidth(codePoint)`, and existing `PastedBlock` metadata.
- Produces: `promptCursorFromClick(input, pastedBlocks, position): number`, where `position` is `{ columns: number; lineIndex: number; localColumn: number }` and `lineIndex` is the absolute wrapped-line index.

- [ ] **Step 1: Write failing mapping tests**

Create `tests/ui/prompt-click.test.tsx`:

```tsx
import { describe, expect, it } from "vitest";

import { promptCursorFromClick } from "../../src/ui/app.js";

describe("promptCursorFromClick", () => {
  it("maps prompt gutter, text cells, and trailing blank space", () => {
    const at = (localColumn: number): number => promptCursorFromClick(
      "hello",
      [],
      { columns: 12, lineIndex: 0, localColumn },
    );

    expect(at(0)).toBe(0);
    expect(at(4)).toBe(2);
    expect(at(99)).toBe(5);
  });

  it("maps an absolute wrapped row back to its source offset", () => {
    expect(promptCursorFromClick(
      "abcdef",
      [],
      { columns: 5, lineIndex: 1, localColumn: 3 },
    )).toBe(4);
  });

  it("uses terminal cell widths for wide characters", () => {
    const beforeWide = promptCursorFromClick(
      "a界b",
      [],
      { columns: 12, lineIndex: 0, localColumn: 3 },
    );
    const afterWide = promptCursorFromClick(
      "a界b",
      [],
      { columns: 12, lineIndex: 0, localColumn: 4 },
    );

    expect(beforeWide).toBe(1);
    expect(afterWide).toBe(2);
  });

  it("maps every cell in a collapsed paste label to the source paste end", () => {
    const pasted = "first line\nsecond line";
    const prefix = "pre ";
    const input = `${prefix}${pasted} tail`;
    const sourceEnd = [...`${prefix}${pasted}`].length;

    expect(promptCursorFromClick(
      input,
      [{ id: 1, text: pasted }],
      { columns: 80, lineIndex: 0, localColumn: 2 + [...prefix].length },
    )).toBe(sourceEnd);
    expect(promptCursorFromClick(
      input,
      [{ id: 1, text: pasted }],
      { columns: 80, lineIndex: 0, localColumn: 2 + [...prefix].length + 8 },
    )).toBe(sourceEnd);
  });
});
```

- [ ] **Step 2: Run the mapping tests and verify RED**

Run:

```powershell
npm test -- --run tests/ui/prompt-click.test.tsx -t promptCursorFromClick
```

Expected: FAIL because `promptCursorFromClick` is not exported.

- [ ] **Step 3: Share pasted spans and implement the minimal mapper**

In `src/ui/app.tsx`, import the existing width helper:

```ts
import { charWidth } from "./char-width.js";
```

Replace the internals of `pastedDraftPresentation` with a shared model while preserving its public return type:

```ts
interface PastedDraftMatch {
  sourceStartPoint: number;
  sourceEndPoint: number;
  displayStartPoint: number;
  displayEndPoint: number;
  label: string;
}

interface PastedDraftModel extends PromptEditState {
  matches: PastedDraftMatch[];
}

function pastedDraftModel(
  input: string,
  cursor: number,
  blocks: readonly PastedBlock[],
): PastedDraftModel {
  const sourceMatches: Array<{
    start: number;
    end: number;
    startPoint: number;
    endPoint: number;
    label: string;
  }> = [];

  for (const block of blocks) {
    const extraLines = block.text.split(/\r\n|\r|\n/u).length - 1;
    if (extraLines === 0 || block.text.length === 0) continue;

    let start = input.indexOf(block.text);
    while (start >= 0) {
      const end = start + block.text.length;
      const overlaps = sourceMatches.some((match) => start < match.end && end > match.start);
      if (!overlaps) {
        sourceMatches.push({
          start,
          end,
          startPoint: [...input.slice(0, start)].length,
          endPoint: [...input.slice(0, end)].length,
          label: `[Pasted text #${block.id} +${extraLines} lines]`,
        });
        break;
      }
      start = input.indexOf(block.text, start + 1);
    }
  }

  if (sourceMatches.length === 0) return { text: input, cursor, matches: [] };
  sourceMatches.sort((left, right) => left.start - right.start);

  let text = "";
  let sourceOffset = 0;
  const matches: PastedDraftMatch[] = [];
  for (const match of sourceMatches) {
    text += input.slice(sourceOffset, match.start);
    const displayStartPoint = [...text].length;
    text += match.label;
    const displayEndPoint = [...text].length;
    matches.push({
      sourceStartPoint: match.startPoint,
      sourceEndPoint: match.endPoint,
      displayStartPoint,
      displayEndPoint,
      label: match.label,
    });
    sourceOffset = match.end;
  }
  text += input.slice(sourceOffset);

  let pointDelta = 0;
  let mappedCursor = cursor;
  for (const match of matches) {
    const labelLength = match.displayEndPoint - match.displayStartPoint;
    if (cursor <= match.sourceStartPoint) break;
    if (cursor < match.sourceEndPoint) {
      mappedCursor = match.displayEndPoint;
      break;
    }
    pointDelta += labelLength - (match.sourceEndPoint - match.sourceStartPoint);
    mappedCursor = cursor + pointDelta;
  }

  return { text, cursor: mappedCursor, matches };
}

export function pastedDraftPresentation(
  input: string,
  cursor: number,
  blocks: readonly PastedBlock[],
): PromptEditState {
  const model = pastedDraftModel(input, cursor, blocks);
  return { text: model.text, cursor: model.cursor };
}
```

Add the pure mapping helpers next to `pastedDraftPresentation`:

```ts
export interface PromptClickPosition {
  columns: number;
  lineIndex: number;
  localColumn: number;
}

function codePointIndexAtVisualColumn(line: string, targetColumn: number): number {
  const points = [...line];
  const target = Math.max(0, targetColumn);
  let visualColumn = 0;

  for (let index = 0; index < points.length; index += 1) {
    const width = charWidth(points[index]!.codePointAt(0) ?? 0);
    if (target <= visualColumn) return index;
    if (target < visualColumn + width) {
      return target - visualColumn < width / 2 ? index : index + 1;
    }
    visualColumn += width;
  }

  return points.length;
}

function sourceCursorFromDisplayed(model: PastedDraftModel, displayedCursor: number): number {
  let sourceOffset = 0;
  let displayOffset = 0;

  for (const match of model.matches) {
    if (displayedCursor < match.displayStartPoint) {
      return sourceOffset + displayedCursor - displayOffset;
    }
    if (displayedCursor <= match.displayEndPoint) return match.sourceEndPoint;
    sourceOffset = match.sourceEndPoint;
    displayOffset = match.displayEndPoint;
  }

  return sourceOffset + displayedCursor - displayOffset;
}

export function promptCursorFromClick(
  input: string,
  blocks: readonly PastedBlock[],
  position: PromptClickPosition,
): number {
  const model = pastedDraftModel(input, 0, blocks);
  const wrap = wrapPromptInput(model.text, 0, { columns: position.columns, indent: 2 });
  const lineIndex = Math.max(0, Math.min(wrap.lines.length - 1, position.lineIndex));
  const beforeLine = wrap.lines
    .slice(0, lineIndex)
    .reduce((total, line) => total + [...line].length, 0);
  const withinLine = codePointIndexAtVisualColumn(
    wrap.lines[lineIndex] ?? "",
    position.localColumn - 2,
  );
  const sourceCursor = sourceCursorFromDisplayed(model, beforeLine + withinLine);
  return Math.max(0, Math.min([...input].length, sourceCursor));
}
```

- [ ] **Step 4: Run the mapping tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/ui/prompt-click.test.tsx -t promptCursorFromClick
```

Expected: four tests PASS.

- [ ] **Step 5: Run existing paste and wrapping regressions**

Run:

```powershell
npm test -- --run tests/ui/wrap-prompt.test.ts tests/ui/app-render.test.tsx -t "wrapPromptInput|collapses pasted draft text"
```

Expected: matching tests PASS and the existing collapsed-paste label remains unchanged.

- [ ] **Step 6: Commit the pure mapping change**

```powershell
git add -- src/ui/app.tsx tests/ui/prompt-click.test.tsx
git commit -m "feat(ui): map prompt clicks to cursor positions"
```

### Task 2: Prompt-Only Click Wiring

**Files:**
- Modify: `src/ui/app.tsx:420-570, 820-870`
- Modify: `tests/ui/prompt-click.test.tsx`

**Interfaces:**
- Consumes: `promptCursorFromClick(input, pastedBlocks, position): number` from Task 1 and `ClickEvent.localCol` from `src/claude-ink/events/click-event.ts`.
- Produces: optional `TerminalLayoutProps.onPromptCursorChange?: (cursor: number) => void` and `PromptLine` row handlers scoped to the input.

- [ ] **Step 1: Write a failing prompt-row wiring test**

Update the imports at the top of `tests/ui/prompt-click.test.tsx` to:

```tsx
import React from "react";
import { describe, expect, it } from "vitest";

import { ClickEvent } from "../../src/claude-ink/events/click-event.js";
import { PromptLine, promptCursorFromClick } from "../../src/ui/app.js";
```

Then append the wiring test:

```tsx

it("moves the cursor from a click on the visible prompt row", () => {
  const moved: number[] = [];
  const prompt = PromptLine({
    input: "abcdef",
    pastedBlocks: [],
    cursor: 6,
    columns: 7,
    maxVisibleLines: 1,
    onCursorChange: (cursor) => moved.push(cursor),
  });
  const row = React.Children.toArray(prompt.props.children)[0] as React.ReactElement<{
    onClick?: (event: ClickEvent) => void;
  }>;
  const event = new ClickEvent(0, 0, false);
  event.localCol = 3;

  row.props.onClick?.(event);

  expect(moved).toEqual([4]);
});
```

`columns: 7` gives `PromptLine` five inner columns and three content columns per wrapped row. With `maxVisibleLines: 1` and the current cursor at the end, only the second row (`def`) is visible; clicking its second content cell must therefore map to source cursor `4`, proving the handler uses the absolute wrapped row rather than visible row zero.

- [ ] **Step 2: Run the wiring test and verify RED**

Run:

```powershell
npm test -- --run tests/ui/prompt-click.test.tsx -t "moves the cursor"
```

Expected: FAIL because `PromptLine` is not exported and has no `onCursorChange` property.

- [ ] **Step 3: Wire the callback only through the prompt input**

In `App`, pass the state owner to `TerminalLayout`:

```tsx
onPromptCursorChange={setPromptCursor}
```

Add the optional callback to `TerminalLayoutProps`:

```ts
onPromptCursorChange?: (cursor: number) => void;
```

Destructure `onPromptCursorChange` in `TerminalLayout` and pass it only to `PromptLine`:

```tsx
<PromptLine
  input={input}
  pastedBlocks={pastedBlocks}
  cursor={promptCursor}
  columns={columns}
  maxVisibleLines={promptMaxLines}
  completedSlashTokenLength={tokenLength}
  {...(onPromptCursorChange === undefined ? {} : { onCursorChange: onPromptCursorChange })}
/>
```

Export `PromptLine`, extend its props, and add the handler to each visible row:

```tsx
export function PromptLine({
  input,
  pastedBlocks,
  cursor,
  columns,
  maxVisibleLines,
  completedSlashTokenLength: tokenLength = 0,
  onCursorChange,
}: {
  input: string;
  pastedBlocks: readonly PastedBlock[];
  cursor: number;
  columns: number;
  maxVisibleLines?: number;
  completedSlashTokenLength?: number;
  onCursorChange?: (cursor: number) => void;
}): React.JSX.Element {
```

Keep the existing wrapping and visibility calculations. Replace the visible row's opening `<Box>` with:

```tsx
<Box
  key={lineIndex}
  {...(onCursorChange === undefined ? {} : {
    onClick: (event: ClickEvent) => {
      onCursorChange(promptCursorFromClick(input, pastedBlocks, {
        columns: innerColumns,
        lineIndex,
        localColumn: event.localCol,
      }));
      event.stopImmediatePropagation();
    },
  })}
>
```

Do not add `onClick` to `TerminalLayout`, transcript rows, task panels, menus, or the bottom-area container.

- [ ] **Step 4: Run the wiring and mapping tests and verify GREEN**

Run:

```powershell
npm test -- --run tests/ui/prompt-click.test.tsx
```

Expected: five tests PASS.

- [ ] **Step 5: Run adjacent UI regressions**

Run:

```powershell
npm test -- --run tests/ui/input.test.ts tests/ui/wrap-prompt.test.ts tests/ui/app-render.test.tsx
```

Expected: all existing tests in these three files PASS. If unrelated concurrently-added tests fail, confirm the failing names do not exercise `PromptLine`, `promptCursorFromClick`, or pasted-draft presentation before proceeding.

- [ ] **Step 6: Run project verification**

Run:

```powershell
npm run typecheck
npm run build
npm test
git diff --check -- src/ui/app.tsx tests/ui/prompt-click.test.tsx
```

Expected: typecheck and build exit `0`; the full suite reports no click-to-cursor regression. Any pre-existing failure outside these two changed files must be reported with its exact test name and output and must not be fixed as part of this feature.

- [ ] **Step 7: Commit the prompt wiring**

```powershell
git add -- src/ui/app.tsx tests/ui/prompt-click.test.tsx
git commit -m "feat(ui): move prompt cursor on click"
```
