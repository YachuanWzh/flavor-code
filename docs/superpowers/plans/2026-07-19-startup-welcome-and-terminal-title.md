# Startup Welcome and Terminal Title Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a responsive Flavor-branded empty-state welcome card and make VS Code identify the interactive terminal as `flavor` instead of `node`.

**Architecture:** A focused `WelcomeCard` component owns responsive empty-state rendering while `TerminalLayout` derives visibility from the existing transcript state. Interactive CLI startup applies a small testable process-title helper in addition to the existing OSC title hook.

**Tech Stack:** TypeScript 7, React 19, Ink-compatible local renderer, Commander 15, Vitest 4

## Global Constraints

- Work directly on `main` as requested.
- Preserve every pre-existing uncommitted change, including edits in `src/ui/app.tsx` and `tests/ui/app-render.test.tsx`.
- Show the welcome card only when `completed.length === 0` and `active === undefined`.
- Keep `flavor --print`, `flavor init`, version output, and import-only consumers free of the process-title side effect.
- Add no dependency, network-backed content, dynamic release notes, or unrelated transcript/task refactor.

---

### Task 1: Responsive Empty-State Welcome Card

**Files:**
- Create: `src/ui/welcome.tsx`
- Modify: `src/ui/app.tsx`
- Test: `tests/ui/app-render.test.tsx`

**Interfaces:**
- Produces: `WelcomeCard({ model, workspaceName, columns }: WelcomeCardProps): React.JSX.Element`.
- Consumes: existing local `Box` and `Text` primitives and `TerminalLayout`'s `model`, `workspaceName`, and `columns` props.

- [ ] **Step 1: Write failing empty-state renderer tests**

Append focused cases to the existing `TerminalLayout` suite:

```tsx
const stripAnsi = (value: string): string => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "");

it("shows the Flavor welcome card only for an empty transcript", () => {
  const empty = stripAnsi(renderToString(<TerminalLayout
    model="anthropic:deepseek-v4-pro" workspaceName="flavor-code"
    completed={[]} input="" promptCursor={0} columns={96} rows={30} activeSession={false}
  />, { columns: 96 }));
  const active = stripAnsi(renderToString(<TerminalLayout
    model="anthropic:deepseek-v4-pro" workspaceName="flavor-code"
    completed={[]} active={turn(1, "hello", "")} input="" promptCursor={0}
    columns={96} rows={30} activeSession
  />, { columns: 96 }));

  expect(empty).toContain("Welcome back!");
  expect(empty).toContain("Tips for getting started");
  expect(empty).toContain("/init");
  expect(active).not.toContain("Welcome back!");
  expect(active).toContain("flavor · anthropic:deepseek-v4-pro · flavor-code");
});

it("uses a compact welcome card without overflowing narrow terminals", () => {
  const output = stripAnsi(renderToString(<TerminalLayout
    model="model" workspaceName="workspace" completed={[]} input="" promptCursor={0}
    columns={48} rows={20} activeSession={false}
  />, { columns: 48 }));

  expect(output).toContain("Flavor Code");
  expect(output).not.toContain("Tips for getting started");
  expect(Math.max(...output.split("\n").map((line) => [...line].length))).toBeLessThanOrEqual(48);
});
```

Add the shown `stripAnsi` helper beside the test fixtures and do not change unrelated assertions.

- [ ] **Step 2: Run the renderer tests and verify red**

Run: `npm test -- tests/ui/app-render.test.tsx`

Expected: FAIL because no output contains `Welcome back!` or `Flavor Code`.

- [ ] **Step 3: Create the isolated welcome component**

Create `src/ui/welcome.tsx` with a wide breakpoint of 72 columns. The wide layout uses a warm yellow rounded border, a three-line Flavor wordmark, model/workspace metadata, durable setup tips, and valid interactive commands. The compact layout uses the same border and metadata without the wide-only tips block:

```tsx
import React from "react";
import { Box, Text } from "../claude-ink/index.js";

export interface WelcomeCardProps {
  model: string;
  workspaceName: string;
  columns: number;
}

const WIDE_WELCOME_COLUMNS = 72;

export function WelcomeCard({ model, workspaceName, columns }: WelcomeCardProps): React.JSX.Element {
  const wide = Math.max(1, Math.floor(columns)) >= WIDE_WELCOME_COLUMNS;
  return <Box width="100%" borderStyle="round" borderColor="yellow" paddingX={1}>
    {wide ? <Box width="100%" flexDirection="row">
      <Box width="36%" flexDirection="column" alignItems="center" borderStyle="single"
        borderTop={false} borderBottom={false} borderLeft={false} borderColor="yellow" paddingRight={1}>
        <Text bold color="yellowBright">Welcome back!</Text>
        <Text color="yellow">{"┌─┐┬  ┌─┐┬  ┬┌─┐┬─┐\n├┤ │  ├─┤└┐┌┘│ │├┬┘\n└  ┴─┘┴ ┴ └┘ └─┘┴└─"}</Text>
        <Text dimColor wrap="truncate-end">{model}</Text>
        <Text dimColor wrap="truncate-end">{workspaceName}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column" paddingLeft={1}>
        <Text bold color="yellowBright">Tips for getting started</Text>
        <Text>Run <Text color="cyan">/init</Text> to create or refresh FLAVOR.md</Text>
        <Text>Type <Text color="cyan">@</Text> to attach a project file</Text>
        <Box height={1} />
        <Text bold color="yellowBright">Quick commands</Text>
        <Text><Text color="cyan">/help</Text>{" · "}<Text color="cyan">/config</Text>{" · "}<Text color="cyan">/tasks</Text></Text>
      </Box>
    </Box> : <Box width="100%" flexDirection="column">
      <Text bold color="yellowBright">◆ Flavor Code</Text>
      <Text>Welcome back!</Text>
      <Text dimColor wrap="truncate-end">{model}{" · "}{workspaceName}</Text>
      <Text><Text color="cyan">/init</Text>{" setup · "}<Text color="cyan">/help</Text>{" commands"}</Text>
    </Box>}
  </Box>;
}
```

