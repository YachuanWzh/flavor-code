# ApplyPatch Offset Matching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ApplyPatch` safely recover valid hunks whose declared line numbers drifted while preserving strict parsing and rejecting ambiguous edits.

**Architecture:** Keep unified-diff parsing unchanged. Add a bounded exact-line matcher inside `src/tools/files.ts` that resolves each hunk at its declared location or one unique location within ±100 lines, returns effective hunk coordinates for accurate presentation, and produces specific ambiguity/already-applied/no-match errors.

**Tech Stack:** TypeScript 7, Node.js 20+, Vitest 4, existing file-tool and presentation APIs.

## Global Constraints

- Do not invoke Git or patch subprocesses from the production tool.
- Do not add whitespace-insensitive or similarity-based fuzzy matching.
- Keep malformed hunk counts, deletion, rename, multi-file, mode metadata, and no-final-newline inputs rejected.
- Do not silently treat already-applied hunks as success.
- Work in the current checkout as requested and preserve unrelated LSP/report changes.

---

### Task 1: Resolve hunks by bounded unique exact context

**Files:**
- Modify: `tests/tools/files.test.ts`
- Modify: `src/tools/files.ts`

**Interfaces:**
- Consumes: existing `PatchHunk`, `createApplyPatchTool()`, `buildPatchPresentation()`.
- Produces: `AppliedHunks { content: string; hunks: PatchHunk[] }`, `resolveHunkTarget()`, and a `PATCH_SEARCH_RADIUS` of 100 lines.

- [x] **Step 1: Write failing regression tests**

Add tests using real temporary files for these behaviors:

```ts
it("ApplyPatch relocates a hunk by unique exact context", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
  const path = join(workspace, "file.txt");
  writeFileSync(path, "zero\none\ntwo\nthree\n");
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -3,2 +3,2 @@\n-one\n+ONE\n two\n";

  const output = await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

  expect(readFileSync(path, "utf8")).toBe("zero\nONE\ntwo\nthree\n");
  expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "removed", oldLine: 2, text: "one" });
  expect(getToolPresentation(output)?.lines).toContainEqual({ kind: "added", newLine: 2, text: "ONE" });
});

it("ApplyPatch relocates multiple hunks independently", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
  const path = join(workspace, "file.txt");
  writeFileSync(path, "prefix\na\nold-a\nc\nmiddle\nd\nold-b\nf\n");
  const patch = [
    "--- a/file.txt", "+++ b/file.txt",
    "@@ -4,3 +4,3 @@", " a", "-old-a", "+new-a", " c",
    "@@ -9,3 +9,3 @@", " d", "-old-b", "+new-b", " f", "",
  ].join("\n");

  await createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal);

  expect(readFileSync(path, "utf8")).toBe("prefix\na\nnew-a\nc\nmiddle\nd\nnew-b\nf\n");
});

it("ApplyPatch rejects ambiguous relocated context without writing", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
  const path = join(workspace, "file.txt");
  const original = "same\nold\nsame\nx\nsame\nold\nsame\n";
  writeFileSync(path, original);
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -4,3 +4,3 @@\n same\n-old\n+new\n same\n";

  await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
    .rejects.toThrow(/hunk 1.*ambiguous.*lines 1, 5/i);
  expect(readFileSync(path, "utf8")).toBe(original);
});

it("ApplyPatch diagnoses an already-applied hunk", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
  const path = join(workspace, "file.txt");
  writeFileSync(path, "zero\nnew\nend\n");
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-old\n+new\n";

  await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
    .rejects.toThrow(/hunk 1.*already applied.*line 2/i);
});

it("ApplyPatch reports expected and actual context on mismatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-files-"));
  const path = join(workspace, "file.txt");
  writeFileSync(path, "zero\nactual\nend\n");
  const patch = "--- a/file.txt\n+++ b/file.txt\n@@ -2 +2 @@\n-old\n+new\n";

  await expect(createApplyPatchTool(workspace).execute({ patch }, new AbortController().signal))
    .rejects.toThrow(/hunk 1.*declared line 2.*expected.*old.*actual/i);
});
```

