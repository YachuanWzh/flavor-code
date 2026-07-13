# Stable Scroll and Streaming Markdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the prompt visible, scroll the transcript by visual rows, isolate history navigation to Up/Down, and preserve stable Markdown rendering during SSE.

**Architecture:** Replace the turn-slicing experiment with a fixed-height alternate-screen layout containing a clipped, row-offset transcript viewport and a non-shrinking bottom prompt area. Model scroll behavior as a pure sticky-bottom state machine, measure Yoga content after layout, and render Markdown as one keyed sequence of immutable blocks plus one mutable tail.

**Tech Stack:** TypeScript, React 19, Ink 7, Yoga layout refs, Marked, Vitest

## Global Constraints

- Keep interactive rendering in the alternate screen.
- Enable only DEC mouse modes 1000 and 1006 and restore them from one lifecycle owner.
- Wheel and PageUp/PageDown scroll transcript rows; Up/Down navigate prompt history only.
- Retain semantic Markdown rendering; never introduce raw cursor writes or a second output path.
- Do not vendor a custom Ink fork unless the public Ink integration tests fail.
- Preserve unrelated working-tree changes.

## File Structure

- Create `src/ui/scroll-viewport.tsx`: pure scroll state transitions, viewport handle, Yoga measurement, clipping, and sticky follow.
- Replace `src/ui/mouse.ts`: narrow SGR wheel parser and DEC lifecycle constants; no React scroll state.
- Modify `src/ui/app.tsx`: fixed-height layout, viewport wiring, prompt/history separation, and removal of turn slicing.
- Modify `src/cli.tsx`: single mouse lifecycle owner with `try/finally` cleanup.
- Modify `src/ui/markdown.tsx`: stable keyed streaming block cache and mutable tail rendering.
- Create `tests/ui/scroll-viewport.test.tsx`: state-machine and visual-row clipping tests.
- Modify `tests/ui/mouse.test.ts`: wheel decoding and mode tests.
- Modify `tests/ui/input.test.ts`: explicit history-versus-scroll routing tests.
- Modify `tests/ui/app-render.test.tsx`: fixed-height prompt visibility regression.
- Modify `tests/ui/markdown.test.tsx`: safe block promotion and stable key tests.

---

### Task 1: Visual-row scroll state and clipped viewport

**Files:**
- Create: `src/ui/scroll-viewport.tsx`
- Create: `tests/ui/scroll-viewport.test.tsx`

**Interfaces:**
- Produces: `ScrollState`, `ScrollMeasurement`, `updateScroll(state, action)`, `ScrollViewportHandle`, and `ScrollViewport`.
- `ScrollViewportHandle` exposes `scrollBy(rows)`, `pageBy(fraction)`, `scrollToBottom()`, and `isSticky()`.

- [ ] **Step 1: Write failing pure state tests**

Test that measurement while sticky sets `scrollTop = max(0, contentHeight - viewportHeight)`, wheel-up clears sticky and subtracts rows, content growth while non-sticky preserves `scrollTop`, and scrolling down to the maximum restores sticky.

- [ ] **Step 2: Run the state tests and verify RED**

Run: `npm test -- --run tests/ui/scroll-viewport.test.tsx`

Expected: FAIL because `src/ui/scroll-viewport.tsx` does not exist.

- [ ] **Step 3: Implement the minimal pure state machine**

Use these contracts:

```ts
export interface ScrollState { scrollTop: number; sticky: boolean }
export interface ScrollMeasurement { contentHeight: number; viewportHeight: number }
export type ScrollAction =
  | { type: "measure"; measurement: ScrollMeasurement }
  | { type: "scroll-by"; rows: number; measurement: ScrollMeasurement }
  | { type: "bottom"; measurement: ScrollMeasurement };

export function updateScroll(state: ScrollState, action: ScrollAction): ScrollState;
```

Clamp every result to `0..maxScroll`. A downward action whose target reaches `maxScroll` returns `sticky: true`; any upward action returns `sticky: false`.

