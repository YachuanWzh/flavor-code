# `@` File Completion Design

## Goal

Add a Codex-style workspace file picker to the terminal prompt. Typing `@` opens matching workspace paths, Up and Down move the active row, Tab inserts the active path, and clicking a row inserts that path immediately.

The reference screenshot is the approved visual baseline. The feature stays within the existing fixed-bottom terminal layout and uses the same compact marker, highlight, truncation, and footer conventions as slash completion.

## Considered Approaches

1. **Add a focused mention-completion model and reuse the existing workspace glob implementation.** This keeps token detection, filtering, selection, and replacement independently testable while inheriting the project's ignore-file handling and ripgrep fallback. This is the selected approach because it adds little coupling and avoids duplicate filesystem traversal.
2. Generalize slash completion into one multi-trigger completion engine. This could reduce some duplicate selection logic, but it would widen the regression surface of a working feature and force unrelated slash types into a file-oriented data model.
3. Traverse the filesystem directly from `App`. This is mechanically small but would duplicate `.gitignore` handling, resource limits, cancellation, sorting, and platform behavior already implemented by the search tool.

## Scope

The feature includes workspace file discovery, `@` token detection, case-insensitive filtering, bounded rendering, keyboard navigation, Tab completion, Escape dismissal, and mouse selection. It does not embed file contents into the submitted prompt, provide fuzzy typo correction, show directories as selectable rows, or change agent-side prompt semantics.

## Architecture

`src/ui/mention-completion.ts` will contain pure candidate and interaction logic:

- normalize workspace-relative paths and sort them deterministically;
- detect an active `@` token at the cursor when `@` is at the start of the prompt or follows whitespace;
- filter by case-insensitive path substring and rank filename-prefix matches, then path-prefix matches, before other matches;
- clamp selection and compute a six-row visible window;
- replace only the active mention token with `@<relative-path> ` while preserving surrounding prompt text.

`App` will asynchronously discover files with the existing `createGlobTool(workspace)` implementation. Discovery is capped and cancellable. Failure leaves ordinary prompt input fully functional and simply produces no mention menu.

`App` owns mention selection and dismissal state. A single completion is active at a time: slash completion keeps precedence for a leading slash token, otherwise mention completion may open. Shared key routing handles the active menu before history navigation.

`TerminalLayout` remains render-focused. It receives the derived mention completion and an optional selection callback. Each visible row is a clickable `Box`, while keyboard selection continues to be handled by `App`. The callback is optional so static render tests and non-interactive layouts remain valid.

## Interaction and Data Flow

1. File discovery begins when the application mounts and returns workspace-relative, ignore-aware file paths.
2. Typing `@` after whitespace or at prompt start derives a filtered completion from the token under the cursor.
3. Up and Down wrap through the filtered items without navigating prompt history.
4. Tab inserts the active item. Clicking any visible item inserts that exact item, regardless of the current keyboard highlight.
5. Completion adds a trailing space, places the cursor after it, and dismisses the menu for the resulting input.
6. Escape dismisses the menu for the current input. Any text edit clears dismissal and resets selection.
7. Enter retains existing prompt submission behavior.

Paths containing whitespace are inserted as an `@` token with the path escaped as `\ ` so the inserted reference remains one token and can be detected consistently.

## Layout

The mention menu appears immediately above the divider, in the same location used by slash completion. It displays at most six rows and contributes its height to the bottom-region row budget. The active row uses the existing chevron marker, matched query text is cyan and bold, and paths truncate at the terminal edge.

While the menu is open, the footer advertises `Up/Down select · Tab complete · click choose · Esc close`. Outside the menu, existing send, history, and cancellation hints are unchanged.

## Error Handling and Limits

- Workspace scanning is limited to 10,000 candidate files and uses the existing traversal resource protections.
- `.git`, ignored files, build output, and dependency directories follow the same ignore rules as the existing Glob tool.
- Discovery errors are contained in the UI effect and do not block runtime startup or input.
- Selection is clamped against every newly filtered list, so stale indices cannot address missing rows.
- Click handling ignores blank cells to the right of a rendered row.

## Testing

Tests will cover:

- activation at a start-of-prompt or whitespace-delimited `@` token and rejection of email-like text;
- path ranking, case-insensitive matching, selection wrapping, and visible-window movement;
- replacement of a mention inside surrounding text, including paths with spaces;
- key routing precedence over history navigation;
- rendering of the selected row, highlighted matches, and the mouse-aware footer hint;
- invocation of a clicked row's callback with the exact candidate path;
- regression verification with the complete Vitest suite, TypeScript checking, and production build.
