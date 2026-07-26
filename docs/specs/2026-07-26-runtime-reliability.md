# Runtime reliability specification

Date: 2026-07-26

## Scope

This change fixes three related runtime reliability problems:

1. `/goal` hides worker activity, presents normal progress as warnings, and does
   not create a useful incremental session record.
2. model-authored task plans can remain pending and leak into later prompts.
3. project sleep reviews can silently miss a date after startup, suspension, or
   a transient model failure.

## `/goal` behavior

- Planning, execution, verification, and terminal phase messages use neutral
  progress presentation. They must not use the warning tone or warning icon.
- Worker model activity, tool calls, tool results, retries, text, limits, and
  usage are forwarded to the normal transcript.
- A worker `done` event is not allowed to finish the enclosing `/goal` turn.
  The enclosing turn receives exactly one terminal `done`.
- A worker error fails the goal instead of being silently treated as evidence.
- The session timeline is persisted incrementally while the goal runs.
- The `/goal` prompt is usable as a session-list preview even though the worker
  uses an isolated model context.
- A durable goal snapshot records the goal id, phase, status, plan, rounds,
  gaps, and timestamps after every state transition.

## Task-plan behavior

- A plan that contains only pending tasks automatically activates the first
  dependency-ready task in stable plan order.
- Completing the active task automatically activates the next ready task.
- Model-issued duplicate `in_progress` updates remain idempotent.
- When a prompt stops for any outcome, its plan is archived in that completed
  turn and removed from the runtime's active task state.
- A later prompt never inherits the prior prompt's task panel unless a future
  explicit continuation feature opts into that behavior.

### Electron renderer

- Task-plan activity is live UI: it is visible only while its owning turn is
  active.
- Once a turn completes, Electron closes the live task-plan cards while keeping
  the underlying task snapshot in the persisted transcript.
- Every streamed desktop output is tagged with its originating session id.
- After switching sessions, delayed output from the previous runtime must not
  mutate the newly restored transcript.

## Sleep-review behavior

- Startup discovers every past local date represented in saved transcript
  turns that does not already have a report and queues it for catch-up.
- The date captured when a midnight timer is scheduled is the date reviewed,
  even if the computer wakes on a later date.
- Transient failures keep the date queued and retry with a bounded delay.
- Daily scheduling continues while a failed date is waiting for retry.
- Failures are both reported to runtime diagnostics and emitted as a visible
  session notice.
- Transcript turns carry localizable submission timestamps. Sleep review date
  selection uses those timestamps and includes slash-command/goal timeline
  content; legacy sessions fall back to session `updatedAt`.
- Partial model streams must contain a completion event. Structured JSON
  failures receive bounded repair retries before the date remains queued.

## Verification

- Unit tests cover goal event forwarding, neutral presentation, worker errors,
  and durable state transitions.
- Production tests prove incremental `/goal` persistence and session preview.
- Task-plan and transcript tests prove automatic activation and no carry-over.
- Sleep tests cover startup catch-up, retry, suspension across multiple dates,
  timestamp-based selection, and visible failure diagnostics.
- The complete test suite and TypeScript typecheck pass.