- [ ] **Step 4: Verify state tests pass**

Run: `npm test -- --run tests/ui/scroll-viewport.test.tsx`

Expected: PASS.

- [ ] **Step 5: Add a failing visual clipping test**

Render a four-row viewport containing `line-1` through `line-8` at `scrollTop=3`; assert output is exactly `line-4` through `line-7`.

- [ ] **Step 6: Implement `ScrollViewport`**

Render a fixed/clipped outer `Box` and a full-height inner column with `marginTop={-state.scrollTop}`. Read both Yoga refs in `useLayoutEffect`, dispatch a `measure` action after transcript/layout changes, and expose the imperative handle. Keep the full child tree mounted.

- [ ] **Step 7: Verify clipping and state tests pass**

Run: `npm test -- --run tests/ui/scroll-viewport.test.tsx`

Expected: PASS with no React state-during-render warning.

### Task 2: Mouse decoding and input ownership

**Files:**
- Modify: `src/ui/mouse.ts`
- Modify: `tests/ui/mouse.test.ts`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Produces: `parseWheelInput(input): "up" | "down" | null`, `ENABLE_MOUSE_TRACKING`, and `DISABLE_MOUSE_TRACKING`.
- Consumes: `ScrollViewportHandle` from Task 1 in the next task.

- [ ] **Step 1: Replace current tests with failing behavior tests**

Assert raw and Ink-stripped SGR sequences decode, modifier bits such as button 80/81 still decode, click/release/malformed sequences return `null`, enable uses only `?1000h` and `?1006h`, and disable reverses both.

- [ ] **Step 2: Run mouse tests and verify RED**

Run: `npm test -- --run tests/ui/mouse.test.ts`

Expected: FAIL because the current constants include mode 1003 and the parser exposes generic mouse events.

- [ ] **Step 3: Implement the minimal wheel parser**

Parse `(?:ESC)?[<button;x;yM`, mask button with `0x43`, return `up` for `0x40`, `down` for `0x41`, and `null` otherwise. Do not own React state or write to stdout.

- [ ] **Step 4: Verify mouse tests pass**

Run: `npm test -- --run tests/ui/mouse.test.ts`

Expected: PASS.

- [ ] **Step 5: Add routing assertions**

Extend input helper tests so `upArrow/downArrow` map only to `navigateHistory`, while page and wheel actions map only to scroll commands. Extract a pure `classifyTerminalInput(character, key)` helper if direct App testing would require a runtime mock.

- [ ] **Step 6: Run routing tests**

Run: `npm test -- --run tests/ui/input.test.ts`

Expected: FAIL until the classifier exists, then PASS after its minimal implementation.

### Task 3: Fixed-height transcript and pinned prompt

