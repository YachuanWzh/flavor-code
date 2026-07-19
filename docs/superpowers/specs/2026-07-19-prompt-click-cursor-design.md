# Prompt Click-to-Cursor Design

## Goal

Allow a single mouse click inside the bottom prompt input to move the editing cursor to the clicked position. The behavior is limited to the prompt input; transcript content, task panels, completion menus, and global mouse dispatch remain unchanged.

## Interaction

- Clicking a character positions the cursor at the nearest insertion boundary for that terminal cell.
- Clicking blank space after a visible prompt line positions the cursor at that line's end.
- Clicking the prompt gutter positions the cursor at that line's start.
- Clicking anywhere inside a collapsed pasted-text label positions the source cursor at the end of that pasted block.
- Only a completed single click changes the cursor. Existing drag selection and double-click selection behavior remains intact.
- Click results are clamped to the valid source-input cursor range.

## Architecture

`App` owns `promptCursor` and passes an `onCursorChange` callback through `TerminalLayout` to `PromptLine`. No other UI region receives this callback.

Each visible row rendered by `PromptLine` receives an `onClick` handler. The handler combines its wrapped line index with the event's row-local column and calls a pure cursor-mapping helper. Attaching the handler at the row boundary reuses the renderer's existing hit testing and avoids global coordinate or layout-ref calculations.

The pure helper converts the clicked visual cell into a cursor offset in the displayed prompt. It accounts for the two-column prompt gutter, automatic wrapping, clipped prompt windows, and terminal display widths for ASCII, CJK characters, and emoji. A click inside a wide character resolves to the nearest insertion boundary; a tie resolves after the character so clicking its visible body advances naturally.

The displayed offset is then mapped back to the original input offset. Ordinary text maps one-to-one. Collapsed pasted-text labels map their entire displayed range to the end of the corresponding source paste. This reverse mapping shares the same ordered, non-overlapping pasted-block matches used to produce the collapsed presentation, preventing the renderer and click behavior from disagreeing.

## Data Flow

1. The terminal's existing mouse handling dispatches a `ClickEvent` to a visible prompt row.
2. `PromptLine` reads `event.localCol` and the row's absolute wrapped-line index.
3. The pure helper resolves a displayed insertion offset using terminal cell widths.
4. The pasted-block reverse map converts that displayed offset to a source-input cursor.
5. `onCursorChange` updates `promptCursor`; the input text and pasted-block state are unchanged.

## Boundaries and Failure Handling

The feature does not modify the terminal mouse protocol, hit testing, selection state, transcript content, task scrolling, menus, or input text. Out-of-range rows and columns are clamped to the nearest valid line boundary. If pasted-block metadata no longer matches the source input, that text is treated as ordinary prompt text, matching the current collapsed-rendering fallback.

## Testing

Tests are written before production changes and cover:

- single-line ASCII clicks at the start, middle, and end;
- clicks in the prompt gutter and blank space after a line;
- automatic wrapping and a clipped multi-line prompt window;
- CJK and emoji display-cell widths, including clicks inside a wide character;
- clicks anywhere in a collapsed pasted-text label mapping to the source paste end;
- component wiring that changes only `promptCursor` for clicks inside prompt rows;
- existing selection, transcript, menu, input, build, and type checks remaining unaffected.

## Scope

This change adds click-to-cursor behavior only to the prompt input. It does not add transcript cursor placement, mouse-based editing outside the prompt, selection changes, paste expansion, or drag-to-position behavior.