- [ ] **Step 4: Integrate the derived empty state**

Import `WelcomeCard` in `src/ui/app.tsx` and replace only the first header node in `TerminalLayout`:

```tsx
const showWelcome = completed.length === 0 && active === undefined;

// Inside the main ScrollBox:
{showWelcome
  ? <WelcomeCard model={model} workspaceName={workspaceName} columns={columns} />
  : <Text dimColor>{"flavor · "}{model}{" · "}{workspaceName}</Text>}
```

Keep the existing spacer, transcript mapping, active turn rendering, task panel, and prompt layout unchanged.

- [ ] **Step 5: Run focused renderer tests and type checking**

Run: `npm test -- tests/ui/app-render.test.tsx && npm run typecheck`

Expected: both commands exit 0; empty output contains the wide or compact card and active/completed output retains the compact conversation header.

- [ ] **Step 6: Commit only Task 1 files**

Stage `src/ui/welcome.tsx` normally. Because `src/ui/app.tsx` and `tests/ui/app-render.test.tsx` already contain user edits, stage only the newly added import, `showWelcome`/header replacement, helper, and welcome-card test hunks with patch staging. Verify the cached diff contains no task-panel or pasted-input changes before committing:

```bash
git add src/ui/welcome.tsx
git add -p src/ui/app.tsx tests/ui/app-render.test.tsx
git diff --cached -- src/ui/welcome.tsx src/ui/app.tsx tests/ui/app-render.test.tsx
git commit -m "feat(ui): add Flavor startup welcome card"
```

### Task 2: Interactive VS Code Terminal Identity

**Files:**
- Modify: `src/cli.tsx`
- Test: `tests/cli/terminal-title.test.ts`

**Interfaces:**
- Produces: `setInteractiveProcessTitle(target?: { title: string }): void`.
- Consumes: the interactive branch of `createProgram()` after TTY validation and before rendering.

- [ ] **Step 1: Write a failing unit test for the process-title helper**

Create `tests/cli/terminal-title.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { setInteractiveProcessTitle } from "../../src/cli.js";

describe("interactive terminal identity", () => {
  it("labels the foreground process as flavor", () => {
    const target = { title: "node" };
    setInteractiveProcessTitle(target);
    expect(target.title).toBe("flavor");
  });
});
```

- [ ] **Step 2: Run the new test and verify red**

Run: `npm test -- tests/cli/terminal-title.test.ts`

Expected: FAIL because `setInteractiveProcessTitle` is not exported.

- [ ] **Step 3: Implement and call the title helper**

Add the helper near the CLI dependency interfaces:

```ts
export function setInteractiveProcessTitle(target: { title: string } = process): void {
  target.title = "flavor";
}
```

In the root command action, call it only after the `!process.stdin.isTTY` early return and immediately before the dynamic UI imports:

```ts
setInteractiveProcessTitle();
const [{ render, AlternateScreen }, { createElement }, { App }] = await Promise.all([
  // existing imports
]);
```

Do not change the existing `useTerminalTitle("flavor")` call; the OSC title and process title are complementary.

- [ ] **Step 4: Run CLI tests and type checking**

Run: `npm test -- tests/cli/terminal-title.test.ts tests/cli/version.test.ts tests/cli/print.test.ts && npm run typecheck`

Expected: all tests pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 2 files**

```bash
git add src/cli.tsx tests/cli/terminal-title.test.ts
git commit -m "fix(cli): label interactive terminal as flavor"
```

### Task 3: Release Verification

**Files:**
- Modify only files required to fix regressions introduced by Tasks 1–2.

**Interfaces:**
- Consumes: the completed welcome card and terminal-title changes.
- Produces: verified package artifacts and evidence that the dirty workspace was preserved.

- [ ] **Step 1: Run the complete test suite**

Run: `npm test`

Expected: all Vitest suites pass.

- [ ] **Step 2: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0.

- [ ] **Step 3: Build the package**

Run: `npm run build`

Expected: exit code 0 and refreshed ignored `dist/` output.

- [ ] **Step 4: Run the install smoke test**

Run: `npm run smoke:install`

Expected: exit code 0 with working `flavor --version` and `flavor --help` checks.

- [ ] **Step 5: Audit the final diff and status**

Run: `git status --short --branch && git diff --check && git log -5 --oneline --decorate`

Expected: branch remains `main`; no whitespace errors exist; the user's original unrelated changes remain present and were not reverted.
