# Slash Command and Skill Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Claude Code-style merged slash menu with filtering, highlighted matches, keyboard selection, Tab completion, and executable skill commands.

**Architecture:** Put deterministic candidate and selection logic in a new pure `slash-completion` module. Extend slash parsing and session services so a selected skill is loaded explicitly. Keep `App` responsible for runtime state and key routing, while `TerminalLayout` renders a derived menu model.

**Tech Stack:** TypeScript 7, React 19, Ink-compatible local renderer, Vitest 4.

## Global Constraints

- Work directly on the existing `main` branch; do not create a worktree.
- Merge built-in commands, plugin commands, and discovered skills.
- Use case-insensitive contiguous substring matching, with prefix matches first.
- Up and Down select, Tab completes without submitting, Escape dismisses, and matched text is highlighted.
- Do not add dependencies, mouse interaction, fuzzy matching, argument completion, or new completion sources.

---

### Task 1: Pure Slash Completion Model

**Files:**
- Create: `src/ui/slash-completion.ts`
- Create: `tests/ui/slash-completion.test.ts`

**Interfaces:**
- Consumes: `MVP_COMMANDS` from `src/ui/commands.ts` and skill-shaped `{ name, description, source }` values.
- Produces: `SlashCandidate`, `SlashCompletion`, `buildSlashCandidates()`, `deriveSlashCompletion()`, `moveSlashSelection()`, `completeSlashSelection()`, and `matchRanges()`.

- [ ] **Step 1: Write failing model tests**

```ts
import { describe, expect, it } from "vitest";
import {
  buildSlashCandidates, completeSlashSelection, deriveSlashCompletion,
  matchRanges, moveSlashSelection,
} from "../../src/ui/slash-completion.js";

describe("slash completion", () => {
  const candidates = buildSlashCandidates(
    ["deploy", "help"],
    ["deploy", "doctor"],
    [{ name: "frontend-design", description: "Design interfaces", source: "project" }],
  );

  it("merges sources with command then plugin then skill precedence", () => {
    expect(candidates.map(({ name, kind }) => [name, kind])).toEqual([
      ["deploy", "command"], ["help", "command"], ["doctor", "plugin"],
      ["frontend-design", "skill"],
    ]);
  });

  it("activates only inside the leading slash token and ranks prefixes first", () => {
    expect(deriveSlashCompletion("/de", 3, candidates, 0)?.items.map((item) => item.name))
      .toEqual(["deploy", "frontend-design"]);
    expect(deriveSlashCompletion("say /de", 7, candidates, 0)).toBeNull();
    expect(deriveSlashCompletion("/deploy now", 11, candidates, 0)).toBeNull();
  });

  it("wraps selection and completes the leading token", () => {
    expect(moveSlashSelection(0, -1, 3)).toBe(2);
    expect(moveSlashSelection(2, 1, 3)).toBe(0);
    expect(completeSlashSelection("/de", 3, "deploy")).toEqual({ text: "/deploy ", cursor: 8 });
  });

  it("returns case-insensitive highlight ranges", () => {
    expect(matchRanges("Frontend-Design", "de")).toEqual([[9, 11]]);
    expect(matchRanges("help", "")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the model test and confirm the missing-module failure**

Run: `npx vitest run tests/ui/slash-completion.test.ts`

Expected: FAIL because `src/ui/slash-completion.ts` does not exist.

- [ ] **Step 3: Implement the pure model**

Create immutable candidate types and functions with these exact signatures:

```ts
export type SlashCandidateKind = "command" | "plugin" | "skill";
export interface SlashCandidate { name: string; kind: SlashCandidateKind; description?: string; source?: string }
export interface SlashCompletion { query: string; items: SlashCandidate[]; selectedIndex: number; windowStart: number }
export function buildSlashCandidates(
  commands: readonly string[], plugins: readonly string[],
  skills: readonly { name: string; description: string; source: string }[],
): SlashCandidate[];
export function deriveSlashCompletion(
  input: string, cursor: number, candidates: readonly SlashCandidate[], selectedIndex: number,
  visibleLimit?: number,
): SlashCompletion | null;
export function moveSlashSelection(index: number, delta: -1 | 1, count: number): number;
export function completeSlashSelection(input: string, cursor: number, name: string): { text: string; cursor: number };
export function matchRanges(value: string, query: string): Array<[number, number]>;
```

Use a `Map` populated in command/plugin/skill order for de-duplication. Detect activation with the code-point slice before the cursor matching `^/[^\s]*$` and reject inputs whose text after the cursor remains inside a later token. Filter on `name.toLowerCase().includes(query.toLowerCase())`; sort prefix matches first, then `localeCompare`. Compute `windowStart` so the selected row remains inside `visibleLimit` (default 6).

- [ ] **Step 4: Run the model tests**

Run: `npx vitest run tests/ui/slash-completion.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the model**

