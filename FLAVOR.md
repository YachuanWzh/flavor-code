<!-- SUPERHARNESS:BEGIN -->
## Superharness

This project uses **superharness**, loaded as a Claude Code plugin from the local
marketplace at `.flavor/superharness` (enabled in `.flavor/settings.json` via
`extraKnownMarketplaces` + `enabledPlugins`). Its SessionStart hook injects
`HARNESS.md` into every session. If that context is missing, read
`.flavor/superharness/plugins/superharness/HARNESS.md` now and follow it for all
engineering work.

- Run a task end-to-end: `/superharness:go <task goal>`
- Brainstorm with a live browser mind map (manual trigger only):
  `/superharness:brainstorm <topic>`
- Non-negotiable: strict TDD (failing test first), systematic debugging, and
  verification with real command output before claiming anything is done.
<!-- SUPERHARNESS:END -->