- [x] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/tools/files.test.ts`

Expected: the offset test fails with `Patch context does not match the file`; diagnostic tests fail because the existing generic message lacks hunk details.

- [x] **Step 3: Implement the minimal exact matcher**

In `src/tools/files.ts`, add the following structure and wire it into `applyHunks()`:

```ts
const PATCH_SEARCH_RADIUS = 100;

interface AppliedHunks { content: string; hunks: PatchHunk[] }

function matchesLines(source: readonly string[], start: number, expected: readonly string[]): boolean {
  return start >= 0
    && start + expected.length <= source.length
    && expected.every((line, index) => source[start + index] === line);
}

function exactMatchesNear(
  source: readonly string[], expected: readonly string[], declared: number, cursor: number,
): number[] {
  if (expected.length === 0 || source.length < expected.length) return [];
  const first = Math.max(cursor, 0, declared - PATCH_SEARCH_RADIUS);
  const last = Math.min(source.length - expected.length, declared + PATCH_SEARCH_RADIUS);
  const matches: number[] = [];
  for (let start = first; start <= last; start += 1) {
    if (matchesLines(source, start, expected)) matches.push(start);
  }
  return matches;
}
```

`resolveHunkTarget()` must try the declared target first, require exactly one nearby old-side match, detect one nearby new-side match as already applied, and otherwise throw a message containing the hunk number, declared line, expected first old line, and actual declared line. `applyHunks()` must return effective `oldStart` and `newStart` values shifted by the resolved offset so the diff presentation shows actual line numbers.

- [x] **Step 4: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/tools/files.test.ts`

Expected: all file-tool tests pass, including the five new regression tests.

- [x] **Step 5: Review the focused diff**

Run: `git diff --check -- src/tools/files.ts tests/tools/files.test.ts`

Expected: exit code 0 and no whitespace errors.

### Task 2: Align guidance and verify the project

**Files:**
- Modify: `src/prompts/system.ts`
- Modify: `tests/prompts/system.test.ts`

**Interfaces:**
- Consumes: `toolsSection()` and `buildSystemPrompt()`.
- Produces: user-facing guidance that relocation requires exact unique nearby context.

- [x] **Step 1: Write the failing prompt test**

In the existing available-tools test, add:

```ts
expect(allTools).toContain("exact unique nearby context");
```

- [x] **Step 2: Run the prompt test and verify RED**

Run: `npm test -- --run tests/prompts/system.test.ts`

Expected: failure because the current `ApplyPatch` guidance only says `clear multi-hunk file edits`.

- [x] **Step 3: Update the ApplyPatch guidance**

Replace the rule with:

```ts
addToolRule(rules, toolNames, "ApplyPatch", "Use `ApplyPatch` for clear multi-hunk file edits. Hunks may relocate only when their exact context has one unique nearby match; use `Edit` for a single replacement.");
```

- [x] **Step 4: Run the prompt test and verify GREEN**

Run: `npm test -- --run tests/prompts/system.test.ts`

Expected: all prompt tests pass.

- [x] **Step 5: Run complete verification**

Run in order:

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits 0; the full suite has zero failed tests; TypeScript and the production bundle build without errors.

Verification result on 2026-07-14:

- ApplyPatch and prompt tests: 30 passed, 0 failed.
- Production build: passed.
- `git diff --check`: passed.
- Full suite: 475 passed, 3 failed, 2 skipped. The same three `tests/cli/production.test.ts` failures reproduce in a clean clone of committed `HEAD`, so they are baseline failures outside this change.
- Typecheck: failed on existing `src/auth/oauth.ts`, `src/ui/task-progress-model.ts`, session/transcript tests, and the separate uncommitted LSP work. No error references `src/tools/files.ts`, `tests/tools/files.test.ts`, `src/prompts/system.ts`, or `tests/prompts/system.test.ts`.
