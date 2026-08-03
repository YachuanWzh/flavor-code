# CLI interrupted-query replanning specification

Date: 2026-08-03

## Problem

The CLI clears a turn-owned task plan after Ctrl+C. A query submitted after the
interruption therefore starts without an active runtime plan, while the model
can still see the cancelled turn in conversation history. Without an explicit
turn-scoped reset signal, the model may try to update the archived plan with
`TaskUpdate`; that call fails and no refreshed execution panel is published.

## Required behavior

- Ctrl+C continues to cancel and archive the active turn and its task panel.
- If the cancelled turn owned a main-agent plan or delegated task graph, the
  next ordinary query receives prompt-scoped context stating that the old plan
  is unavailable and must be reassessed.
- Complex follow-up work creates a fresh plan with `TaskPlan` before using
  `TaskUpdate`, so the CLI publishes a plan for the new query.
- Slash commands do not consume the reset signal; the next ordinary query does.
- The reset context is not persisted in conversation history and does not leak
  into later queries.
- Existing successful, failed, and denied turns keep their current behavior.

## Verification

- A session test proves `UserPromptSubmit` hook context reaches one model run.
- A production regression test creates a plan, interrupts it, submits another
  query, and observes a fresh plan snapshot for that second query.
- Focused tests, TypeScript type checking, and the production build pass.
