# VS Code Sequence Title and Sky-Blue Welcome Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this workspace's VS Code terminal tabs honor Flavor's OSC title and render the welcome wordmark in sky blue.

**Architecture:** A project-scoped VS Code setting selects the existing OSC sequence title instead of the Windows foreground executable name. The isolated `WelcomeCard` uses one truecolor accent constant for both wide and compact brand marks.

**Tech Stack:** VS Code workspace settings, TypeScript 7, React 19, Ink-compatible local renderer, Vitest 4

## Global Constraints

- Work directly on `main` as requested.
- Preserve every pre-existing uncommitted change and concurrently created commit.
- Do not modify global VS Code user settings.
- Keep the existing OSC title hook and `process.title` fallback.
- Use exact sky blue `#67D4FF` only for the Flavor brand mark; do not redesign the rest of the card.

---

### Task 1: VS Code Sequence Title and Sky-Blue Brand Mark

**Files:**
- Create: `.vscode/settings.json`
- Modify: `src/ui/welcome.tsx`
- Modify: `tests/cli/terminal-title.test.ts`
- Modify: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Consumes: Flavor's existing `useTerminalTitle("flavor")` OSC 0 output.
- Produces: workspace setting `terminal.integrated.tabs.title = "${sequence}"` and `FLAVOR_ACCENT = "#67D4FF"`.

- [ ] **Step 1: Write failing regression tests**

Add a workspace-setting test to `tests/cli/terminal-title.test.ts`:

```ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

it("makes VS Code use the OSC sequence title instead of the node process name", async () => {
  const settings = JSON.parse(await readFile(resolve(".vscode/settings.json"), "utf8")) as Record<string, unknown>;

  expect(settings["terminal.integrated.tabs.title"]).toBe("${sequence}");
});
```

Add a wide/compact color test to `tests/ui/app-render.test.tsx`:

```tsx
it("renders the Flavor brand mark with the sky-blue truecolor accent", () => {
  const wide = renderToString(<TerminalLayout
    model="model" workspaceName="workspace" completed={[]} input="" promptCursor={0}
    columns={96} rows={30} activeSession={false}
  />, { columns: 96 });
  const compact = renderToString(<TerminalLayout
    model="model" workspaceName="workspace" completed={[]} input="" promptCursor={0}
    columns={48} rows={20} activeSession={false}
  />, { columns: 48 });

  expect(wide).toContain("\x1B[38;2;103;212;255m");
  expect(compact).toContain("\x1B[38;2;103;212;255m");
});
```

- [ ] **Step 2: Run tests and verify red**

Run: `npm test -- tests/cli/terminal-title.test.ts tests/ui/app-render.test.tsx`

Expected: FAIL because `.vscode/settings.json` does not exist and the welcome mark still uses ANSI yellow.

- [ ] **Step 3: Add the workspace title setting**

Create `.vscode/settings.json`:

```json
{
  "terminal.integrated.tabs.title": "${sequence}"
}
```

- [ ] **Step 4: Apply the sky-blue accent**

In `src/ui/welcome.tsx`, define and use the accent only on the two brand marks:

```tsx
const FLAVOR_ACCENT = "#67D4FF";

<Text color={FLAVOR_ACCENT}>{FLAVOR_WORDMARK}</Text>
<Text bold color={FLAVOR_ACCENT}>◆ Flavor Code</Text>
```

- [ ] **Step 5: Run focused verification**

Run: `npm test -- tests/cli/terminal-title.test.ts tests/ui/app-render.test.tsx && npm run build`

Expected: 24 focused tests pass and the build exits 0.

- [ ] **Step 6: Commit only this task's changes**

Stage `.vscode/settings.json`, `src/ui/welcome.tsx`, and `tests/cli/terminal-title.test.ts` normally. Stage only the new sky-blue test hunk from the already-dirty `tests/ui/app-render.test.tsx`, then inspect the cached diff before committing:

```bash
git add .vscode/settings.json src/ui/welcome.tsx tests/cli/terminal-title.test.ts
git add -p tests/ui/app-render.test.tsx
git diff --cached --check
git diff --cached
git commit -m "fix(ui): honor Flavor title in VS Code"
```

### Task 2: Final Audit

**Files:**
- Modify only files required to fix regressions introduced by Task 1.

**Interfaces:**
- Consumes: the completed workspace title setting and welcome accent.
- Produces: verified current-branch evidence without touching unrelated dirty files.

- [ ] **Step 1: Re-run focused tests**

Run: `npm test -- tests/cli/terminal-title.test.ts tests/ui/app-render.test.tsx`

Expected: all focused tests pass.

- [ ] **Step 2: Verify package build**

Run: `npm run build`

Expected: exit code 0.

- [ ] **Step 3: Audit branch and working tree**

Run: `git branch --show-current && git status --short --branch && git diff --check && git log -6 --oneline --decorate`

Expected: branch remains `main`; this task's commit is present; all unrelated uncommitted changes remain unstaged and intact.
