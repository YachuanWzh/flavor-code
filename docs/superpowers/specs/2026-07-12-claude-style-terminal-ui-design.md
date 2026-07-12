# Claude-style Terminal UI Design

## Goal

Make the interactive CLI behave like Claude Code: conversation content grows downward in the terminal scrollback, the current prompt stays below a divider, submitted prompts remain visible, SSE output streams above the prompt, mouse scrolling navigates the whole terminal transcript, and Markdown syntax is rendered instead of exposed.

## Architecture

Ink is the sole owner of terminal rendering. Remove the raw `stdout` cursor-writing path and DECSTBM scroll region because they compete with Ink reconciliation and cause flicker, stale cursor positions, and overwritten rows.

The root UI has two layers:

1. A `Static` transcript containing completed user and assistant turns. Once committed, Ink writes these rows into normal terminal scrollback and never repaints them.
2. A dynamic tail containing the submitted prompt/current SSE response, approval prompt, divider, input line, and hint. Only this small tail is reconciled while streaming or typing.

On Enter, the user prompt moves into the dynamic turn immediately and the editable input clears. When the assistant turn finishes, the complete turn moves atomically into `Static`; the next empty prompt remains below it. Turns are keyed by stable IDs and always append, so later responses cannot replace earlier rows.

## Rendering

- The header is emitted once through `Static`.
- User prompts use a stable `❯` prefix and remain visible after submission.
- Assistant prose is rendered through the existing Markdown token renderer so `**`, heading markers, and code fences are not printed literally.
- Fenced code remains visually distinct and preserves whitespace.
- Tool, notice, error, usage, and compaction events become structured transcript lines rather than raw cursor writes.
- A full-width dim divider sits immediately above the prompt.
- The input line supports Unicode-aware editing and wrapping.

## Input and Scrolling

- Up/Down exclusively navigate prompt history when the prompt is idle.
- Mouse wheel, Page Up, and Page Down are not consumed by the app; the terminal handles scrollback.
- Left/Right, Backspace, Delete, Enter, approval keys, and Ctrl+C retain their current behavior.
- Typing changes only prompt state and does not mutate transcript state.

## Data Model

Use a turn model with a stable ID, submitted prompt, accumulated assistant blocks, and completion state. Session events update the active turn through a pure reducer. Completion appends the active turn to the immutable transcript and clears the active slot.

## Error Handling

Submission failures finalize the active turn with a redacted error block, preserving its user prompt. Cancellation finalizes any accumulated response. `/clear` clears both committed and active display state without deleting persisted session data. Terminal resize relies on Ink layout and does not issue cursor-position escape sequences.

## Testing

- Reducer tests prove submit visibility, append-only multi-turn ordering, streaming accumulation, finalization, cancellation/error preservation, and clear behavior.
- Renderer tests prove Markdown markers are absent while prose and code remain.
- Input tests prove Up/Down history navigation is separate from Page Up/Page Down and Unicode editing remains correct.
- A fake-stream integration test verifies repeated SSE chunks and prompt edits do not produce raw absolute cursor or scroll-region escapes.
- Run the complete test, typecheck, and build suites.

## Non-goals

- Pixel-perfect reproduction of Claude Code colors or branding.
- A custom scroll viewport inside the CLI.
- Persisting UI-only transcript formatting in session files.
