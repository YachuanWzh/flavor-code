# File Diff Rendering Design

## Goal

Render file changes in the terminal with the same information hierarchy as Claude Code: a compact operation header, an added/removed summary, numbered context lines, and red or green full-line backgrounds for removed and added content.

## Scope

- Existing-file changes made by `Edit` and `ApplyPatch` display a contextual diff.
- New files created by `Write` display their contents as added lines.
- Existing files overwritten by `Write` display removed and added lines.
- A future file-deletion operation displays only the deletion state and file name; this work does not add deletion support.
- Read-only and non-file tools keep their current one-line status presentation.

## Visual Design

- The header uses a green status bullet followed by `Update(file)` for modifications and `Create(file)` for new files.
- The summary is indented beneath the header and reports exact added and removed line counts.
- Context lines have no background, subdued line numbers, and white content.
- Removed lines use a deep red full-line background. Their old line number and `-` marker are red; their content is white.
- Added lines use a deep green full-line background. Their new line number and `+` marker are green; their content is white.
- Columns align across context, removed, and added lines, including files with three-digit or larger line numbers.
- Long previews are bounded so a single tool call cannot consume the terminal viewport indefinitely.

## Architecture

File tools produce presentation-only structured metadata alongside their normal result. The runtime separates that metadata from the model-facing tool output and includes it only in the UI-facing `tool-end` event. This preserves current model context while giving the terminal accurate paths, operation kind, line counts, line numbers, and context.

The transcript stores the structured file-change presentation on the existing tool status block. The terminal selects a dedicated diff view for completed successful file changes and retains the current status-row view for running, failed, cancelled, and unrelated tools.

## Data Flow

1. A file tool reads the original content and computes the final content as it already does.
2. It derives a bounded structured preview containing operation type and numbered lines.
3. The runtime returns the existing serialized output to the model and attaches the preview only to the emitted tool result event.
4. The transcript reducer replaces the running tool row with a completed block carrying the preview.
5. The terminal renders the operation header, summary, and colored rows.

## Diff Rules

- `Edit` uses the exact matched location in the original file, with nearby unchanged lines.
- `ApplyPatch` uses the validated unified-diff hunks and their old/new starting lines.
- `Write` compares the previous content when the destination exists and treats every content line as added when it does not.
- Adjacent changes share context without duplicating lines.
- Empty final sentinel lines are not rendered as source lines.
- Preview truncation keeps the beginning and end of the structured diff and inserts a neutral omission row.

## Error Handling

- Presentation generation must never change whether a file operation succeeds.
- Failed and cancelled operations use the existing failure status and do not show a success diff.
- Malformed or unavailable presentation metadata falls back to the existing completed status row.

## Testing

- Unit tests cover structured previews for edits, patches, new files, overwrites, line numbering, counts, context, and truncation.
- Transcript tests verify that a running status becomes a completed file-change block without changing chronological ordering.
- render tests verify operation labels, summary text, visible line numbers and markers, white content, red/green foreground markers, and red/green background ANSI sequences.
- The full test suite, typecheck, and production build run before handoff.

## Constraints

- Work directly on `main`; do not create a worktree.
- Preserve the user's unrelated changes in `README.md` and `技术方案报告.md`.
- Do not add file-deletion capability or unrelated UI refactors.
