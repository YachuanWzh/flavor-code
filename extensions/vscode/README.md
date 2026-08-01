# Flavor Code for VS Code

Flavor Code brings the Flavor coding agent into native VS Code surfaces while
keeping the CLI runtime and JSONL RPC protocol as the source of truth.

## Getting started

Install the `flavor` CLI (or run `npm link` from the repository), open a
workspace, then select the Flavor speech-bubble icon in the Activity Bar.
Choose **Start Flavor** or run **Flavor: Start Agent**.

To build, package, install, and verify the extension from the repository in one
step, run `npm run qoder:install` for Qoder or `npm run vscode:install` for VS
Code. Reload the IDE window once after installing into an open IDE.

Set `flavorCode.executable` when the CLI is not on `PATH`.

## Native workspace experience

- **Mission Control** shows the live plan, active tool, subagents, loop progress,
  and token usage.
- **Terminal session listening** lets a `flavor` process started manually in the
  same workspace register with the IDE bridge and stream its live task events
  into Mission Control. In this mode the title-bar terminal button focuses the
  existing session; prompts and cancellation remain in that terminal. Starting
  a separate extension Agent is an explicit action in Mission Control.
- **Changes & Health** shows workspace diagnostics, Git changes, and Agent
  footprints. Files read or changed by Flavor receive lightweight Explorer
  badges for the current task.
- **Time Machine** exposes checkpoints and the session tree with rewind, fork,
  and undo-rewind actions.
- **`@flavor` chat participant** streams responses, progress, file references,
  and follow-up actions into VS Code Chat.
- **Editor actions** add diagnostic Quick Fixes plus Review and Add Tests
  CodeLens actions for common function and class declarations.
- **Test Explorer** items include **Flavor: Fix Failing Tests**.

Useful commands include selection tasks, workspace diagnostic repair, code
tours, adversarial review, live steering, queued follow-ups, checkpoints,
rewind, and cancellation. Tasks started from VS Code create a checkpoint by
default; disable this with `flavorCode.autoCheckpoint`.

## IDE bridge

The extension starts a loopback-only, token-authenticated IDE bridge when VS
Code finishes starting. A `flavor` process launched from the same workspace
automatically discovers it, and `/ide` reports the active file, cursor, and
selection. The current editor context is attached to each normal Flavor prompt.
Bridge protocol v2 also registers terminal-started sessions and forwards their
bounded runtime events to the native views.

The bridge does not provide low-latency inline completion. Flavor instead
focuses on instruction-driven edits that can be reviewed and recovered through
checkpoints.
