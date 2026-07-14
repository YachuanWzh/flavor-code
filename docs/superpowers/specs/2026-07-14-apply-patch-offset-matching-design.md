# ApplyPatch Offset Matching Design

## Problem

`ApplyPatch` advertises support for unified diffs, but `applyHunks()` currently treats every hunk's `oldStart` as an exact location. A valid diff whose context moved by even one line is rejected with `Patch context does not match the file`. Git accepted the captured production patch with an offset of `-1`, while the project implementation rejected it.

The saved sessions contain two real `ApplyPatch` calls and no successes. One input was a malformed diff with incorrect hunk counts and should remain rejected. The other was a valid diff with a one-line offset and should be accepted safely.

## Goals

- Apply a hunk when its complete old-side text has one exact match near the declared line.
- Preserve strict unified-diff parsing and hunk-count validation.
- Reject ambiguous matches instead of guessing.
- Report enough detail to diagnose no-match, ambiguity, and already-applied cases.
- Cover real multi-hunk behavior and offset recovery with automated tests.

## Non-goals

- Do not invoke `git apply`, `patch`, or another subprocess.
- Do not add whitespace-insensitive or edit-distance-based fuzzy matching.
- Do not add deletion, rename, multi-file, mode metadata, or no-final-newline support.
- Do not silently treat an already-applied patch as success.

## Considered Approaches

### 1. Keep exact declared-line matching

This is safest but is already unusable for common model-generated diffs and does not behave like the unified-diff tools users expect.

### 2. Bounded unique exact-context matching

Try the declared line first. If it does not match, search within 100 lines before and after it for the complete old-side hunk text. Apply only when exactly one candidate matches. This preserves exact text safety while recovering ordinary line-number drift.

This is the selected approach.

### 3. Delegate to Git or implement fuzzy matching

Git provides mature patch semantics, but a subprocess would couple a general file tool to repository state and Git availability. Whitespace or similarity-based fuzzy matching would also make automated edits harder to audit. Both are unnecessary for the observed failures.

## Matching Design

For each hunk, derive two line sequences:

- `oldLines`: context and deletion lines, in hunk order.
- `newLines`: context and addition lines, in hunk order.

Resolve the hunk location against the original file:

1. Convert `oldStart` to a zero-based declared target.
2. If `oldLines` match exactly at the declared target, use it.
3. Otherwise search from `declaredTarget - 100` through `declaredTarget + 100`, clamped to the file and to the cursor after the preceding hunk.
4. Exclude the already-tested declared target.
5. If exactly one location matches the complete `oldLines`, use that location.
6. If more than one location matches, reject the hunk as ambiguous.
7. If no old-side location matches, search for `newLines` around `newStart`. If exactly one match exists, report that the hunk appears already applied.
8. Otherwise report a detailed context mismatch.

An insertion hunk with no old-side lines cannot be relocated safely because it has no matching evidence. It continues to use only its declared target.

Each hunk is matched against the original source lines. The existing cursor rule remains in force so relocated hunks cannot overlap or move behind a previously consumed hunk.

## Error Handling

Errors identify the one-based hunk number and declared line.

- No match: include the expected first old-side line and the actual line at the declared target.
- Ambiguous match: include the candidate line numbers.
- Already applied: include the line at which the new-side sequence matched.
- Malformed counts: preserve the existing parser error and do not attempt matching.

These remain tool failures and therefore do not write the file. `applyHunks()` completes before `atomicWrite()` is called.

## Prompt and Tool Description

Keep `ApplyPatch` recommended for clear multi-hunk edits, but state that relocation uses exact unique context. Single-location replacements remain better suited to `Edit`.

## Tests

Add behavior tests that use the real file tool:

- A valid hunk with a one-line offset applies successfully.
- A multi-hunk patch applies when both hunks have unique exact context.
- Duplicate old-side context inside the search window is rejected as ambiguous.
- A previously applied hunk reports `already applied`.
- A no-match error identifies the hunk and expected/actual context.
- Existing malformed-count, path-safety, unsupported-feature, CRLF, and atomic-write behavior remains green.

Run the focused file-tool tests first, then the complete test suite, typecheck, and build.

## Success Criteria

- The captured one-line-offset failure is represented by a regression test and passes.
- Malformed hunk counts are still rejected.
- Ambiguous context never results in a write.
- All project tests, typecheck, and build complete successfully.
