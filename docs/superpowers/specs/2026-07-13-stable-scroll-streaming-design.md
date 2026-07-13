# Stable Scroll and Streaming Markdown Design

## Goal

The interactive terminal UI must keep the prompt visible at the bottom, scroll the transcript by visual rows with the mouse wheel, reserve Up/Down for prompt history, and render streaming Markdown without visible layout jitter.

## Reference Architecture

Claude Code's reconstructed source uses a constrained alternate-screen root, a row-scrolling `ScrollBox`, sticky-bottom state, and a separate non-shrinking bottom slot. Its `ScrollBox` is backed by a custom Ink renderer, so its component cannot be copied alone into this project.

Ink 7 already supports the required layout primitives: a fixed-height root, vertical clipping, Yoga element refs, and negative child offsets. A focused prototype proved that a clipped fixed-height box can display an arbitrary visual-row window. The project will therefore reproduce Claude Code's architecture with public Ink 7 primitives. It will not reuse the current turn-slicing experiment. If integration tests expose a renderer limitation, the fallback is to vendor and adapt the complete Claude Code scrolling boundary (component, renderer support, and input parser) rather than copy only its surface API.

## Layout

Interactive rendering remains in the alternate screen. The root is exactly the current terminal row count and contains two vertical siblings:

1. A transcript viewport with `flexGrow={1}`, `flexShrink={1}`, and vertical clipping.
2. A bottom area with `flexShrink={0}` containing approvals, divider, prompt, and hint text.

The bottom area may be capped when the prompt wraps, but transcript growth can never push it outside the terminal. A long active SSE response increases transcript content height only.

The viewport retains the complete transcript. It reads Yoga-computed content and viewport heights after layout, derives `maxScrollTop`, and moves content upward by a visual-row offset. Scrolling is therefore line based and also works for a single response taller than the terminal.

## Scroll State

The viewport starts in sticky-bottom mode. When transcript content grows during SSE, sticky mode advances to the new bottom. Wheel-up, PageUp, or an explicit upward jump disables sticky mode and preserves the visible rows while new content arrives. Scrolling to the bottom re-enables sticky mode.

Mouse tracking enables only DEC modes 1000 and 1006, sufficient for SGR wheel events. Mode 1003 is excluded because all-motion reporting creates unnecessary input traffic. Tracking is enabled and disabled in one lifecycle owner and is restored through cleanup.

Wheel and PageUp/PageDown operate only on the transcript viewport. Up/Down operate only on prompt history. Modified SGR wheel button codes are decoded by masking modifier bits.

## Stable Streaming Markdown

Markdown remains semantically rendered throughout SSE. Streaming text is divided into stable completed blocks and one mutable tail:

- Closed paragraphs, headings, lists, block quotes, thematic breaks, and fenced code blocks are promoted to stable blocks.
- Stable blocks retain deterministic keys and are memoized, so later chunks do not reparse or remount them.
- Only the incomplete trailing block is reparsed when a buffered SSE update arrives.
- Promotion occurs only at syntax-safe boundaries. An unclosed fence, list item, or paragraph remains in the mutable tail until its boundary is known.
- The existing short SSE buffer remains the update cadence boundary; no raw cursor writes or independent output path is introduced.

This keeps Markdown formatting while preventing already-visible content from changing component identity or reflowing on every chunk. Sticky scrolling responds to actual height growth after layout rather than guessing from chunk length.

## Testing

Tests will be written before production changes and must cover:

- A transcript containing one response taller than the viewport is clipped by visual rows.
- The prompt and hint remain inside the fixed terminal height during long SSE output.
- Wheel events change transcript row offset and never navigate prompt history.
- Up/Down navigate history and do not scroll the transcript.
- Sticky-bottom follows SSE growth, breaks on upward scrolling, and resumes at the bottom.
- Completed Markdown blocks retain stable identities while only the trailing block changes.
- Representative headings, lists, emphasis, and fenced code remain formatted during streaming.
- Existing UI, typecheck, build, and full test suites continue to pass.

## Scope

The change is limited to terminal layout, transcript scrolling, mouse input separation, and streaming Markdown stability. It does not add transcript virtualization, selection support, click handling, or a general-purpose Ink fork unless the public-API implementation fails its integration tests.
