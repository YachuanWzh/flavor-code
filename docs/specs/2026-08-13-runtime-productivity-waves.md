# Runtime productivity waves

Status: implemented in 1.2.9
Date: 2026-08-13

## Goal

Bring the first two runtime-productivity waves into Flavor Code without copying the reference harness wholesale. The implementation keeps Flavor Code's permission engine, transcript, local harness, and desktop controller as the integration points.

## Wave 1

### Hierarchical workspace instructions

- Load `AGENTS.md` and `CLAUDE.md` from the workspace root before the first model call.
- For every successful path-bearing tool call, discover instruction files from the workspace root to each touched file's directory, in root-to-leaf order.
- A deeper file supplements the parent. `AGENTS.local.md` and `CLAUDE.local.md` are loaded after the ordinary file in the same directory.
- Never follow an instruction file through a symlink outside the workspace.
- Deduplicate unchanged files by physical path plus content digest. Changed instructions are emitted again.
- Bound each file to 64 KiB and the combined instruction context to 256 KiB, preferring deeper instructions when the budget is exceeded.

### Turn deliverables

- A completed agent turn emits one `deliverables` event when successful file tools changed files.
- Items are unique by path, preserve first-change order, and accumulate operation and added/removed line counts.
- CLI/desktop transcript rendering uses the same event; the summary is not inferred from assistant prose.

### Read-before-write version protection

- A successful `Read` records the file version in a session-scoped observation store.
- `Write`, `Edit`, and `ApplyPatch` compare the observed/read version immediately before atomic replacement.
- If another process changes the file after it was observed, the mutation fails with a stale-file error and never overwrites the newer contents.
- Successful writes refresh the observation. Multi-file patches validate every target before committing any target.

### Standard tool result protocol

- A tool may declare an output schema, a model renderer, and presentation builders.
- Runtime output validation occurs before hooks and transcript delivery.
- `ToolResult.output` remains the canonical typed value; `ToolResult.content` is the bounded model-facing text; `ToolResult.presentation` is a renderer-neutral presentation.
- Existing tools without the optional fields remain compatible.
- CLI web-search presentations render as a bounded evidence block: ranked title/source pairs, at most five visible results, an explicit shown/total footer, compact URLs without query tracking, and one blank line before subsequent assistant text.

## Wave 2

### Job registry and background shell

- Long-running work is represented by a registry entry with id, kind, owner, state, timestamps, label, exit data, and bounded incremental output.
- `Shell(background=true)` returns immediately with a job id. Foreground behavior remains unchanged.
- `JobList`, `JobRead`, `JobWait`, and `JobKill` are native tools. Owners cannot control another owner's jobs.
- Cancelling or disposing the owning runtime terminates running children and their process trees.
- Windows shell execution selects UTF-8 code page 65001 and automatically falls back to GB18030 when system diagnostics are not valid UTF-8; incremental job output uses an adaptive streaming decoder so non-ASCII characters are not corrupted at chunk boundaries.
- CLI job presentations use a state-colored receipt: semantic job status and metadata, a bounded log section (latest 12 lines with omission count), at most eight list entries, and a footer containing exit/cursor/truncation details. Non-zero process exits are failed jobs rather than completed jobs with an error code.

### Desktop job status

- The production runtime exposes immutable job snapshots and a subscription.
- Desktop snapshots include active/recent jobs and update while a job starts, produces output, exits, or is killed.
- The conversation header shows a compact job strip without requiring transcript parsing.

### Persistent terminals

- `TerminalOpen`, `TerminalWrite`, `TerminalRead`, `TerminalResize`, `TerminalClose`, and `TerminalList` manage persistent interactive terminal sessions.
- Sessions are workspace-bound, owner-bound, output-bounded, and are closed on runtime disposal.
- PTY support uses the operating system pseudo-terminal backend; unavailability returns an explicit tool error instead of silently falling back to a non-interactive pipe.

### D2C/E2E lifecycle convergence

- The shared managed-process primitive owns bounded output, cancellation, and tree termination for D2C/E2E services.
- Background Shell work enters the Job registry, while D2C/E2E runners use the aligned `ManagedProcess` lifecycle; public D2C runner contracts remain compatible.

## Native web tools

### WebFetch

- Support HTTP(S), redirects, timeout, maximum response bytes, text/JSON/HTML output, and deterministic HTML-to-text conversion.
- Reject credentials, disallowed ports, loopback, private, link-local, multicast, unspecified, and metadata-network destinations for every redirect and every resolved address.
- Connect to the validated address while retaining the original Host header and TLS server name, preventing DNS rebinding between validation and connection.
- Treat RFC 2544 benchmark addresses as blocked when supplied literally, but permit them as DNS carriers for named hosts so Clash/TUN Fake-IP mode remains usable; all other private and special ranges remain blocked.

### WebSearch

- Expose a provider-neutral `WebSearch` tool with bounded query/result sizes.
- The built-in provider uses DuckDuckGo Lite without credentials and falls back to Bing after connection errors, non-success responses, or empty parsing; provider injection is supported for tests and future configured providers.
- Search and fetch are categorized as network tools and go through the existing permission engine.

## Verification

- Unit tests cover instruction ordering/change detection/symlink boundaries, stale writes, output validation/rendering, registry ownership/cursors/cancellation, background shell, terminal lifecycle, SSRF address classes, HTML conversion, provider-normalized search results, and deliverable aggregation.
- Production wiring tests verify that all native tools are registered.
- `npm test`, `npm run typecheck`, `npm run vscode:typecheck`, and the production build must pass before handoff.