```bash
git add src/ui/slash-completion.ts tests/ui/slash-completion.test.ts
git commit -m "feat(ui): add slash completion model"
```

### Task 2: Explicit Skill Slash Invocation

**Files:**
- Modify: `src/ui/commands.ts`
- Modify: `src/ui/session.ts`
- Modify: `src/production.ts`
- Modify: `tests/ui/commands.test.ts`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Consumes: exact skill names returned by `SessionServices.skills()`.
- Produces: `SlashCommand` variant `{ name: "skill"; skill: string; prompt: string }` and `SessionServices.runSkill(skill, prompt, signal)`.

- [ ] **Step 1: Add failing parser and session tests**

Add parser assertions:

```ts
expect(parseSlashCommand("/frontend-design polish footer", [], ["frontend-design"]))
  .toEqual({ name: "skill", skill: "frontend-design", prompt: "polish footer" });
expect(parseSlashCommand("/help", ["help"], ["help"])).toEqual({ name: "help" });
```

Add a `FlavorSession` test double whose `skills()` returns a named skill and whose `runSkill()` records arguments and yields `{ type: "text", text: "done" }`. Submit `/frontend-design polish footer` and assert `runSkill` receives the exact skill name and argument text while ordinary `run()` is not called.

- [ ] **Step 2: Run focused tests and confirm failures**

Run: `npx vitest run tests/ui/commands.test.ts tests/ui/input.test.ts`

Expected: FAIL because the parser has no skill-command parameter or variant and session services have no `runSkill` method.

- [ ] **Step 3: Extend parsing and session dispatch**

Change the parser signature to:

```ts
export function parseSlashCommand(
  input: string,
  dynamicCommands: readonly string[] = [],
  skillCommands: readonly string[] = [],
): SlashCommand | null;
```

Preserve precedence by checking `MVP_COMMANDS`, then plugin names, then skill names. Parse the remaining words into one trimmed `prompt` string. In `FlavorSession.#runSubmission`, await `services.skills()`, pass their names to the parser, and dispatch the new variant by iterating `services.runSkill(command.skill, command.prompt, signal)` into `services.output`.

Type `skills()` as `Promise<readonly SkillMetadata[]>` and add:

```ts
runSkill(skill: string, prompt: string, signal: AbortSignal): AsyncIterable<AgentEvent>;
```

- [ ] **Step 4: Implement explicit production loading**

Add a generator that finds the exact discovered skill, loads its body, and calls the main loop with prompt-scoped context:

```ts
async function* runExplicitSkill(
  harness: LocalHarness, skills: SkillRegistry, skillName: string,
  prompt: string, signal: AbortSignal, setupError?: string,
): AsyncIterable<AgentEvent> {
  if (setupError !== undefined) { yield { type: "error", error: { code: "unknown", message: setupError } }; return; }
  const skill = (await skills.discover()).find(({ name }) => name === skillName);
  if (skill === undefined) { yield { type: "error", error: { code: "unknown", message: `Unknown skill: ${skillName}` } }; return; }
  const userPrompt = prompt || `Apply the ${skillName} skill.`;
  const additionalContext = `Matched skill: ${skill.name}\n${await skills.loadBody(skill)}`;
  yield* harness.main.loop.run({ prompt: userPrompt, signal, additionalContext });
}
```

Wire `services.runSkill` through the existing persistence wrapper.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run tests/ui/commands.test.ts tests/ui/input.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit explicit skill invocation**

