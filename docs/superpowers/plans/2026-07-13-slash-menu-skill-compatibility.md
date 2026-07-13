# Slash Menu Polish and Skill Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove slash candidate type labels, style completed slash tokens with a soft periwinkle foreground, and discover Claude Code skills with extended frontmatter while respecting `disable-model-invocation`.

**Architecture:** Extend `SkillMetadata` with one normalized manual-only flag while allowing unknown safe YAML keys. Keep UI decisions in pure slash-completion helpers, then let `TerminalLayout` render candidate descriptions and prompt token segments without storing extra completion state.

**Tech Stack:** TypeScript 7, React 19, local Ink-compatible renderer, YAML 2, Vitest 4.

## Global Constraints

- Work directly on the existing `main` branch; do not create a worktree or use subagents.
- Preserve unrelated `.gitignore`, `FLAVOR.md`, and `src/agent/loop.ts` changes.
- Candidate rows show marker, name, and optional description; never render candidate kind.
- Completed slash tokens use `rgb(120,155,255)` plus bold; arguments retain default styling.
- `name` and `description` remain required; unknown safe frontmatter keys are accepted.
- `disable-model-invocation: true` prevents automatic matching but not discovery or explicit slash invocation.
- Add no dependencies and do not add hot reload, argument syntax highlighting, plugin descriptions, or namespaced commands.

---

### Task 1: Compatible Skill Frontmatter

**Files:**
- Modify: `src/skills/registry.ts`
- Modify: `tests/skills/registry.test.ts`
- Modify: `tests/cli/session.test.ts`

**Interfaces:**
- Consumes: YAML mappings containing required `name` and `description` plus optional extension fields.
- Produces: `SkillMetadata.disableModelInvocation: boolean` and matching behavior that excludes manual-only skills.

- [ ] **Step 1: Write failing compatibility tests**

Add tests that create these skills:

```ts
await skill(f.projectRoot, "manual-skill", [
  "name: manual-skill",
  "description: Manual workflow",
  "disable-model-invocation: true",
  "argument-hint: '[topic]'",
  "vendor-field: preserved-for-compatibility",
].join("\n"));
await skill(f.projectRoot, "invalid-manual-flag", [
  "name: invalid-manual-flag",
  "description: Invalid flag",
  "disable-model-invocation: yes",
].join("\n"));
```

Assert that `discover()` includes `manual-skill` with `disableModelInvocation: true`, `match("manual workflow")` does not return it, and diagnostics reject `invalid-manual-flag` with a boolean-specific message. Add a normal skill and assert it still matches. Update the old `extra-key` expectation because unknown fields are now compatible rather than invalid.

- [ ] **Step 2: Run the registry tests and verify RED**

Run: `npx vitest run tests/skills/registry.test.ts`

Expected: FAIL because extended fields are rejected and metadata has no manual-only flag.

- [ ] **Step 3: Implement compatible parsing and normalized metadata**

Extend the interfaces:

```ts
export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly root: string;
  readonly disableModelInvocation: boolean;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  bodyOffset: number;
}
```

In `readFrontmatter()`, remove exact-key equality. Validate required strings, then validate `metadata["disable-model-invocation"]` as `undefined | boolean` and normalize omission to `false`. Ignore all other safe parsed keys. Copy the normalized flag into discovered metadata, compare it in `loadBody()`, and filter `#sortedMetadata()` candidates with the flag before automatic scoring in `match()`.

- [ ] **Step 4: Run focused tests and type checking**

