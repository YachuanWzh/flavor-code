# Project Sleep Review Design

## Goal

When a Flavor process remains alive across local midnight, optionally review the
sessions from the project-local day that just ended. Use the configured cheap
model and save one Markdown report under `.flavor/sleep/`.

## Configuration and scope

- `sleep` is a top-level boolean in `.flavor/flavor.json` and defaults to
  `false`.
- A runtime only reads and writes the workspace it was created for. Separate
  Flavor processes therefore review their own projects independently.
- A disabled runtime never creates a timer, calls a model, or creates a sleep
  directory.
- A runtime schedules the next local midnight only. It does not backfill missed
  days after startup.

## Day ownership

At local midnight, the target day is the previous local calendar day. For
example, a callback at `2026-07-23 00:00` reviews `2026-07-22` and uses that date
in the filename and document heading.

Session documents do not currently timestamp individual messages. A session is
therefore assigned to the local calendar day of its `updatedAt` value, and its
complete visible user/assistant conversation is supplied to the reviewer. This
keeps each conversation coherent and makes the selection deterministic.

If the project has no session assigned to the target day, the organizer exits
without calling the model or writing a report.

## Model contract and report

The runtime calls the configured subagent/cheap model without tools. The prompt
treats session text as untrusted material and asks for strict JSON containing:

- a short filename summary/title;
- the day's task summary;
- execution reflection;
- key decisions and learnings;
- open questions and risks;
- possible plan for tomorrow.

The host parses that JSON and renders Markdown itself. Every report contains:

1. `当天任务摘要`
2. `执行情况反思`
3. `关键决策与收获`
4. `未决事项与风险`
5. `明日可能规划`
6. `涉及会话`

The filename is `YYYY-MM-DD-摘要.md`. Unsafe filename characters and Markdown
line breaks from model output are normalized before writing.

## Concurrency and lifecycle

- The organizer uses a project-local, per-day exclusive lock and rechecks for an
  existing `YYYY-MM-DD-*.md` report after acquiring it.
- Concurrent processes for the same workspace produce at most one report for a
  day. Processes for different workspaces use different locks and do not affect
  one another.
- Output is written to a temporary file and atomically renamed.
- Model or parse failures do not leave a report or permanent lock; they are
  recorded as runtime diagnostics and the next midnight remains scheduled.
- Runtime disposal clears the pending timer and waits for an in-flight review.

## Acceptance tests

- Configuration defaults to disabled and accepts `sleep: true`.
- Date helpers cross month/year boundaries using local calendar time.
- Disabled scheduling performs no work.
- Midnight reviews the preceding local day and reschedules.
- No matching session means no model call and no report.
- Matching sessions are filtered by local `updatedAt`, sent to the cheap model,
  and rendered with every mandatory section.
- Duplicate/concurrent organization is idempotent.
- Production wiring uses the configured cheap model for an enabled project.

