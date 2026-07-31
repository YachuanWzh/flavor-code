# Flavor Code for VS Code

Install the `flavor` CLI (or run `npm link` from the repository), open a
workspace, then run **Flavor: Start Agent**.
The extension uses Flavor's JSONL RPC mode and supports selection tasks,
diagnostic repair, live steering, queued follow-ups, checkpoints, tree inspection,
rewind, and cancellation.

Set `flavorCode.executable` when the CLI is not on `PATH`.

The extension also starts a loopback-only, token-authenticated IDE bridge when
VS Code finishes starting. A `flavor` process launched from the same workspace
automatically discovers it, and `/ide` reports the active file, cursor, and
selection. The current editor context is attached to each normal Flavor prompt.
This bridge does not provide inline code completion; completion requires a
separate low-latency provider.