Run: `npx vitest run tests/skills/registry.test.ts tests/skills/tool.test.ts tests/cli/session.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit registry compatibility**

```bash
git add src/skills/registry.ts tests/skills/registry.test.ts tests/cli/session.test.ts
git commit -m "feat(skills): support extended frontmatter"
```

### Task 2: Description-Only Menu and Completed Token Styling

**Files:**
- Modify: `src/ui/commands.ts`
- Modify: `src/ui/slash-completion.ts`
- Modify: `src/ui/app.tsx`
- Modify: `tests/ui/slash-completion.test.ts`
- Modify: `tests/ui/app-render.test.tsx`
- Modify: `tests/ui/input.test.ts`

**Interfaces:**
- Consumes: built-in command descriptions, plugin names, discovered skill descriptions, current input, and whether the menu is open.
- Produces: `completedSlashTokenLength()` and prompt presentation metadata with `{ color: "rgb(120,155,255)", bold: true }`.

- [ ] **Step 1: Write failing menu and prompt-presentation tests**

Update the layout test so a rendered skill row contains `frontend-design` and `Design interfaces` but does not contain the standalone text `skill` or `command`. Add a built-in candidate test with a description.

Add pure model tests:

```ts
expect(completedSlashTokenLength("/goal ", candidates, false)).toBe(5);
expect(completedSlashTokenLength("/goal condition | clear", candidates, false)).toBe(5);
expect(completedSlashTokenLength("/go", candidates, true)).toBe(0);
expect(completedSlashTokenLength("/unknown value", candidates, false)).toBe(0);
expect(completedSlashTokenPresentation()).toEqual({ color: "rgb(120,155,255)", bold: true });
```

- [ ] **Step 2: Run focused UI tests and verify RED**

Run: `npx vitest run tests/ui/slash-completion.test.ts tests/ui/app-render.test.tsx tests/ui/input.test.ts`

Expected: FAIL because kind labels remain and completed-token helpers do not exist.

- [ ] **Step 3: Add built-in descriptions and presentation helpers**

Export a `COMMAND_DESCRIPTIONS` record from `src/ui/commands.ts`. Update candidate construction to accept command entries with name and description while preserving built-in > plugin > skill precedence.

Add exact helpers:

```ts
export function completedSlashTokenLength(
  input: string,
  candidates: readonly SlashCandidate[],
  menuOpen: boolean,
): number;

export function completedSlashTokenPresentation(): {
  color: "rgb(120,155,255)";
  bold: true;
};
```

Return zero while the menu is open, for unknown names, or for non-leading slash text. Otherwise return the code-point length of the exact leading slash token.

- [ ] **Step 4: Render descriptions without kinds and style prompt segments**

Remove the kind `<Text>` node from `SlashMenu`; retain candidate kind only in keys and behavior. In `App`, derive completed token length from current candidates and menu state and pass it to `TerminalLayout`/`PromptLine`.

In `PromptLine`, track each wrapped line's global code-point offset. Split `before`, caret, and `after` at the completed-token boundary so only token characters receive the periwinkle bold style. Preserve inverse caret styling and default argument styling.

- [ ] **Step 5: Run focused UI tests and type checking**

Run: `npx vitest run tests/ui/slash-completion.test.ts tests/ui/app-render.test.tsx tests/ui/input.test.ts && npm run typecheck`

Expected: all focused tests pass and TypeScript exits 0.

- [ ] **Step 6: Commit UI polish**

```bash
git add src/ui/commands.ts src/ui/slash-completion.ts src/ui/app.tsx tests/ui/slash-completion.test.ts tests/ui/app-render.test.tsx tests/ui/input.test.ts
git commit -m "feat(ui): polish slash completion presentation"
```

### Task 3: Full Verification

**Files:**
- Modify only files directly implicated by failures caused by Tasks 1–2.

**Interfaces:**
- Consumes: completed registry and UI changes.
- Produces: standard test, type-check, and build evidence with unrelated user files preserved.

- [ ] **Step 1: Run the standard project checks**

```powershell
npm test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Inspect repository state**

Run: `git diff --check && git status --short && git log -5 --oneline`

Expected: no whitespace errors; only the pre-existing `.gitignore`, `FLAVOR.md`, and `src/agent/loop.ts` user changes remain uncommitted.
