# Resume Conversation History Design

## Goal

When the interactive CLI starts with `--resume`, the transcript viewport displays the retained user and assistant conversation instead of starting blank. The restored model context and session persistence behavior remain unchanged.

## Root Cause

`createProductionRuntime` loads `conversation.messages` and restores them into the main model context. The interactive `App` independently initializes its transcript reducer with no completed turns, and startup emits only task snapshots. No restored conversation data crosses the runtime-to-UI boundary.

## Design

The production runtime exposes the messages loaded specifically for a resumed session as read-only restored history. It does not emit them through the live `SessionOutput` stream, because replay events would be indistinguishable from a new active response and would also affect non-interactive `--resume -p` output.

The transcript module adds a hydration operation that converts restored messages into completed turns. Each user message starts a turn; non-empty assistant content before the next user message is appended to that turn; tool messages and assistant tool-call metadata are ignored. A final user message without an assistant reply remains visible as an incomplete historical turn, but no historical turn becomes the active streaming turn.

The interactive `App` hydrates the reducer immediately after runtime creation and before session startup. Normal, non-resumed startup continues with an empty transcript. Hydration does not populate prompt input history because the requested scope is the visible content area only.

## Compaction

Only messages retained in `conversation.messages` are displayed. A compacted summary is model context rather than a verbatim transcript and is not rendered as if it were an original user or assistant message. Original messages already removed by compaction cannot be reconstructed.

## Testing

Tests cover grouping multiple user/assistant turns, ignoring tool messages and empty tool-call assistant messages, retaining a final user-only turn, replacing an empty transcript through hydration, and exposing restored messages only for resumed runtimes. An interactive rendering test verifies that hydrated turns appear in the content area. Existing transcript, production runtime, typecheck, build, and full test suites must continue to pass.

## Scope

This change does not replay tool calls, task rows, usage lines, notices, or compact summaries. It does not change the session file format, model context restoration, print-mode output, or transcript scrolling behavior.
