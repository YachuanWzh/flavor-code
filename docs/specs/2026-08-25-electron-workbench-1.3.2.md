# Electron Workbench 1.3.2

Status: implementation
Date: 2026-08-25

## Goal

Turn the Electron client into a local agent workbench without changing CLI
behavior. The desktop surface owns isolation, visualization, terminal panes,
preview, and management UI. Shared runtime services remain compatible and the
CLI keeps its current commands, defaults, persistence, and rendering.

## Product scope

### P0

1. **Task worktrees**
   - A new desktop task can run in the local checkout or an isolated Git
     worktree.
   - Worktrees use an app-owned directory, a deterministic Flavor branch, and
     are listed with their dirty/merged state.
   - Desktop users can hand changes back by merging the task branch, retain the
     branch, or remove a clean worktree. Destructive cleanup refuses dirty
     worktrees unless explicitly forced.
2. **Time Machine**
   - List the active session tree and current leaf.
   - Create a labelled checkpoint, rewind, undo the last rewind, and fork from a
     node after confirmation.
3. **Execution cockpit**
   - Render the live task plan, subagent states, jobs, durable goal phase,
     verification rounds, gaps, and evidence.
   - Pause uses the existing safe interrupt boundary. Resume and edited goals
     start an explicit `/goal` continuation instead of mutating durable history.
4. **Integrated terminal**
   - Open, write, resize, read, list, and close project-scoped PTYs.
   - Terminal sessions bind to the selected task checkout and never expose a
     raw Node or Electron object to the renderer.

### P1

5. **Review Workbench 2.0**
   - Diff scopes: working tree, staged, selected commit, base branch, and last
     assistant turn.
   - File and hunk navigation, prioritized review findings, one-click handoff
     to the agent, and existing stage/unstage/discard/commit actions.
6. **App preview**
   - Embed only loopback HTTP(S) URLs, with reload, open externally, and copy
     actions. URLs discovered from terminal/job output are offered as shortcuts.
7. **Context and safety inspector**
   - Show context epoch, visibility records, workspace instructions, active
     permission profile/rules, diagnostics, tool audit records, and usage.
   - Secret-bearing values stay redacted and the renderer receives bounded
     structured data.
8. **AST graph explorer**
   - Report index state, search symbols, and inspect callers, callees, and
     bounded impact nodes.
   - A selected symbol can be inserted into the current composer as explicit
     file/line context.
   - The desktop renders a bounded, clickable relation map centered on the
     selected symbol. Callers, callees, and multi-hop impact nodes use distinct
     lanes and can become the new center without leaving the graph.

### Additional requested scope

9. **Pals / Co-work**
   - List local pals, send chat/task messages, start co-work, inspect status,
     and cancel a selected co-work from a visual workbench.
10. **Memory observability**
   - Every memory card shows its distinct-task recall count and hot/normal/cold
     heat.
   - The workbench filters by heat and deletes all cold memories in one
     confirmed action.

## Architecture boundaries

- Renderer components live under `src/desktop/renderer/` and call only the
  typed preload API.
- New IPC input uses strict Zod schemas and bounded strings/arrays.
- Desktop-only orchestration and persistence live under `src/desktop/`.
- Additive shared read APIs may be introduced for existing session history or
  memory metadata, but no CLI command, default, output, or tool registration is
  changed.
- Desktop task metadata is stored below Electron `userData`; repository-local
  runtime artifacts keep their existing format.
- Preview navigation is loopback-only. Worktree and Git paths are resolved and
  checked before mutation. Terminal ownership is scoped to the selected task.
- Terminal dimensions follow the visible viewport through bounded resize IPC;
  preview URL discovery reads only jobs owned by the active runtime.
- The renderer terminal is a lazily loaded xterm.js frontend connected to the
  existing node-pty service. Keyboard data is forwarded in order, including
  arrows and control chords; no command-line shim may batch a submitted line.
  Closing a desktop terminal removes it from the desktop selection/list while
  preserving the shared TerminalService semantics used by CLI tools.
- Electron starts the local Pals broker through a dedicated packaged Node entry.
  Pals is optional for desktop session startup: broker failure is surfaced as a
  diagnostic and must never prevent opening or restoring a task. The client is
  retained after a failed first connection and retries on the next Pals action;
  successful recovery clears the transient diagnostic.

## Visual direction

Keep the existing quiet blue-gray workbench language. New management surfaces
use a three-part evidence layout: object rail, evidence canvas, action
inspector. The execution cockpit's distinctive element is a continuous
"execution trace" joining task, checkpoint, worktree, and verification nodes.
Heat badges are semantic enamel-like pills: ember for hot, frost for cold, and
slate for normal; color is always paired with text.

The Pals surface uses an online-instance rail and a selected-Pal identity
header. Messaging/task delegation and Co-work are two balanced action cards on
desktop widths, each keeping its textarea, intent hint, and action controls in
one visual boundary. Delivery feedback and live Co-work status sit below the
cards; raw protocol data is progressive disclosure rather than the primary UI.

All independently scrolling Workbench regions use the same thin, rounded,
low-contrast scrollbar treatment, with a brighter hover state and a dark-theme
variant for the terminal. PTY bytes are projected through a bounded VT text
screen before reaching the DOM: erase/cursor commands affect the model instead
of appearing as text, empty positioned rows are compacted, and long shell/CWD
labels use ellipsis while preserving the full value as a tooltip.

## Test strategy

Each vertical slice starts with failing unit/contract/renderer tests. Required
coverage includes path validation, worktree lifecycle, IPC schemas and preload
exposure, session-history actions, terminal ownership, loopback URL rejection,
bounded audit/context reads, AST query behavior, Pals actions, memory metadata,
cold deletion, VT cursor/erase/carriage-return output, terminal label overflow,
ordered raw-key input, an interactive nested Flavor CLI, close-selection cleanup,
and renderer empty/loading/error states.

Release gates:

- focused desktop and memory tests;
- full `npm test`;
- `npm run typecheck`;
- `npm run vscode:typecheck`;
- `npm run build`;
- desktop Electron E2E smoke test.

No Git commit is created by this implementation.
