# Flavor Startup Welcome and Terminal Title Design

## Goal

Improve Flavor's empty startup screen with a compact Claude Code-inspired welcome card, and make the VS Code integrated terminal list show `flavor` instead of `node`.

## Scope

- Show the welcome card only while the interactive transcript is empty and no prompt is active.
- Hide it as soon as the first prompt is submitted; resumed conversations with hydrated history do not show it.
- Preserve the existing transcript, task panel, prompt, completion menus, scrolling, and current uncommitted workspace changes.
- Keep all changes on `main` as requested.

## Welcome Card

The existing one-line startup header becomes a bordered, Flavor-branded empty-state card. The card uses the terminal's existing warm yellow accent instead of copying Claude branding.

On sufficiently wide terminals, the card has two columns:

1. A welcome area with `Welcome back!`, a compact terminal-safe Flavor wordmark, the selected model, and the workspace name.
2. A getting-started area with durable tips and commands such as `/init` and `/help`.

On narrow terminals, the card uses a compact single-column presentation so it does not overflow or crowd the prompt. The card contains no network-backed content and no changelog text that can become stale.

The existing compact `flavor · model · workspace` line remains the conversation header once the welcome card is hidden.

## Display State

`TerminalLayout` derives the empty state from existing data rather than adding persistent UI state. The welcome card is visible when:

- `completed.length === 0`, and
- `active` is undefined.

This makes it disappear synchronously when the transcript reducer creates the first active turn and keeps it absent for hydrated/resumed history.

## Terminal Identity

Flavor keeps the existing OSC terminal-title update for terminal emulators that honor window-title sequences. Interactive startup additionally sets Node's process title to `flavor`, which is the identity VS Code commonly displays for the foreground process in its terminal list.

The process-title change is limited to interactive mode. `flavor --print`, `flavor init`, version output, and embedding/test consumers do not receive the side effect merely by importing the CLI module.

## Error Handling and Compatibility

- Terminal widths are clamped before choosing the wide or compact card.
- Content uses terminal-safe text and existing Ink layout primitives.
- Title setting is a best-effort local process property assignment and introduces no new I/O or cleanup path.
- Existing user edits in overlapping UI files are extended in place and never reverted.

## Testing

- Renderer tests verify the welcome content appears for an empty transcript.
- Renderer tests verify it disappears for an active or hydrated/completed transcript.
- Renderer tests verify compact output remains within narrow terminal widths.
- CLI tests verify interactive startup applies the `flavor` process title without changing non-interactive command behavior.
- Run focused tests, the full test suite, type checking, build, and install smoke verification.

## Non-goals

- Pixel-perfect reproduction of Claude Code.
- Dynamic release notes, network content, or configurable welcome-card copy.
- Redesigning transcript rendering or task progress behavior.
