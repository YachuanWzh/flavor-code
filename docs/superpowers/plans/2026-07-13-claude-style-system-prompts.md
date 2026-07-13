# Claude-Style System Prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Flavor's inline prompt string with a capability-aware, environment-aware, role-specific Claude Code-style system prompt assembly system.

**Architecture:** A pure `buildSystemPrompt()` function will assemble ordered prompt sections from typed runtime facts. `ContextManager` will pin each section separately and may resolve a system-section factory so model and permission changes remain current. `LocalHarness` will tell context creation which tools each role actually receives, and `createProductionRuntime()` will supply Flavor's runtime facts.

**Tech Stack:** TypeScript 7, Node.js 20 APIs, Zod-backed tool definitions, Vitest 4.

## Global Constraints

- Preserve Flavor's identity and describe only implemented capabilities.
- Keep `FLAVOR.md`, task state, matched Skill, and compaction injection behavior unchanged.
- Do not add prompt overrides, custom agents, autonomous mode, MCP guidance, persistent memory, scratchpads, or new permission-classifier behavior.
- Preserve existing callers that pass one system string to `ContextManager`.
- Avoid overwriting the user's existing changes in `src/permissions/engine.ts` and `src/tools/search.ts`.

---

### Task 1: Pure prompt assembly

**Files:**
- Create: `src/prompts/system.ts`
- Create: `tests/prompts/system.test.ts`

**Interfaces:**
- Consumes: `PermissionMode` from `src/permissions/engine.ts`.
- Produces: `PromptAgentRole`, `PromptEnvironment`, `SystemPromptOptions`, and `buildSystemPrompt(options: SystemPromptOptions): string[]`.

- [ ] **Step 1: Write failing tests for ordered core sections and role-specific guidance**

Create tests that call `buildSystemPrompt()` with a fixed environment and assert that the result begins with the supplied language instruction, contains the identity/security/task/action/style/environment headings in order, gives the main agent collaborative completion guidance, and gives the subagent self-contained-task, absolute-path, no-delegation, and concise-handoff guidance.

```ts
const base = {
  languageInstruction: "Always reply in Simplified Chinese.",
  workspace: "C:\\repo",
  model: "openai:gpt-5",
  permissionMode: "workspace" as const,
  toolNames: new Set(["Read", "Shell"]),
  environment: {
    date: "2026-07-13",
    platform: "win32",
    osVersion: "Windows 11",
    shell: "powershell",
    isGitRepository: true,
  },
};

expect(buildSystemPrompt({ ...base, agent: "main" }).join("\n\n"))
  .toContain("You are Flavor");
expect(buildSystemPrompt({ ...base, agent: "subagent" }).join("\n\n"))
  .toContain("Do not delegate");
```

- [ ] **Step 2: Write failing tests for capability-aware tool guidance**

Assert that a prompt with `Read`, `Grep`, `Shell`, `AskUserQuestion`, `TodoWrite`, `TaskPlan`, `TaskUpdate`, `Task`, `TaskOutput`, and `SkillResource` describes each available capability, while a prompt with only `Read` does not mention unavailable tool names. Assert that subagent guidance does not claim access to main-only task tools when those names are absent.

- [ ] **Step 3: Run prompt tests and confirm the module is missing**

Run: `npm test -- tests/prompts/system.test.ts`

Expected: FAIL because `../../src/prompts/system.js` does not exist.

- [ ] **Step 4: Implement the typed prompt builder**

Implement a pure builder with this public shape:

```ts
export type PromptAgentRole = "main" | "subagent";

export interface PromptEnvironment {
  date: string;
  platform: NodeJS.Platform | string;
  osVersion: string;
  shell: string;
  isGitRepository: boolean | "unknown";
}

export interface SystemPromptOptions {
  agent: PromptAgentRole;
  languageInstruction?: string;
  workspace: string;
  model: string;
  permissionMode: PermissionMode;
  toolNames: ReadonlySet<string>;
  environment: PromptEnvironment;
}

export function buildSystemPrompt(options: SystemPromptOptions): string[];
```

Build named Markdown sections for identity, security and instruction boundaries, doing tasks, reversible actions, available-tool guidance, tone/output, role guidance, and environment. Add a tool rule only when `toolNames.has(name)` is true. Remove empty sections and keep a stable order. Treat environment values as bullet data and normalize embedded newlines to spaces.

- [ ] **Step 5: Run prompt tests**

Run: `npm test -- tests/prompts/system.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit the prompt builder**

```bash
git add src/prompts/system.ts tests/prompts/system.test.ts
git commit -m "feat(prompts): assemble Claude-style system guidance"
```

### Task 2: Ordered and refreshable pinned system sections

**Files:**
- Modify: `src/context/manager.ts`
- Modify: `tests/context/manager.test.ts`

**Interfaces:**
- Consumes: prompt section arrays from Task 1.
- Produces: exported `SystemPromptSource = string | readonly string[] | (() => string | readonly string[])`; `ContextManagerOptions.system: SystemPromptSource`.

- [ ] **Step 1: Write failing context tests**

Add one test passing `system: ["first", "second"]` and asserting that `messagesForModel()` starts with two distinct system messages in that order before `FLAVOR.md`. Add another test passing a factory backed by a mutable variable, mutate it, and assert the next `messagesForModel()` call reflects the new section without changing conversation messages.

```ts
let sections: readonly string[] = ["model one"];
const context = createContext({ system: () => sections });
expect(context.messagesForModel()[0]?.content).toBe("model one");
sections = ["model two"];
expect(context.messagesForModel()[0]?.content).toBe("model two");
```

- [ ] **Step 2: Run the focused context tests and verify failure**

Run: `npm test -- tests/context/manager.test.ts`

Expected: FAIL because `system` accepts and pins only a string.

- [ ] **Step 3: Implement `SystemPromptSource` resolution**

Store the source rather than one resolved string. In `#pinnedMessages()`, call a private resolver that invokes factories, converts a string to a one-element array, trims sections, and removes empty strings. Map every surviving section to its own `{ role: "system", content }` message before existing `FLAVOR.md` and task-state messages.