**Files:**
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/app-render.test.tsx`
- Modify: `src/cli.tsx`

**Interfaces:**
- Consumes: `ScrollViewport`, `ScrollViewportHandle`, and `parseWheelInput`.
- Produces: `TerminalLayout` with a fixed `rows` root and a pinned bottom slot.

- [ ] **Step 1: Write the long-SSE layout regression**

Render `TerminalLayout` with a small row count and one active response containing more visual lines than the viewport. Assert rendered output has at most `rows` lines and its final rows contain the divider, prompt, and hint.

- [ ] **Step 2: Run the layout test and verify RED**

Run: `npm test -- --run tests/ui/app-render.test.tsx`

Expected: FAIL because the current content column grows beyond the terminal and turn slicing does not constrain a long active turn.

- [ ] **Step 3: Rebuild `TerminalLayout` around `ScrollViewport`**

Use a root `<Box height={rows} flexDirection="column" overflow="hidden">`. Put header, completed turns, and active turn inside `ScrollViewport flexGrow={1}`. Put approval, divider, prompt, and hint inside `<Box flexShrink={0} flexDirection="column">`. Remove `scrollOffset`, `isScrolled`, `visibleCompleted`, and every `completed.slice(...)` path.

- [ ] **Step 4: Wire App input**

Hold a `scrollRef`. Route parsed wheel-up/down to `scrollBy(-3/+3)`, PageUp/PageDown to half-page scrolling, and leave Up/Down history logic unchanged. On submit, call `scrollToBottom()` before dispatching the prompt.

- [ ] **Step 5: Consolidate mouse lifecycle in CLI**

Write `ENABLE_MOUSE_TRACKING` once immediately before `render`, await exit inside `try`, and write `DISABLE_MOUSE_TRACKING` in `finally`. Remove mouse-writing effects/hooks from UI files.

- [ ] **Step 6: Verify layout and input tests pass**

Run: `npm test -- --run tests/ui/app-render.test.tsx tests/ui/input.test.ts tests/ui/mouse.test.ts tests/ui/scroll-viewport.test.tsx`

Expected: PASS.

### Task 4: Stable streaming Markdown blocks

**Files:**
- Modify: `src/ui/markdown.tsx`
- Modify: `tests/ui/markdown.test.tsx`

**Interfaces:**
- Produces: `createStreamingMarkdownState()`, `advanceStreamingMarkdown(state, text)`, and `StreamingMarkdownBlock` with stable `key`, absolute `start`, `raw`, `token`, and `stable` fields.
- `MarkdownView` renders all blocks in one parent sequence so promotion never moves a block between parents.

- [ ] **Step 1: Write failing promotion tests**

Feed cumulative chunks containing a paragraph, heading, list, emphasis, and fenced code. Assert previously closed blocks keep the same key and token object identity, only the final block changes, an unclosed fence stays mutable, and a closed fence becomes eligible for promotion at a safe following boundary.

- [ ] **Step 2: Run Markdown tests and verify RED**

Run: `npm test -- --run tests/ui/markdown.test.tsx`

Expected: FAIL because the current implementation moves tokens between `StableMarkdown` and `StreamingTail` parents and does not expose stable block state.

- [ ] **Step 3: Implement incremental block state**

Keep immutable stable blocks plus `tailStart`. On append, lex only `text.slice(tailStart)`. Assign keys as `${absoluteStart}:${token.type}`. Promote syntax-safe tokens before the mutable final token; retain their token objects permanently. If text is replaced rather than appended, reset state.

- [ ] **Step 4: Render one keyed block sequence**

Remove the separate `StableMarkdown` and `StreamingTail` parent components. Map stable blocks and current tail blocks together through memoized `BlockToken`, using absolute keys. Preserve existing heading, list, inline, table, quote, and highlighted code views.

- [ ] **Step 5: Verify Markdown tests pass**

Run: `npm test -- --run tests/ui/markdown.test.tsx`

Expected: PASS and rendered output contains semantic text without raw Markdown delimiters.

### Task 5: Full regression and fallback decision

**Files:**
- Modify only files required by failures caused by Tasks 1-4.

**Interfaces:**
- Produces: verified public-Ink scrolling implementation or an evidence-backed decision to vendor the complete Claude Code scroll boundary.

- [ ] **Step 1: Run focused UI tests**

Run: `npm test -- --run tests/ui`

Expected: all UI tests PASS.

- [ ] **Step 2: Run static verification**

Run: `npm run typecheck && npm run build`

Expected: both commands exit 0 without TypeScript or bundling errors.

- [ ] **Step 3: Run the full suite**

Run: `npm test`

Expected: all test files PASS.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check` and `git diff --stat`.

Expected: no whitespace errors; changes remain limited to scrolling, input routing, CLI mouse lifecycle, Markdown streaming, tests, and their documentation.

- [ ] **Step 5: Apply the fallback only on demonstrated failure**

If the clipping integration test cannot keep the prompt within `rows`, stop the public-Ink path and port Claude Code's complete `ScrollBox` boundary: scroll DOM fields, renderer translation/culling, and wheel parsing together. Do not retain both implementations.
