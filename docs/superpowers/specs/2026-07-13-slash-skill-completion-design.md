# Slash Command and Skill Completion Design

## Goal

Add Claude Code-style slash completion to the terminal prompt. Typing `/` opens a merged list of built-in commands, plugin commands, and discovered skills. Typing a keyword filters the list, Up and Down change the active item, and Tab completes it. Matching text is highlighted.

## Scope

The feature covers discovery, filtering, ranking, rendering, keyboard navigation, completion, and explicit skill invocation. It does not add mouse interaction, fuzzy typo correction, argument completion, or completion sources other than commands, plugins, and skills.

## Architecture

Completion behavior will be implemented as a small, independently testable UI model instead of adding all logic directly to `src/ui/app.tsx`.

The model will:

- normalize built-in commands, plugin commands, and skill metadata into one candidate type;
- detect whether the cursor is inside the leading slash token;
- filter candidates case-insensitively by a contiguous substring of the candidate name;
- rank prefix matches before other substring matches and use name order as the deterministic tie-breaker;
- clamp or wrap selection and keep a bounded visible window around the active item;
- return the completed prompt text and cursor position for Tab.

`App` will own the current selection index and receive completion data from the active production runtime. `TerminalLayout` will remain render-focused and receive the already-derived menu state.

## Candidate Sources

The menu combines three sources:

1. Built-in slash commands from `MVP_COMMANDS`.
2. Plugin command names exposed by `SessionServices.pluginCommands()`.
3. Skill name, description, and source returned by `SessionServices.skills()`.

Each row displays its type (`command`, `plugin`, or `skill`). Skill rows also display the skill description where terminal width permits. Duplicate names use the executable precedence already implied by submission handling: built-in command, then plugin command, then skill.

## Interaction

The menu opens only when the prompt begins with `/` and the cursor is within its first whitespace-delimited token. It closes when that condition stops being true, while a session is active, or while an approval prompt is active.

- Text input updates the query and resets selection to the first result.
- Up and Down cycle through filtered results and do not navigate prompt history while the menu is open.
- Tab replaces the leading slash token with the selected candidate and appends one space, leaving the prompt unsubmitted so arguments can be entered.
- Escape dismisses the menu for the current input value. Editing the query reopens it.
- Enter retains existing submission behavior.

The menu displays a bounded number of rows. When selection moves beyond the visible range, the window follows it. The selected row is rendered with inverse or background emphasis. Every case-insensitive occurrence of the typed query in the candidate name is rendered in a contrasting highlight color; an empty query does not highlight every character.

## Skill Invocation

Completing a skill must produce a usable prompt. Submission parsing will recognize `/skill-name` only when it matches a discovered skill and will run the normal agent loop with that exact skill body loaded as prompt-scoped additional context. Any text after the skill name is passed as the user's instruction. This avoids treating selected skills as unknown commands and avoids relying on heuristic skill matching after explicit selection.

Unknown slash names retain the current unknown-command behavior. Built-in and plugin command execution is unchanged.

## Layout

The suggestion menu renders directly above the prompt divider in the fixed bottom region, matching the reference interaction. Its height contributes to the bottom-region row budget so it does not overwrite transcript content. Rows truncate descriptions at the terminal edge, and narrow terminals prioritize the candidate name over metadata.

The footer hint changes while the menu is open to advertise `Up/Down select` and `Tab complete`; otherwise the current history and send hints remain unchanged.

## Error Handling

Skill discovery failure must not crash prompt input. The menu continues to show built-in and plugin commands, while existing runtime diagnostics remain responsible for reporting invalid skill files. If the runtime is still starting, built-in candidates remain available and dynamic candidates appear once loaded.

Selection is always derived against the current filtered list, preventing stale indices when candidates or queries change.

## Testing

Tests will cover:

- activation only for a leading slash token;
- merged-source de-duplication and precedence;
- case-insensitive substring filtering and prefix-first ordering;
- match-range calculation for highlighting;
- Up/Down wrapping and bounded menu windows;
- Tab replacement and cursor placement;
- slash skill parsing and explicit skill execution;
- terminal rendering of selected rows, highlighted matches, type labels, and footer hints;
- regression coverage for history navigation and ordinary prompt editing when the menu is closed.

Verification will run the focused UI/session tests, the complete Vitest suite, TypeScript type checking, and the production build.
