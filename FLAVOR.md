<!-- flavor-code:start -->
## Overview

- Project: flavor-code
- Languages: TypeScript
- Package manager: npm

## Layout

- `src`
- `tests`

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

<!-- SUPERHARNESS:FLAVOR-BEGIN -->
## Superharness

This project has **superharness** installed as a flavor-code plugin under
`.flavor/plugins/superharness/`. It registers a skill root that provides
engineering-discipline skills for autonomous development.

Installed skills: `brainstorm`, `go`, `requesting-code-review`, `subagent-driven-development`, `systematic-debugging`, `test-driven-development`, `using-git-worktrees`, `verification-before-completion`, `writing-plans`

Key capabilities:
- **go** -- Drive a task end-to-end under strict TDD + verification + code review discipline.
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