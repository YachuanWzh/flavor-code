# Slash Menu Polish and Skill Compatibility Design

## Goal

Polish slash completion to match the Claude Code interaction more closely and allow Flavor to discover Claude Code-style skills without editing their frontmatter.

## Scope

This change covers slash candidate row content, completed slash-token coloring, and compatible parsing of extended skill frontmatter. It does not add argument syntax highlighting, plugin descriptions, hot skill reloading, namespaced skill names, or execution semantics for extension fields other than `disable-model-invocation`.

## Slash Candidate Rows

Each row renders:

- the existing `›` marker for the selected candidate;
- the candidate name, with the typed query highlighted;
- the candidate description when one is available.

The `command`, `plugin`, and `skill` type labels are removed. Candidate kinds remain in the internal model because command precedence and execution still depend on them, but kind is no longer presentation content.

Skill descriptions come from `SKILL.md`. Built-in commands may use locally defined descriptions. Plugin commands remain name-only until the plugin API exposes descriptions.

## Completed Token Styling

After Tab completes a candidate, only the first slash token is styled. For example, in `/goal condition | clear`, `/goal` is styled while the following space and arguments retain the default prompt color.

The token uses a soft periwinkle foreground (`rgb(120,155,255)`) plus bold weight. This avoids low-contrast pure blue on dark terminals and remains distinguishable from the cyan query-match highlight in the open menu.

Styling is derived rather than stored as fragile UI state. The prompt token is styled only when:

- the leading token starts with `/`;
- its name exactly matches a current command, plugin command, or discovered skill;
- the slash menu is closed, which includes the post-Tab state and prompts whose argument entry has begun.

The caret remains inverse-styled at its current position, including when it sits immediately after the styled token. Wrapping continues to use the existing code-point-aware prompt layout.

## Extended Skill Frontmatter

`name` and `description` remain required non-empty strings. Skill names and folder-name equality keep their current validation.

Additional safe YAML mapping keys are accepted. Unknown keys are ignored by the current runtime rather than rejecting the whole skill. YAML duplicate keys, aliases, unsafe tags, multiple documents, invalid UTF-8, metadata limits, and filesystem safety checks remain unchanged.

Flavor recognizes `disable-model-invocation` when present:

- omitted or `false`: the skill may participate in automatic prompt matching;
- `true`: the skill is discoverable, appears in slash completion, can be explicitly invoked with `/name`, but is excluded from automatic prompt matching;
- any non-boolean value: the skill is rejected with a clear diagnostic.

`argument-hint` and other extension fields are accepted but not interpreted in this change.

`SkillMetadata` carries the normalized `disableModelInvocation` boolean so matching does not need to re-read files. `loadBody()` revalidates this interpreted value along with name and description to detect frontmatter changes between discovery and use.

## Data Flow

At startup, `SkillRegistry.discover()` parses compatible metadata and returns every valid skill, including manual-only skills. The slash candidate builder receives the complete list, so manual-only skills remain visible.

For ordinary prompts, `SkillRegistry.match()` filters out `disableModelInvocation` skills before scoring. For explicit slash execution, the session resolves the exact discovered name and loads the skill body regardless of that flag.

The UI derives a completed slash-token presentation from the current input, cursor-independent candidate names, and whether the menu is open. `PromptLine` renders styled and unstyled prompt segments while preserving the existing cursor cell.

## Error Handling

Invalid required fields or a non-boolean `disable-model-invocation` value produce per-skill diagnostics and do not prevent other skills from loading. Unknown extension fields do not produce diagnostics. Existing startup behavior continues: newly installed skills require a Flavor restart because registry discovery is cached for the session.

## Testing

Tests will verify:

- candidate rows omit kind labels while retaining descriptions;
- query matches remain cyan and bold in the open menu;
- a completed exact slash token receives periwinkle bold styling while arguments remain unstyled;
- partial, unknown, or still-open slash tokens are not styled as completed tokens;
- skills with `argument-hint` and unknown extension fields are discovered;
- `disable-model-invocation: true` skills are discovered but excluded from automatic matching;
- explicitly selected manual-only skills remain available to session dispatch;
- non-boolean `disable-model-invocation` values are diagnosed;
- existing strict YAML, resource safety, registry precedence, prompt editing, and command execution tests continue to pass.

Verification will run focused UI and registry tests, the standard full Vitest suite, TypeScript type checking, and the production build.
