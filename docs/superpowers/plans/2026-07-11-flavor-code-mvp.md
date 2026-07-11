# flavor-code MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a globally installable Windows/macOS coding-agent CLI with official OpenAI and Anthropic providers, a complete local Harness, coding tools, Hooks, plugins, progressively loaded Skills, and non-recursive cost-tiered subagents.

**Architecture:** A thin Ink CLI owns terminal rendering while a provider-neutral `LocalHarness` owns the model/tool loop, context, permissions, Hooks, and task scheduling. Focused registries isolate providers, tools, plugins, and Skills; all model-produced structures cross Zod-validated boundaries. The main Agent owns planning and user interaction, while restricted subagent Harnesses run dependency-ready DAG nodes and return only `SubagentResult` objects.

**Tech Stack:** Node.js 20+, TypeScript ESM, React 19, Ink 7, Commander 15, OpenAI SDK 6, Anthropic SDK 0.111, Zod 4, dotenv 17, bundled ripgrep, Vitest 4, tsup 8.

## Global Constraints

- The installed executable is named `flavor` and the npm package is named `flavor-code`.
- Runtime support is Windows and macOS on Node.js 20 or newer.
- The global configuration path is `~/.flavor-code/flavor.json`; project configuration is `.flavor/flavor.json`.
- The MVP supports OpenAI, Anthropic, and OpenAI-compatible `baseURL` endpoints using official SDKs.
- Main and subagent models are configured independently; `maxSubagents` defaults to `3`.
- Subagents cannot spawn subagents, cannot leave the workspace, and return only schema-validated structured results.
- Permission modes are `safe`, `workspace`, and `full`; `workspace` is the default.
- Skill folders contain `SKILL.md` with YAML frontmatter containing only `name` and `description`.
- Search prefers bundled ripgrep and must provide a Node.js fallback.
- `/ide` and browser OAuth are extension interfaces only and are not user-visible MVP features.
- Production behavior is introduced test-first and every task ends with a green focused and full test run.

## File Map

```text
package.json                         Package metadata, `flavor` bin, scripts, dependencies
tsconfig.json                        Strict ESM compiler configuration
tsup.config.ts                       CLI build with executable banner
vitest.config.ts                     Unit/integration test configuration
src/cli.tsx                          Process entry and Commander setup
src/ui/app.tsx                       Ink session UI and interrupt behavior
src/ui/commands.ts                   Slash-command parsing and dispatch
src/config/schema.ts                 Zod configuration schema and public types
src/config/load.ts                   Layer discovery, merge, dotenv, interpolation, redaction
src/auth/types.ts                    API-key auth and future OAuth callback boundary
src/models/types.ts                  Provider-neutral streaming/tool-call contracts
src/models/registry.ts               Model id parsing and adapter lookup
src/models/openai.ts                 Official OpenAI/OpenAI-compatible adapter
src/models/anthropic.ts              Official Anthropic adapter
src/hooks/types.ts                   Hook event and decision schemas
src/hooks/bus.ts                     Ordered plugin/shell Hook execution
src/permissions/engine.ts            Tool/path/command policy decisions
src/tools/types.ts                   Tool contracts and normalized results
src/tools/runtime.ts                 Tool registration and guarded execution pipeline
src/tools/files.ts                   Read, Write, Edit, ApplyPatch
src/tools/search.ts                  Glob/Grep ripgrep path and Node fallback
src/tools/shell.ts                   Cross-platform child-process execution
src/context/manager.ts               MVP truncation and compaction strategy
src/agent/types.ts                   Agent request/result and task graph schemas
src/agent/loop.ts                    Provider-neutral model/tool loop
src/agent/planner.ts                 Simple/complex classification and DAG validation
src/agent/subagents.ts               Dependency scheduler and restricted child Harnesses
src/harness/local.ts                 Composition root and main/subagent capability profiles
src/init/project.ts                  Repository facts and `FLAVOR.md` generation
src/skills/registry.ts               Three-level Skill discovery and loading
src/plugins/types.ts                 Plugin manifest and registration API
src/plugins/host.ts                  Global/project/npm discovery and isolation
src/session/store.ts                 Atomic session persistence and recovery
tests/**                             Mirrored unit and integration tests
scripts/smoke-install.mjs            Packed global-install smoke test
.github/workflows/ci.yml             Windows/macOS build, test, and package matrix
```

