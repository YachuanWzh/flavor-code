# Model Thinking Indicator Design

## Goal

Give users immediate, continuous feedback whenever the main agent is waiting for an LLM response, including model calls that happen after tool execution.

## Interaction

- Each physical model call starts a transient status row with an animated orange glyph.
- The row reads `Flavoring… (<elapsed>s · thinking)`; `thinking` uses the existing cool-blue accent.
- The elapsed timer starts at zero for every model call and updates with the existing 120 ms animation cadence.
- The row disappears as soon as visible assistant text arrives. If the response contains only tool calls, it remains visible until that model call ends, then the tool status takes over.
- A later model call creates a fresh row and timer, so tool-result follow-up thinking is visible too.
- Retry, cancellation, error, and normal completion must not leave a stale thinking row.

## Architecture

`AgentLoop` emits model-neutral `model-start` and `model-end` lifecycle events around each physical provider stream. The transcript reducer turns `model-start` into one transient status block and removes it on `model-end`, visible text, terminal events, or cancellation. The existing task status presentation and animation utilities render the row, keeping timing and spinner behavior consistent with current progress UI.

The lifecycle events deliberately omit provider and model identifiers. They describe user-visible activity without exposing configuration details.

## Error Handling

- Every started provider stream emits a matching end event, including provider failures and incomplete streams.
- A retry ends the previous indicator before showing retry information and starts a new indicator for the next attempt.
- Terminal transcript paths defensively remove any active model indicator.

## Testing

- Agent-loop tests assert balanced lifecycle events across a text response and a tool-follow-up response.
- Transcript tests assert creation, removal on first text, removal on model end, and a fresh timer/block for the next call.
- Presentation/render tests assert the Flavor-specific copy, elapsed time, and thinking label.
- Full test, typecheck, and build commands verify integration.

## Constraints

- Do not add dependencies.
- Do not create a worktree.
- Do not commit changes.