```bash
git add src/ui/commands.ts src/ui/session.ts src/production.ts tests/ui/commands.test.ts tests/ui/input.test.ts
git commit -m "feat(skills): invoke skills from slash commands"
```

### Task 3: Interactive Menu and Highlighted Rendering

**Files:**
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/app-render.test.tsx`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Consumes: all Task 1 completion functions and `runtime.services.skills()` / `pluginCommands()`.
- Produces: menu state passed to `TerminalLayout`, keyboard routing in `App`, and highlighted `SlashMenu` output.

- [ ] **Step 1: Add failing rendering and routing tests**

Render `TerminalLayout` with a derived completion containing `frontend-design` selected and `doctor` unselected. Strip ANSI for structural assertions and retain raw ANSI for highlight assertions. Assert output contains the names, `skill`, `plugin`, descriptions, and `Up/Down select · Tab complete`; assert the selected row uses inverse ANSI and the `de` substring uses the chosen highlight color.

Add exported pure routing coverage around a helper with this contract:

```ts
export function slashKeyAction(
  key: Pick<Key, "upArrow" | "downArrow" | "tab" | "escape">,
  completion: SlashCompletion | null,
): { type: "select"; delta: -1 | 1 } | { type: "complete" } | { type: "dismiss" } | null;
```

Assert Up/Down/Tab/Escape return menu actions only when completion is non-null and that closed-menu arrows still classify as history.

- [ ] **Step 2: Run focused UI tests and confirm failures**

Run: `npx vitest run tests/ui/app-render.test.tsx tests/ui/input.test.ts`

Expected: FAIL because `TerminalLayout` has no completion prop and `slashKeyAction` does not exist.

- [ ] **Step 3: Load candidates and route keys in `App`**

Add candidate, selection, and dismissed-input state. Start with built-ins immediately; after runtime creation, call `created.services.skills()` and combine those results with `created.services.pluginCommands()`. Catch discovery failures and retain built-ins/plugins.

Derive the current completion on every render. Before history handling:

- Up/Down update selection with `moveSlashSelection`.
- Tab applies `completeSlashSelection`, updates both text and cursor, and dismisses the completed menu.
- Escape records the current input as dismissed.
- Any text edit clears dismissal and resets selection to zero.

Do not activate menu actions during approvals or active agent sessions.

- [ ] **Step 4: Render the bounded menu and highlights**

Extend `TerminalLayoutProps` with `completion?: SlashCompletion`. Render at most six rows above the divider and include those rows in the fixed-bottom height calculation. Implement `SlashMenu` and `HighlightedName` using nested `Text` nodes: ordinary segments inherit row style and every `[start, end]` from `matchRanges` receives a contrasting color plus bold. Apply `inverse` to the selected row and truncate descriptions at the terminal width.

Use the exact active footer copy `↑/↓ select · Tab complete · Esc close`. Preserve existing footer text when the menu is absent.

- [ ] **Step 5: Run focused UI tests**

Run: `npx vitest run tests/ui/slash-completion.test.ts tests/ui/app-render.test.tsx tests/ui/input.test.ts`

Expected: PASS.

- [ ] **Step 6: Run complete verification**

Run: `npm test`

Expected: all Vitest suites pass.

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript errors.

Run: `npm run build`

Expected: tsup completes all configured bundles with exit code 0.

- [ ] **Step 7: Commit the interactive menu**

```bash
git add src/ui/app.tsx tests/ui/app-render.test.tsx tests/ui/input.test.ts
git commit -m "feat(ui): add interactive slash menu"
```

### Task 4: Final Regression Review

**Files:**
- Modify only files implicated by verification failures.

**Interfaces:**
- Consumes: the completed slash model, explicit skill execution, and terminal integration.
- Produces: a clean `main` worktree with all checks passing.

- [ ] **Step 1: Inspect the full diff**

Run: `git diff HEAD~3 --check && git diff --stat HEAD~3 && git status --short`

Expected: no whitespace errors and no unrelated files.

- [ ] **Step 2: Re-run the release verification sequence**

Run: `npm test && npm run typecheck && npm run build`

Expected: every command exits 0.

- [ ] **Step 3: Confirm repository state**

Run: `git status --short`

Expected: empty output.