---

### Task 1: Package Skeleton and Executable CLI

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tsup.config.ts`
- Create: `vitest.config.ts`
- Create: `src/cli.tsx`
- Test: `tests/cli/version.test.ts`

**Interfaces:**
- Produces: exported `createProgram(): Command` and built `dist/cli.js` mapped to the `flavor` bin.

- [ ] **Step 1: Write the failing executable test**

```ts
// tests/cli/version.test.ts
import { describe, expect, it } from "vitest";
import { createProgram } from "../../src/cli.js";

describe("flavor CLI", () => {
  it("uses the public command name and package version", () => {
    const program = createProgram();
    expect(program.name()).toBe("flavor");
    expect(program.version()).toMatch(/^0\.1\.0$/);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/cli/version.test.ts`
Expected: FAIL because `package.json` and `src/cli.tsx` do not exist.

- [ ] **Step 3: Add the package and compiler configuration**

```json
{
  "name": "flavor-code",
  "version": "0.1.0",
  "description": "A multi-provider coding agent for your terminal",
  "type": "module",
  "bin": { "flavor": "dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "prepack": "npm run build"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.111.0",
    "@vscode/ripgrep": "^1.18.0",
    "commander": "^15.0.0",
    "dotenv": "^17.4.2",
    "ink": "^7.1.0",
    "openai": "^6.46.0",
    "react": "^19.2.7",
    "zod": "^4.4.3"
  },
  "devDependencies": {
    "@types/node": "^26.1.1",
    "@types/react": "^19.2.17",
    "tsup": "^8.5.1",
    "typescript": "^7.0.2",
    "vitest": "^4.1.10"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "jsx": "react-jsx",
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "tests", "tsup.config.ts", "vitest.config.ts"]
}
```

```ts
// tsup.config.ts
import { defineConfig } from "tsup";
export default defineConfig({ entry: ["src/cli.tsx"], format: ["esm"], clean: true, sourcemap: true, banner: { js: "#!/usr/bin/env node" } });
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", restoreMocks: true } });
```

- [ ] **Step 4: Implement the minimal CLI factory**

```tsx
// src/cli.tsx
import { Command } from "commander";

export function createProgram(): Command {
  return new Command().name("flavor").description("Interactive coding agent").version("0.1.0");
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  await createProgram().parseAsync(process.argv);
}
```

- [ ] **Step 5: Install, verify GREEN, typecheck, and build**

Run: `npm install`
Expected: dependencies install and `package-lock.json` is created.

Run: `npm test -- tests/cli/version.test.ts && npm run typecheck && npm run build`
Expected: PASS and `dist/cli.js` starts with a Node shebang.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts src/cli.tsx tests/cli/version.test.ts
git commit -m "feat: scaffold flavor CLI"
```

### Task 2: Layered Configuration and Secret Handling

**Files:**
- Create: `src/config/schema.ts`
- Create: `src/config/load.ts`
- Create: `src/auth/types.ts`
- Test: `tests/config/load.test.ts`

**Interfaces:**
- Produces: `FlavorConfig`, `loadConfig({ cwd, home, cli }): Promise<LoadedConfig>`, and `redactConfig(config): unknown`.
- Produces: `AuthProvider.resolve(provider): Promise<AuthResult>` with API-key and future OAuth callback contracts.

- [ ] **Step 1: Write failing precedence and interpolation tests**

```ts
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadConfig, redactConfig } from "../../src/config/load.js";

it("merges CLI, project, env, global, and defaults in precedence order", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-config-"));
  const home = join(root, "home");
  const cwd = join(root, "repo");
  await mkdir(join(home, ".flavor-code"), { recursive: true });
  await mkdir(join(cwd, ".flavor"), { recursive: true });
  await writeFile(join(home, ".flavor-code", "flavor.json"), JSON.stringify({ maxSubagents: 2 }));
  await writeFile(join(cwd, ".flavor", "flavor.json"), JSON.stringify({ maxSubagents: 4, permissionMode: "safe" }));
  await writeFile(join(cwd, ".env"), "OPENAI_API_KEY=project-secret\n");
  const loaded = await loadConfig({ cwd, home, cli: { maxSubagents: 5 } });
  expect(loaded.config.maxSubagents).toBe(5);
  expect(loaded.config.permissionMode).toBe("safe");
});

it("interpolates and redacts provider secrets", async () => {
  process.env.FLAVOR_TEST_KEY = "secret-value";
  const redacted = redactConfig({ providers: { custom: { type: "openai", apiKey: "${FLAVOR_TEST_KEY}" } } });
  expect(JSON.stringify(redacted)).not.toContain("secret-value");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/config/load.test.ts`
Expected: FAIL because the configuration modules do not exist.

- [ ] **Step 3: Implement schemas and deterministic merge**

```ts
// src/config/schema.ts
import { z } from "zod";
export const ProviderConfigSchema = z.object({ type: z.string(), baseURL: z.string().url().optional(), apiKey: z.string().optional() });
export const FlavorConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  agents: z.object({ main: z.object({ model: z.string() }), subagent: z.object({ model: z.string() }) }).optional(),
  maxSubagents: z.number().int().min(1).max(16).default(3),
  permissionMode: z.enum(["safe", "workspace", "full"]).default("workspace"),
  context: z.object({ compactAtChars: z.number().int().positive().default(240_000), toolOutputChars: z.number().int().positive().default(30_000) }).default({})
});
export type FlavorConfig = z.infer<typeof FlavorConfigSchema>;
```

Implement `load.ts` with `readJsonIfPresent`, `parse` from `dotenv`, recursive object merge, `${NAME}` interpolation after all sources load, `FlavorConfigSchema.parse`, and source-path collection. Redaction must replace fields named `apiKey`, `authorization`, or `token` with `"[redacted]"` without mutating input.

Define the authentication extension boundary without enabling browser login:

```ts
// src/auth/types.ts
export interface AuthResult { headers: Record<string, string>; expiresAt?: string }
export interface AuthProvider {
  readonly type: "api-key" | "oauth-callback";
  resolve(providerId: string, signal?: AbortSignal): Promise<AuthResult>;
}
export interface OAuthCallbackOptions {
  authorizationUrl: URL;
  callbackHost: "127.0.0.1";
  callbackPort: number;
  state: string;
  codeVerifier: string;
}
```

The MVP `ApiKeyAuthProvider` resolves the already-interpolated provider key into the adapter constructor. No route, browser launch, token exchange, or credential-store behavior is registered.

- [ ] **Step 4: Run GREEN and validation**

Run: `npm test -- tests/config/load.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config src/auth tests/config
git commit -m "feat: load layered flavor configuration"
```

### Task 3: Provider-Neutral Models and Official SDK Adapters

**Files:**
- Create: `src/models/types.ts`
- Create: `src/models/registry.ts`
- Create: `src/models/openai.ts`
- Create: `src/models/anthropic.ts`
- Test: `tests/models/registry.test.ts`
- Test: `tests/models/adapters.test.ts`

**Interfaces:**
- Produces: `ModelAdapter.stream(request): AsyncIterable<ModelEvent>`, `ModelRegistry.register/get`, and `parseModelId("provider:model")`.

- [ ] **Step 1: Write failing registry and event-normalization tests**

```ts
import { expect, it } from "vitest";
import { ModelRegistry, parseModelId } from "../../src/models/registry.js";

it("resolves provider-prefixed model ids", () => {
  expect(parseModelId("openai:gpt-example")).toEqual({ provider: "openai", model: "gpt-example" });
  expect(() => parseModelId("missing-prefix")).toThrow(/provider:model/);
  const adapter = { stream: async function* () { yield { type: "done" as const, usage: { inputTokens: 1, outputTokens: 1 } }; } };
  const registry = new ModelRegistry().register("openai", adapter);
  expect(registry.get("openai:gpt-example").model).toBe("gpt-example");
});
```

Adapter tests inject fake SDK clients and assert that OpenAI response deltas and Anthropic content-block deltas become `text`, `tool-call`, `usage`, `error`, and `done` events without making network requests.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/models`
Expected: FAIL because model contracts and adapters do not exist.

- [ ] **Step 3: Define the stable model contract**

```ts
export interface ModelMessage { role: "system" | "user" | "assistant" | "tool"; content: string; toolCallId?: string }
export interface ModelTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ModelRequest { model: string; messages: ModelMessage[]; tools: ModelTool[]; signal?: AbortSignal }
export type ModelEvent =
  | { type: "text"; text: string }
  | { type: "tool-call"; id: string; name: string; input: unknown }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; usage: { inputTokens: number; outputTokens: number } };
export interface ModelAdapter { stream(request: ModelRequest): AsyncIterable<ModelEvent> }
```

- [ ] **Step 4: Implement registry and adapters**

`OpenAIModelAdapter` accepts `{ apiKey, baseURL, client? }`, calls the official Responses streaming API, and translates SDK events into the stable contract. `AnthropicModelAdapter` accepts `{ apiKey, baseURL, client? }`, calls `messages.stream`, accumulates JSON tool input fragments per block, and emits the same contract. Both convert SDK errors through a shared `normalizeProviderError` with `authentication`, `rate_limit`, `context_overflow`, `model_not_found`, `network`, `cancelled`, and `unknown` codes.

- [ ] **Step 5: Run GREEN**

Run: `npm test -- tests/models && npm run typecheck`
Expected: PASS with no network access.

- [ ] **Step 6: Commit**

```bash
git add src/models tests/models
git commit -m "feat: add OpenAI and Anthropic model adapters"
```

### Task 4: Hook Bus and Permission Engine

**Files:**
- Create: `src/hooks/types.ts`
- Create: `src/hooks/bus.ts`
- Create: `src/permissions/engine.ts`
- Test: `tests/hooks/bus.test.ts`
- Test: `tests/permissions/engine.test.ts`

**Interfaces:**
- Produces: `HookBus.emit(event): Promise<HookDecision[]>` and `PermissionEngine.decide(request): PermissionDecision`.

- [ ] **Step 1: Write failing behavior tests**

```ts
it("runs hook handlers in registration order and stops on deny", async () => {
  const calls: string[] = [];
  const bus = new HookBus();
  bus.on("PreToolUse", async () => { calls.push("first"); return { decision: "allow" }; });
  bus.on("PreToolUse", async () => { calls.push("second"); return { decision: "deny", reason: "policy" }; });
  bus.on("PreToolUse", async () => { calls.push("third"); return { decision: "allow" }; });
  expect(await bus.emit({ version: 1, type: "PreToolUse", payload: {} })).toMatchObject({ decision: "deny" });
  expect(calls).toEqual(["first", "second"]);
});

it("never permits a subagent write outside the workspace", () => {
  const engine = new PermissionEngine({ workspace: "/repo", mode: "full" });
  expect(engine.decide({ agent: "subagent", tool: "Write", paths: ["/outside/file"] }).decision).toBe("deny");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/hooks tests/permissions`
Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement Hook schemas and ordered dispatch**

Use Zod discriminated unions for all approved event names and `HookDecision`. `HookBus` stores plugin functions and shell handler descriptors, applies per-handler timeouts with `AbortSignal.timeout`, validates modified input, short-circuits on `deny`, and propagates `ask` to the caller.

- [ ] **Step 4: Implement normalized permission decisions**

Resolve every path against the real workspace root, reject traversal and symlink escape, classify shell executables and arguments, and implement the exact `safe`, `workspace`, and `full` matrix. `agent: "subagent"` adds a non-overridable workspace boundary and turns all user approval into `ask` for relay by the main Agent.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/hooks tests/permissions && npm run typecheck`
Expected: PASS.

```bash
git add src/hooks src/permissions tests/hooks tests/permissions
git commit -m "feat: add hooks and permission policies"
```

### Task 5: Guarded Tool Runtime and File Tools

**Files:**
- Create: `src/tools/types.ts`
- Create: `src/tools/runtime.ts`
- Create: `src/tools/files.ts`
- Test: `tests/tools/runtime.test.ts`
- Test: `tests/tools/files.test.ts`

**Interfaces:**
- Produces: `ToolDefinition`, `ToolRuntime.execute(call, context)`, and factories for `Read`, `Write`, `Edit`, `ApplyPatch`.

- [ ] **Step 1: Write failing pipeline and file-safety tests**

Tests assert the order `PreToolUse -> permission -> execute -> PostToolUse`, denial without execution, unique-match Edit failure, binary Read rejection, atomic Write, and ApplyPatch rejection for paths outside the workspace.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/tools/runtime.test.ts tests/tools/files.test.ts`
Expected: FAIL because tool runtime and file tools do not exist.

- [ ] **Step 3: Define and implement the runtime**

```ts
export interface ToolDefinition<T> {
  name: string;
  description: string;
  inputSchema: z.ZodType<T>;
  paths(input: T): string[];
  execute(input: T, signal: AbortSignal): Promise<unknown>;
}
export interface ToolResult { ok: boolean; output?: unknown; error?: { code: string; message: string } }
```

`ToolRuntime` validates input, emits Hooks, asks `PermissionEngine`, calls an injected approval callback only for the main Agent, catches failures into `ToolResult`, and emits success or failure Hooks. The file tools use normalized absolute paths and temporary-file rename for atomic replacement.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- tests/tools/runtime.test.ts tests/tools/files.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/tools tests/tools
git commit -m "feat: add guarded file tools"
```

### Task 6: Cross-Platform Search and Shell Tools

**Files:**
- Create: `src/tools/search.ts`
- Create: `src/tools/shell.ts`
- Test: `tests/tools/search.test.ts`
- Test: `tests/tools/shell.test.ts`

**Interfaces:**
- Produces: `createGlobTool`, `createGrepTool`, `createShellTool`, and shared truncation metadata.

- [ ] **Step 1: Write failing parity and process tests**

Create a temporary tree with ignored files and assert ripgrep and forced-Node modes return identical normalized matches. Shell tests assert argument-array handling with spaces, working directory, timeout, cancellation, exit code, and head/tail output truncation.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/tools/search.test.ts tests/tools/shell.test.ts`
Expected: FAIL because the search and shell modules do not exist.

- [ ] **Step 3: Implement search backends**

Resolve the bundled executable from `@vscode/ripgrep`, invoke it with `spawn(executable, args, { shell: false })`, parse null-delimited results, and normalize path separators to `/`. The fallback walks with `fs.opendir`, skips ignored directories, applies minimatch-compatible internal glob matching, and runs JavaScript regexes with the same result limit and context schema.

- [ ] **Step 4: Implement the shell tool**

Accept `{ command: string, args: string[], cwd?: string, timeoutMs?: number }`; never accept a concatenated command line for execution. Spawn with `shell: false`, merge cancellation and timeout signals, collect bounded stdout/stderr, and return `{ exitCode, signal, stdout, stderr, truncated }`.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/tools/search.test.ts tests/tools/shell.test.ts && npm run typecheck`
Expected: PASS on the current platform.

```bash
git add src/tools/search.ts src/tools/shell.ts tests/tools/search.test.ts tests/tools/shell.test.ts
git commit -m "feat: add cross-platform search and shell tools"
```

### Task 7: MVP Context Manager and Agent Loop

**Files:**
- Create: `src/context/manager.ts`
- Create: `src/agent/types.ts`
- Create: `src/agent/loop.ts`
- Test: `tests/context/manager.test.ts`
- Test: `tests/agent/loop.test.ts`

**Interfaces:**
- Produces: `ContextManager.messagesForModel()`, `ContextManager.compact()`, and `AgentLoop.run(request): AsyncIterable<AgentEvent>`.

- [ ] **Step 1: Write failing context retention tests**

Assert that tool output is truncated to head/tail with original length metadata, system/`FLAVOR.md`/task state survive compaction, recent turns survive, and a provided summarizer replaces older messages after `compactAtChars`.

- [ ] **Step 2: Write failing loop tests**

Use a fake adapter that emits text, then a tool call, then final text. Assert the loop executes the tool once, feeds its result back, emits streaming text, records usage, stops on completion, and stops with a typed error at the iteration limit.

- [ ] **Step 3: Run RED**

Run: `npm test -- tests/context tests/agent/loop.test.ts`
Expected: FAIL because context and loop modules do not exist.

- [ ] **Step 4: Implement minimal context strategy**

Use `Math.ceil(text.length / 4)` as the documented token estimate. Store pinned and recent messages separately, truncate tool results at the configured limit, and invoke an injected `summarize(messages)` function between `PreCompact` and `PostCompact`.

- [ ] **Step 5: Implement the model-tool loop**

For each iteration, request the configured model with context and tools, accumulate streamed text and tool calls, execute validated calls through `ToolRuntime`, append assistant and tool messages, compact when needed, and continue. Yield `text`, `tool-start`, `tool-end`, `usage`, `compacted`, `done`, and `error` events.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm test -- tests/context tests/agent/loop.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/context src/agent/types.ts src/agent/loop.ts tests/context tests/agent/loop.test.ts
git commit -m "feat: add context management and agent loop"
```

### Task 8: Task Planning and Restricted Subagent Scheduler

**Files:**
- Create: `src/agent/planner.ts`
- Create: `src/agent/subagents.ts`
- Create: `src/harness/local.ts`
- Test: `tests/agent/planner.test.ts`
- Test: `tests/agent/subagents.test.ts`

**Interfaces:**
- Produces: `TaskGraphSchema`, `SubagentResultSchema`, `TaskPlanner.plan`, `SubagentScheduler.run`, and `LocalHarness.createSubagent(task)`.

- [ ] **Step 1: Write failing DAG and recursion tests**

Tests reject duplicate ids, missing dependencies, and cycles. A four-node graph with two ready nodes must observe at most the configured concurrency and start dependent nodes only after prerequisites. A subagent Harness must omit the `Task` tool even if the parent has it.

- [ ] **Step 2: Write failing structured-result tests**

Validate the exact `SubagentResult` fields from the design. Reject prose-only output and retry schema repair once; after a second invalid result, mark the node failed. Assert only the parsed result is passed to the main context.

- [ ] **Step 3: Run RED**

Run: `npm test -- tests/agent/planner.test.ts tests/agent/subagents.test.ts`
Expected: FAIL because planning and scheduling modules do not exist.

- [ ] **Step 4: Implement validated planning and scheduling**

Use Zod for nodes `{ id, description, dependencies, expectedOutputs, verification }`. Detect cycles with Kahn's algorithm. Maintain `pending`, `running`, `completed`, `failed`, and `blocked` states; start ready nodes up to `maxSubagents`; propagate failure only to descendants; preserve sibling results.

- [ ] **Step 5: Compose restricted Harness profiles**

`LocalHarness` creates `main` and `subagent` profiles from the same registries but gives children a new context, subagent model id, workspace-forced permissions, no approval callback, and a tool registry filtered to remove `Task`. Emit `BeforePlan`, `AfterPlan`, `SubagentStart`, and `SubagentStop`.

- [ ] **Step 6: Run GREEN and commit**

Run: `npm test -- tests/agent/planner.test.ts tests/agent/subagents.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/agent/planner.ts src/agent/subagents.ts src/harness tests/agent
git commit -m "feat: add cost-tiered subagent scheduling"
```

### Task 9: Project Initialization and FLAVOR.md

**Files:**
- Create: `src/init/project.ts`
- Test: `tests/init/project.test.ts`

**Interfaces:**
- Produces: `inspectProject(cwd): Promise<ProjectFacts>` and `initializeFlavor(cwd): Promise<InitResult>`.

- [ ] **Step 1: Write failing repository-inspection tests**

Build temporary npm and Python repositories. Assert detection of language, package manager, scripts, test/lint commands, source directories, existing instruction files, and `.gitignore`. Assert generated `FLAVOR.md` is concise, deterministic, contains verified commands only, and never includes `.env` values.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/init/project.test.ts`
Expected: FAIL because project initialization does not exist.

- [ ] **Step 3: Implement bounded inspection and generation**

Inspect known manifests and configuration names before sampling source layout through `Glob`; never recursively ingest the repository. Generate sections for overview, layout, build, test, quality, conventions, and cautions. Merge an existing generated file by replacing only content between flavor-code marker comments. Add `.flavor/sessions/` to `.gitignore` without duplicating entries.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- tests/init/project.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/init tests/init
git commit -m "feat: generate project FLAVOR instructions"
```

### Task 10: Progressive Skill Registry

**Files:**
- Create: `src/skills/registry.ts`
- Test: `tests/skills/registry.test.ts`

**Interfaces:**
- Produces: `SkillRegistry.discover`, `SkillRegistry.match`, `SkillRegistry.loadBody`, and resource resolution restricted to the skill root.

- [ ] **Step 1: Write failing disclosure tests**

Create global and project skill trees. Assert discovery reads only frontmatter, project definitions override global names, invalid names/frontmatter are isolated, body text loads only after match, and a `../` resource reference is rejected.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/skills/registry.test.ts`
Expected: FAIL because the registry does not exist.

- [ ] **Step 3: Implement strict frontmatter and three-level loading**

Parse the opening YAML document without loading the remaining body into the Agent context. Require exactly `name` and `description`, a matching lowercase hyphenated folder, and no duplicate project names. Match using deterministic name/description term scoring plus an optional model selector. Load body and directly referenced one-level resources only when requested.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- tests/skills/registry.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/skills tests/skills
git commit -m "feat: add progressive skill loading"
```

### Task 11: Plugin Manifest and Isolated Host

**Files:**
- Create: `src/plugins/types.ts`
- Create: `src/plugins/host.ts`
- Test: `tests/plugins/host.test.ts`

**Interfaces:**
- Produces: `PluginManifestSchema`, `PluginContext`, and `PluginHost.loadAll`.

- [ ] **Step 1: Write failing discovery and isolation tests**

Create project/global plugins with `flavor-plugin.json`. Assert project override, disabled-plugin handling, API version rejection, declared contribution registration, npm resolution through an injected resolver, and continuation when one plugin throws during activation.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/plugins/host.test.ts`
Expected: FAIL because the plugin host does not exist.

- [ ] **Step 3: Implement manifest and restricted registration context**

The manifest requires `{ name, version, apiVersion: "1", main, permissions, contributes }`. Resolve local entries inside their plugin root, dynamically import them, and call `activate(context)`. Expose only `registerCommand`, `registerTool`, `registerHook`, `registerSkillRoot`, `registerModelAdapter`, scoped logging, and permission-mediated filesystem access.

- [ ] **Step 4: Run GREEN and commit**

Run: `npm test -- tests/plugins/host.test.ts && npm run typecheck`
Expected: PASS.

```bash
git add src/plugins tests/plugins
git commit -m "feat: add plugin discovery and registration"
```

### Task 12: Interactive UI and Slash Commands

**Files:**
- Create: `src/ui/app.tsx`
- Create: `src/ui/commands.ts`
- Modify: `src/cli.tsx`
- Test: `tests/ui/commands.test.ts`
- Test: `tests/cli/session.test.ts`

**Interfaces:**
- Consumes: `LocalHarness`, configuration loader, registries, initializer, and session store interface.
- Produces: interactive `flavor` default action and all MVP slash commands.

- [ ] **Step 1: Write failing command parser tests**

Assert `/model main openai:gpt-example`, `/model subagent anthropic:claude-example`, `/permissions safe`, `/compact`, `/init`, `/tasks`, `/skills`, `/plugins`, `/hooks`, `/config`, `/clear`, `/help`, and `/exit`. Unknown commands must return suggestions without reaching the Harness.

- [ ] **Step 2: Write failing process-session tests**

Spawn the source CLI with an injected fake Harness and text renderer. Assert `SessionStart`, prompt submission, streamed output, first `SIGINT` cancellation, second `SIGINT` exit, and `SessionEnd`. Assert `/config` output redacts secrets.

- [ ] **Step 3: Run RED**

Run: `npm test -- tests/ui tests/cli/session.test.ts`
Expected: FAIL because the interactive app does not exist.

- [ ] **Step 4: Implement command dispatch and Ink renderer**

Keep parsing pure: `parseSlashCommand(input): SlashCommand | null`. Dispatch commands through an injected service object. Render prompt history, streaming assistant text, tool status, task status, approval prompts, usage, and errors. Do not render hidden chain-of-thought. Add a `--print` non-interactive mode for tests and scripts.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- tests/ui tests/cli && npm run typecheck && npm run build`
Expected: PASS.

```bash
git add src/ui src/cli.tsx tests/ui tests/cli
git commit -m "feat: add interactive flavor session"
```

### Task 13: Session Recovery, Packaging, and Cross-Platform CI

**Files:**
- Create: `src/session/store.ts`
- Create: `scripts/smoke-install.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `README.md`
- Create: `LICENSE`
- Create: `.gitignore`
- Test: `tests/session/store.test.ts`
- Modify: `src/harness/local.ts`
- Modify: `src/ui/app.tsx`

**Interfaces:**
- Produces: `SessionStore.save/load/list`, atomic recovery integration, packed installation smoke test, and CI matrix.

- [ ] **Step 1: Write failing atomic recovery tests**

Assert save uses a temporary file and rename, corrupt sessions are quarantined without crashing, secrets are absent, main messages/task graph/subagent results restore, and abandoned running tasks restore as pending or failed according to dependencies.

- [ ] **Step 2: Run RED**

Run: `npm test -- tests/session/store.test.ts`
Expected: FAIL because session persistence does not exist.

- [ ] **Step 3: Implement persistence and wire lifecycle saves**

Store versioned JSON under `.flavor/sessions/<session-id>.json`. Persist only normalized messages, config model ids, task state, structured results, timestamps, and workspace identity. Save after user input, tool completion, task-state changes, compaction, and graceful exit.

- [ ] **Step 4: Add install smoke script and CI**

`scripts/smoke-install.mjs` must run `npm pack --json`, install the produced tarball into a temporary npm prefix, locate `flavor`/`flavor.cmd`, and assert `flavor --version` prints `0.1.0`. The GitHub Actions matrix uses `windows-latest` and `macos-latest`, Node 20 and current LTS, then runs `npm ci`, tests, typecheck, build, and the smoke script.

- [ ] **Step 5: Add user documentation and ignore rules**

Document installation, global and project configuration, `.env`, model ids, permission modes, commands, Hooks, plugins, Skills, subagent behavior, security limitations, and the deferred OAuth/IDE roadmap. Ignore `node_modules/`, `dist/`, `.env`, `.flavor/sessions/`, coverage, and packed tarballs.

- [ ] **Step 6: Run full verification**

Run: `npm test`
Expected: every test passes without API credentials.

Run: `npm run typecheck && npm run build && node scripts/smoke-install.mjs`
Expected: clean typecheck/build and an isolated globally installed `flavor --version` prints `0.1.0`.

- [ ] **Step 7: Commit**

```bash
git add src/session src/harness/local.ts src/ui/app.tsx scripts .github README.md LICENSE .gitignore tests/session
git commit -m "feat: ship recoverable cross-platform MVP"
```

## Final Verification

- [ ] Run `npm test` and confirm all suites pass with no API credentials.
- [ ] Run `npm run typecheck` and confirm zero TypeScript errors.
- [ ] Run `npm run build` and inspect the executable banner in `dist/cli.js`.
- [ ] Run `node scripts/smoke-install.mjs` and invoke the isolated `flavor` binary.
- [ ] Configure a fake OpenAI-compatible local endpoint and verify provider/model selection without exposing its key.
- [ ] Run a scripted multi-node task and confirm concurrency never exceeds `maxSubagents` and child tool lists omit `Task`.
- [ ] Confirm `git status --short` contains no `.env`, session, build, coverage, or package artifacts.