- [ ] **Step 4: Run context and compaction tests**

Run: `npm test -- tests/context/manager.test.ts tests/context/compaction.test.ts`

Expected: PASS, including existing assertions for the legacy string form.

- [ ] **Step 5: Commit context support**

```bash
git add src/context/manager.ts tests/context/manager.test.ts
git commit -m "feat(context): pin ordered system prompt sections"
```

### Task 3: Runtime and role capability wiring

**Files:**
- Modify: `src/harness/local.ts`
- Modify: `src/production.ts`
- Modify: `tests/agent/subagents.test.ts`
- Modify: `tests/cli/production.test.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt()` from Task 1 and `SystemPromptSource` from Task 2.
- Produces: `LocalHarnessOptions.createContext(agent, tools)` where `tools` is the exact `readonly ToolDefinition<unknown>[]` assigned to that role.

- [ ] **Step 1: Write a failing harness capability test**

Create a harness with a main-only tool named `Task`, capture the tool names passed to `createContext`, construct a child, and assert the main context receives `Task` while the child context does not. Reuse the existing `createContext()` test helper to return valid contexts.

- [ ] **Step 2: Run the harness test and verify failure**

Run: `npm test -- tests/agent/subagents.test.ts`

Expected: FAIL because `LocalHarnessOptions.createContext` currently receives only the agent role.

- [ ] **Step 3: Pass exact role tools into context creation**

Change the callback signature to:

```ts
createContext(
  agent: "main" | "subagent",
  tools: readonly ToolDefinition<unknown>[],
): ContextManager;
```

Pass all definitions for the main context. In `createSubagent()`, filter `MAIN_TASK_TOOL_NAMES` first and pass the filtered definitions to the subagent context factory.

- [ ] **Step 4: Add runtime prompt-fact helpers and integration assertions**

In `src/production.ts`, use Node's OS APIs and `execFileNoThrow("git", ["-C", workspace, "rev-parse", "--is-inside-work-tree"], { timeout: 2_000, useCwd: false })` once during startup. Build a stable `PromptEnvironment` with `new Date().toISOString().slice(0, 10)`, `process.platform`, OS version/release, `environment.ComSpec ?? environment.SHELL ?? "unknown"`, and Git result.

Replace the inline joined prompt with a factory:

```ts
system: () => buildSystemPrompt({
  agent,
  languageInstruction: languageInstruction(language),
  workspace,
  model: agent === "main" ? harness.mainModelId : harness.subagentModelId,
  permissionMode: agent === "subagent" ? "workspace" : harness.permissionMode,
  toolNames: new Set(agentTools.map((tool) => tool.name)),
  environment: promptEnvironment,
}),
```

Add a production test around an exported pure helper so date/platform/shell/Git fallbacks are deterministic without making a real provider request:

```ts
export interface PromptEnvironmentInput {
  now?: Date;
  platform?: string;
  osVersion?: string;
  shell?: string;
  isGitRepository?: boolean | "unknown";
}

export function createPromptEnvironment(
  input: PromptEnvironmentInput = {},
): PromptEnvironment;
```

The helper returns the ISO calendar date and substitutes `"unknown"` for blank platform, OS, and shell values. Production supplies the actual process and Git-probe values.

- [ ] **Step 5: Run focused runtime tests**

Run: `npm test -- tests/prompts/system.test.ts tests/context/manager.test.ts tests/agent/subagents.test.ts tests/cli/production.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit runtime wiring**

```bash
git add src/harness/local.ts src/production.ts tests/agent/subagents.test.ts tests/cli/production.test.ts
git commit -m "feat(runtime): wire role-aware system prompts"
```

### Task 4: Full verification and documentation alignment

**Files:**
- Modify: `README.md` only if prompt behavior is already documented inaccurately.

**Interfaces:**
- Consumes: completed Tasks 1-3.
- Produces: a verified build with no behavioral regression.

- [ ] **Step 1: Run type checking**

Run: `npm run typecheck`

Expected: exit code 0 with no TypeScript diagnostics.

- [ ] **Step 2: Run the complete test suite**

Run: `npm test`

Expected: all test files and tests pass.

- [ ] **Step 3: Build the package**

Run: `npm run build`

Expected: exit code 0 and generated CLI bundles in `dist/`.

- [ ] **Step 4: Inspect the final diff and prompt text**

Run: `git diff --check HEAD~3..HEAD` and `git status --short`.

Expected: no whitespace errors; only the user's pre-existing unrelated edits remain unstaged, if still present.

- [ ] **Step 5: Commit any necessary documentation correction**

If README behavior required correction, stage only `README.md` and commit it with `docs: describe role-aware system prompts`. Otherwise make no documentation commit.
