# Resume Execution Timeline Implementation Plan

**Goal:** Persist and restore the complete execution transcript in both interactive CLI and Electron, with honest legacy reconstruction for compacted sessions.

**Architecture:** Add a versioned persisted timeline beside model conversation state. Record it through the shared transcript reducer inside `createProductionRuntime`, expose the recovered `TranscriptState`, and hydrate that exact state in both clients. Migrate old sessions by reconstructing tool rows from conversation messages and adding a compacted-history boundary when source turns are gone.

**Method:** Strict TDD. Each task starts with focused failing tests, confirms the intended failure, implements the smallest production change, and reruns the focused suite before proceeding.

## Task 1: Make transcript blocks lossless enough to persist

**Tests first**

- Update `tests/ui/transcript.test.ts` to require tool input and final result/error on the same ordered status block.
- Add coverage for restoring an existing `TranscriptState` and normalizing an interrupted active turn.
- Add legacy conversion tests for paired tool calls, orphan results and compacted boundaries.

**Implementation**

- Extend `TranscriptBlock` status data with structured tool details and optional long-form details.
- Merge `tool-start` and `tool-end` data without disturbing block order or file presentations.
- Add pure `restoreTranscriptState` and `transcriptFromLegacyConversation` helpers.
- Bound human-readable previews without mutating stored structured data.

## Task 2: Add session version 3 timeline persistence

**Tests first**

- Update `tests/session/store.test.ts` fixtures to v3.
- Assert transcript turns are separate discriminated JSONL records and round-trip exactly.
- Assert v1/v2 files migrate, secrets are sanitized in timeline tool details, malformed timeline rows quarantine, and active rows normalize on restore.

**Implementation**

- Add strict Zod schemas for persisted transcript turns, blocks, task snapshots and file presentations.
- Increment `SESSION_VERSION` to 3 and retain explicit v1/v2 parsers.
- Split and join message/timeline records in `SessionStore` while preserving the total size bound and atomic write.
- Populate migrated timelines through the legacy conversion helper.

## Task 3: Record timeline in the production runtime

**Tests first**

- Update `tests/cli/production.test.ts` to require `restoredTranscript` with tool rows and compact boundary.
- Add a run/resume test proving prompts, output blocks, usage and Stop completion persist.
- Retain the print-mode assertion that history is not replayed to stdout.

**Implementation**

- Initialize a recorder from recovered timeline or an empty state.
- Wrap all runtime output through one reducer-backed emitter.
- Record `submit` on `UserPromptSubmit`, `finish` and persist on `Stop`, and reset on `/clear`.
- Store the recorder snapshot in every session document and expose `restoredTranscript` only when resume was requested.

## Task 4: Hydrate interactive CLI and Electron

**Tests first**

- Change CLI app rendering tests to hydrate tool rows and compacted boundaries.
- Change desktop controller/contract tests to carry `restoredTranscript`.
- Add Electron rendering assertions for restored tool details, errors, diffs and compacted summary treatment.

**Implementation**

- Add a reducer `restore` action or set the validated restored state directly before session startup.
- Migrate `src/ui/app.tsx`, desktop contracts/controller and desktop renderer from `restoredMessages` to `restoredTranscript`.
- Render collapsed tool details in Electron and compact target/outcome summaries in CLI without raw input/output JSON.
- Keep event subscriptions live-only; do not replay historical events.

## Task 5: Verification and documentation alignment

- Run focused reducer, session, production, CLI render and desktop suites after each task.
- Run `npm test`, `npm run typecheck`, `npm run build`, and the Electron renderer build/packaging-safe build command defined by the repository.
- Update the prior resume-history design note to mark its tool-output exclusion as superseded by the 2026-07-22 design.
- Review the final diff specifically for unrelated dirty-worktree changes and generated artifacts.
