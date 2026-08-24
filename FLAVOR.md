<!-- flavor-code:start -->
## Overview

- Project: flavor-code
- Languages: TypeScript
- Package manager: npm

## Layout

- `src`
- `tests`

## Search

- A code graph index is available (`.flavor/astgraph/index.db`): pair `ast_search` with `grep`/`glob` to locate symbols, and use `ast_callers`/`ast_callees`/`ast_impact`/`ast_context` to trace reachability instead of reading files broadly.

## Build

- `npm run build`

## Test

- `npm test`

## Quality

No verified lint or format command detected.

## Conventions

- Respect `tsconfig.json`.
- Respect `vitest.config.ts`.

## Cautions

- Do not read or copy secrets from environment files.
- Do not inspect dependency directories or generated output unless explicitly required.
<!-- flavor-code:end -->

## Exploration discipline

Token budget matters. When inspecting this repository:

- Locate first, read second: use `Grep`/`Glob`/LSP tools to find the relevant spot, then `Read` only that file or region.
- Prefer `startLine`/`endLine` on `Read` for large files; never read a whole file when a region is enough.
- Never re-read a file whose unchanged content is already in the conversation; a `[Duplicate read suppressed]` result means the content is still available in context — quote it from there.
- Do not browse documentation, specs, or tests speculatively; open a document only when it directly informs the current task.
- Delegate broad open-ended investigation to a `Task` subagent so its reads stay out of the main context.

<!-- SUPERHARNESS:FLAVOR-BEGIN -->
## Superharness

This project has **superharness** installed as a flavor-code plugin under
`.flavor/plugins/superharness/`. It registers a skill root plus eight session,
planning, and subagent lifecycle hooks. SessionStart injects `HARNESS.md` into
the persistent context and the host `Skill` tool loads required sub-skills
during `/go`. Ralph checkpoints live under `.flavor/superharness/ralph/` and
remain resumable across host sessions.

Installed skills: `brainstorm`, `finishing-a-development-branch`, `go`, `light`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`

Key capabilities:
- **go** -- Drive a task end-to-end under strict TDD + verification + code review discipline.
- **light** -- Lightweight mode for small focused tasks: TDD with exemptions, real-output verification, no worktree/plan-file/ralph overhead.
- **brainstorm** -- Explore requirements with a live browser mind map (manual trigger only).
- **test-driven-development** -- RED-GREEN-REFACTOR cycle. No production code without a failing test first.
- **systematic-debugging** -- Root-cause tracing, defense-in-depth, no guess-and-patch.
- **verification-before-completion** -- Run the full test suite and show real output before claiming done.
- **requesting-code-review** -- Dispatch a reviewer subagent over the diff.
- **writing-plans** -- Break down multi-step work into bite-sized TDD tasks.
- **using-git-worktrees** -- Isolate work in a disposable workspace.
- **subagent-driven-development** -- Execute multi-task plans with parallel subagents.

Usage in flavor-code: `/<skill-name> <args>`, e.g. `/go refactor login module` or `/brainstorm payment plan`.
<!-- SUPERHARNESS:FLAVOR-END -->
