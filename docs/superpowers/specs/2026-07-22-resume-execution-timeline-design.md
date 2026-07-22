# Resume Execution Timeline Design

## Goal

CLI `--resume` and Electron history navigation must restore the complete visible execution timeline, not only user and assistant prose. A resumed task should retain the same ordered transcript that was visible when it originally ran: tool calls and outcomes, tool inputs and outputs, task/subagent rows, retries, notices, usage, file diffs, loop progress, warnings, and context-compaction markers.

The model context and the user-visible timeline are different data products. Context compaction may remove old model messages, but it must not silently erase the durable execution timeline.

## Current problem

Session version 2 persists model-facing conversation messages and current task state. `createProductionRuntime` projects restored messages to `{ role, content }`, discarding `toolCalls` and `toolCallId`. The shared transcript hydration reducer then ignores tool messages by design. Live `SessionOutput` events create rich blocks in memory, but that state is not persisted.

Consequently, both interactive CLI and Electron can show rich activity during a run but only prose after resume. Retried calls, tool status, usage, notices, and presentation metadata cannot be reconstructed exactly from the saved model context.

## Design principles

1. **One shared timeline model.** CLI and Electron continue using `TranscriptState` and `transcriptReducer`; resume must restore the same state rather than maintaining separate desktop and terminal conversions.
2. **Persist the rendered semantic state.** Save completed and interrupted transcript turns, including structured blocks, instead of replaying historical events through the live event channel.
3. **Keep model context independent.** Context compaction changes `conversation`, never the durable timeline.
4. **Make loss explicit.** Legacy compacted sessions cannot regain discarded source messages. They receive a synthetic compaction boundary with the saved summary and timestamp.
5. **Best-effort legacy recovery.** Version-1/2 sessions without a timeline reconstruct user/assistant turns and pair assistant `toolCalls` with tool results. Fields that never existed—timings, retries, usage and rich presentations—are not invented.
6. **Do not replay side effects.** Restoring a timeline is a pure UI operation. No historical `SessionOutput` is emitted and no hook, tool or print-mode output is triggered.

## Persisted format

Session version 3 adds a `timeline` object:

```ts
interface PersistedTimeline {
  version: 1;
  state: TranscriptState;
}
```

The transcript state contains completed turns, an optional interrupted active turn, the next turn id and the latest task snapshot. Status blocks retain tool details:

```ts
interface TranscriptToolDetails {
  name: string;
  input: unknown;
  result?: ToolResult;
}
```

Session JSONL keeps the metadata header and model messages as separate lines. Timeline turns are stored as discriminator-prefixed JSONL records so large transcripts do not inflate the metadata line. The whole session remains bounded, sanitized, atomically replaced and covered by the existing workspace/symlink checks.

On load, a persisted active turn represents an interrupted process. It is moved to `completed`; running model rows are removed and running tool/task rows become cancelled so resume never displays stale live activity.

## Recording lifecycle

`createProductionRuntime` owns an in-memory transcript recorder initialized from the recovered timeline or the legacy reconstruction.

- `UserPromptSubmit` dispatches `submit` before any output.
- The single runtime output wrapper dispatches every `SessionOutput` before forwarding it to the caller.
- `Stop` dispatches `finish` and persists the session, including slash-command and denied turns that do not emit `done`.
- Existing mid-turn persistence points save the current active snapshot for crash recovery.
- `/clear` resets both model context and transcript state when it creates a new session id.

The runtime exposes `restoredTranscript` for interactive consumers. The old `restoredMessages` projection is removed after call sites and tests migrate.

## Tool detail presentation

The reducer stores tool input at `tool-start` and merges the final `ToolResult` at `tool-end`. Existing concise status and diff presentation remain the primary display.

- Electron renders a collapsed native details region containing sanitized input and result/error JSON.
- CLI renders a compact execution summary rather than raw JSON: tool name plus the primary file/target, followed only by useful outcome metadata such as exit code, match count, bytes written, replacement count, truncation, or a bounded error message. File contents, stdout/stderr bodies, and generic result objects remain persisted but are not expanded in the terminal transcript.
- File-change presentations continue to render as diffs and may coexist with the details region.

## Compacted history

For sessions created after this change, timeline turns survive context compaction. The existing `Context compacted` row marks where compaction happened; the saved summary is model context and is not duplicated as a fake assistant answer.

For legacy sessions whose `conversation.compact` exists but whose timeline does not, hydration prepends a synthetic, non-user turn:

- title: `Earlier execution history was compacted`
- timestamp from `compactedAt`
- explanatory warning that original steps are unavailable
- the saved summary in a visually separate details area

The synthetic boundary is not sent back to the model and does not become prompt input history. Retained post-boundary messages and tool calls appear normally after it.

## Compatibility and limits

- Version 1 and 2 files migrate in memory to version 3.
- Legacy tool calls are paired by `toolCallId`; orphan tool results become explicit warning rows rather than disappearing.
- Unknown or malformed timeline records fail session validation and follow existing quarantine behavior.
- Sanitization applies to transcript tool inputs/results as it does to conversation messages.
- The existing total session byte limit remains authoritative. A save that exceeds it reports the current session-save failure rather than silently dropping oldest timeline entries.
- Non-interactive `--resume -p` restores model context but does not print historical timeline content.

## Testing

Tests must prove:

1. reducer tool blocks retain input, success/error result and presentation;
2. session v3 round-trips transcript turns as JSONL and sanitizes secrets;
3. v1/v2 migration reconstructs tool calls and shows an explicit compacted-history boundary;
4. persisted active turns recover as completed/cancelled, never running;
5. production runtime records prompt/output/stop and exposes `restoredTranscript` only for resume;
6. interactive CLI hydrates the restored timeline before session startup;
7. Electron payload and renderer hydrate the same restored timeline;
8. both renderers show tool details and compacted-history treatment;
9. print mode does not replay restored history;
10. typecheck, full tests, production build and Electron renderer build pass.
