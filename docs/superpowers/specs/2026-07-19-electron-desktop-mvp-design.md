# Flavor Code Electron Desktop MVP Design

## Goal

Ship a Windows-first Electron desktop client that exposes Flavor Code's existing coding-agent runtime through a Codex-inspired native window without duplicating agent behavior or weakening permission boundaries.

## Scope

The MVP supports opening a project, starting or resuming project-scoped sessions, streaming assistant and tool activity, cancelling a run, answering permission requests and model questions, switching models and permission modes, invoking every existing slash command (including Skill, plugin, MCP, loop, compact, clear, init, login and audit commands), viewing session history, and opening external links safely. It persists the last project and provides Electron development, build and Windows packaging commands.

The MVP does not add cloud sync, automatic updates, multiple simultaneous active runtimes, a Monaco editor, or Git/PR screens. Existing agent tools remain the source of truth for file edits, shell commands, planning and subagents.

## Approaches considered

1. **Direct runtime integration (selected).** Electron's main process owns `createProductionRuntime`; a typed, narrow preload API carries commands and structured events. This preserves the full Flavor feature set and lets the renderer show real approvals, questions and task progress.
2. **Embedded terminal.** Spawn the CLI in a pseudo-terminal and render ANSI. This is quick, but cannot provide reliable desktop controls or structured permission UX and would make accessibility poor.
3. **Local HTTP server.** Put the runtime behind localhost and load a browser UI. This adds authentication, port lifecycle and exposure concerns without helping the single-user desktop MVP.

## Architecture

`DesktopRuntimeController` is an Electron-independent adapter over `ProductionRuntime`. It owns one active project/session, emits serializable snapshots and agent events, lists sessions through `SessionStore`, and resolves approval/question bridges. Electron main owns the controller, validates all IPC payloads, handles folder dialogs and external navigation, and persists the last workspace in `userData`.

The preload script exposes only `bootstrap`, `chooseWorkspace`, `openWorkspace`, `startSession`, `submit`, `interrupt`, `resolveApproval`, `answerQuestions` and event subscription. Context isolation stays enabled, Node integration stays disabled, and renderer navigation/window creation is blocked.

The React renderer reuses `transcriptReducer` so terminal and desktop clients interpret agent events consistently. Renderer state is split between the runtime snapshot (project/session/approval state), transcript state, and local presentation state.

## Visual direction

- **Palette:** snow `#f7f9fc`, paper `#ffffff`, ink `#1c2430`, quiet slate `#667085`, sky `#4a9fe8`, pale sky `#e9f4ff`.
- **Type:** system UI (`Segoe UI Variable`, `PingFang SC`) for controls; `Cascadia Code` for paths, tool inputs and code.
- **Layout:** 272 px navigation rail, flexible conversation canvas, fixed floating composer. Below 860 px the rail becomes an overlay drawer.
- **Signature:** a thin sky-blue activity rail connects the active turn's tool and task cards, making parallel agent work legible while the rest of the interface stays neutral.
- **Motion:** one restrained streaming pulse and panel transitions, disabled by `prefers-reduced-motion`.

## Data flow

1. Renderer boots and asks main for the persisted workspace plus available sessions.
2. Opening a workspace disposes the old runtime and lists that project's sessions.
3. Starting a new or resumed session creates a production runtime and sends restored messages and current model/permission metadata.
4. Submitting optimistically opens a transcript turn; structured `SessionOutput` events update it until `done`, error or cancellation.
5. Approval and question changes are snapshots, not polls. The renderer responds through explicit IPC methods.
6. Closing the window waits briefly for runtime persistence/disposal before quitting.

## Error handling and security

IPC input is parsed with Zod and invalid requests reject with a user-facing error. Runtime start/submit failures become renderer-visible errors without leaking configuration secrets. Folder access originates only from a native picker or a previously persisted absolute path. External URLs are limited to HTTP(S) and opened with the OS browser. The preload surface contains no generic invoke, filesystem, shell or Electron access.

## Testing

Unit tests cover desktop payload schemas, controller lifecycle/streaming/approvals, and renderer transcript/view helpers. Existing tests guard the core runtime. Completion requires full tests, typecheck, production build and an Electron-renderer screenshot at desktop and narrow widths.

