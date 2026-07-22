# Electron MCP Service Management Design

## Goal

Give Electron users a first-class project MCP service workbench instead of routing the sidebar action through `/mcp status`. The workbench supports listing, creating, editing, enabling/disabling, and deleting project-scoped stdio and Streamable HTTP server configurations. The standalone CLI exposes the same persisted operations so desktop and terminal workflows do not drift.

## Scope and configuration ownership

The management surface owns `mcpServers` in `<workspace>/.flavor/flavor.json`. Global configuration remains loadable by the runtime but is not editable from this project workbench. This keeps deletion unambiguous: deleting a project service removes its project entry and preserves unrelated configuration fields. A short note in both interfaces identifies the project configuration path.

All mutations pass through one `ProjectMcpConfigManager`. It validates names and server payloads with the existing Zod schemas, uses the protected-file writer for locking, backup, and atomic replacement, and sorts results by name. Stdio services expose command, arguments, environment, working directory, and timeout. HTTP services expose URL, headers, and timeout. Environment and header values are stored exactly as entered so `${ENV_VAR}` references remain references rather than resolved secrets.

## Electron architecture

The renderer receives only bounded MCP IPC methods:

- `listMcpServers()`
- `saveMcpServer(originalName, draft)`
- `deleteMcpServer(name)`
- `setMcpServerEnabled(name, enabled)`

The main process validates every payload before calling the runtime controller. The controller requires an open workspace and delegates persistence to the shared manager. Changes affect newly started sessions; an already running session is left intact so configuration work cannot discard conversation state. The UI states this lifecycle rule explicitly.

The workbench follows the desktop application's existing quiet blue-gray visual language. Its signature is a narrow transport rail running through each catalog entry: terminal-blue for stdio and network-violet for HTTP. This makes transport type scannable without adding dashboard decoration. The two-pane layout uses a service catalog on the left and a focused configuration editor on the right, with an explicit delete confirmation.

## CLI synchronization

The standalone CLI adds `flavor mcp` subcommands backed by the same manager:

- `list [--json]`
- `add <name>` with exactly one of `--command <program>` or `--url <url>`
- `update <name>` with the same transport/configuration options
- `enable <name>` / `disable <name>`
- `delete <name>`
- `path`

Repeatable `--arg`, `--env KEY=VALUE`, and `--header KEY=VALUE` options cover structured fields without shell-specific JSON quoting. `--cwd` and `--timeout` cover the remaining shared fields. Add refuses to overwrite; update refuses missing services. The existing in-session `/mcp` commands remain responsible for live status, tool discovery, reconnect, and live enable/disable.

## Validation and failure behavior

- Service names retain the existing 32-character safe identifier rule.
- A draft selects exactly one transport; mixed stdio/HTTP fields are rejected.
- HTTP URLs must use HTTP or HTTPS at the Electron boundary.
- Duplicate environment/header keys resolve to the last supplied CLI value.
- Invalid existing project configuration is reported with its path and never overwritten.
- Delete and update of a missing service fail clearly.
- Electron forms retain the user's draft after save errors and report failures through the existing error toast.

## TDD coverage

Tests are written before implementation for shared persistence, IPC contracts, controller delegation, renderer structure, CLI parsing/mutations, and the explicit preload channel surface. Targeted tests must pass before the full test suite, typecheck, and production builds are run.
