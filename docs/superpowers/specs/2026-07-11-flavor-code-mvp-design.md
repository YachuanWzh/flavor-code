# flavor-code MVP Design

## 1. Purpose

`flavor-code` is a TypeScript coding-agent CLI installed with `npm i -g flavor-code` and launched with `flavor` on Windows and macOS. Its interaction model follows Claude Code: a persistent streaming terminal session, slash commands, lifecycle hooks, project instructions, coding tools, permissions, plugins, skills, and task delegation.

The MVP must be useful for real repository work while preserving clear extension points. It supports multiple model providers, separates a capable main-agent model from a lower-cost subagent model, and keeps the main context clean by returning only structured subagent results.

## 2. MVP Scope

The MVP includes:

- A cross-platform interactive CLI and global npm package.
- OpenAI, Anthropic, and OpenAI-compatible endpoints through official SDKs.
- Global, project, environment, and command-line configuration.
- A complete local Harness containing model calls, the agent loop, context management, tools, permissions, hooks, and subagent scheduling.
- Basic coding tools: read, glob, grep, write, edit, patch, shell, and read-only Git helpers.
- A main-agent planning flow and a dependency-aware subagent scheduler.
- Plugins that contribute commands, tools, hooks, skills, and model adapters.
- Skills compatible with the `SKILL.md` progressive-disclosure convention.
- `/model`, `/init`, `/config`, `/permissions`, `/skills`, `/plugins`, `/hooks`, `/tasks`, `/compact`, `/clear`, `/help`, and `/exit`.
- MVP context compaction, session recovery, and cross-platform packaging tests.

The MVP excludes deep IDE integration, OAuth browser authorization, remote or container Harnesses, plugin process isolation, advanced memory and retrieval, MCP, a plugin marketplace, and automatic updates.

## 3. Architecture

The CLI creates one `LocalHarness` for the current workspace. The Harness is the public execution boundary but delegates to focused internal components:

```text
CLI / Slash Commands
        |
        v
LocalHarness
|- AgentLoop
|- ModelRegistry
|  |- OpenAIModelAdapter
|  `- AnthropicModelAdapter
|- ContextManager
|- ToolRuntime
|- PermissionEngine
|- HookBus
|- SkillRegistry
|- PluginHost
|- TaskPlanner
`- SubagentScheduler
```

`ModelAdapter` normalizes provider streaming, tool calls, usage, cancellation, and failures. The initial adapters use the official `openai` and `@anthropic-ai/sdk` packages. The OpenAI adapter also accepts a configurable `baseURL` for compatible services. Plugins may register additional adapters without changing the Harness.

`AgentLoop` owns the model-tool-result cycle, iteration limits, cancellation, and completion. It is independent of the terminal renderer so it can be tested with fake models and tools.

`ContextManager` owns the model-visible message set and compaction. `ToolRuntime` executes registered tools only after `PermissionEngine` and `HookBus` approve the call. `TaskPlanner` validates a model-produced task graph, while `SubagentScheduler` runs ready nodes under a concurrency limit.

## 4. Configuration

The global configuration file is:

- Windows: `%USERPROFILE%\.flavor-code\flavor.json`
- macOS: `~/.flavor-code/flavor.json`

Effective configuration is merged in this order, with earlier entries taking precedence:

1. CLI overrides for the current invocation.
2. Project `.flavor/flavor.json`.
3. Project `.env` values.
4. Global `~/.flavor-code/flavor.json`.
5. Built-in defaults.

Provider keys may be written directly for the MVP or referenced with `${ENVIRONMENT_VARIABLE}`. Configuration inspection always redacts secrets. The default configuration shape is:

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}"
    },
    "anthropic": {
      "type": "anthropic",
      "apiKey": "${ANTHROPIC_API_KEY}"
    }
  },
  "agents": {
    "main": { "model": "openai:gpt-model" },
    "subagent": { "model": "anthropic:claude-model" }
  },
  "maxSubagents": 3,
  "permissionMode": "workspace"
}
```

The configuration schema also supports timeouts, iteration limits, context thresholds, enabled plugins and skills, hook handlers, tool output limits, and session settings. Invalid configuration reports the exact source file and JSON path.

Authentication is abstracted behind an `AuthProvider`. The MVP implements API-key resolution. A future `OAuthCallbackAuthProvider` will support a local callback server, browser launch, random `state`, PKCE, callback validation, and token storage without requiring changes to model adapters or the Harness.

## 5. CLI and Slash Commands

The npm `bin` entry maps `flavor` to a Node ESM executable. The command uses platform-neutral path APIs and argument-array process spawning, never Bash-specific command construction. It checks Node.js 20 or newer, resolves the workspace, loads configuration, discovers extensions, and starts a streaming terminal session.

The MVP commands are:

- `/model`: inspect or independently switch the main and subagent provider/model.
- `/init`: inspect the repository and create or update `FLAVOR.md`.
- `/config`: show configuration sources and the redacted effective configuration.
- `/permissions`: inspect or switch `safe`, `workspace`, and `full` mode.
- `/skills`, `/plugins`, `/hooks`: show discovered components and health.
- `/tasks`: show task dependencies and subagent status.
- `/compact`: manually compact context.
- `/clear`: start a clean conversation while retaining project instructions.
- `/help`: show commands and shortcuts.
- `/exit`: close the session cleanly.

`/init` detects project languages, package managers, build and test commands, source layout, linting and formatting configuration, existing agent instructions, and high-level conventions. It produces concise `FLAVOR.md` guidance and does not copy secrets, generated output, dependencies, or large source files.

`/ide` is reserved for a later release. The core may define an unused `IdeBridge` interface, but the MVP does not register the command or ship a VS Code extension.

## 6. Planning and Subagents

The main Agent receives the user request, project instructions, matching skills, tool descriptions, and current task state. It classifies trivial work for direct execution and complex work for planning. A complex plan is a validated directed acyclic graph whose nodes contain a bounded task, dependencies, expected outputs, and verification criteria.

The scheduler runs only dependency-ready nodes and caps concurrent subagents at `maxSubagents`, which defaults to three. Independent nodes may run in parallel. A failed node does not erase sibling results; dependent nodes become `blocked` while unrelated nodes may continue.

Each subagent:

- Uses the configured subagent model, independent from the main model.
- Receives only its task, necessary project instructions, selected skill content, relevant file context, and allowed tools.
- Has a separate message history and context budget.
- Uses a restricted Harness bound to the workspace.
- Cannot access the task-delegation tool and therefore cannot create subagents.
- Cannot ask the user directly; approval requests are relayed through the main Agent.
- Returns a schema-validated result and releases its conversation afterward.

```ts
interface SubagentResult {
  taskId: string;
  status: "completed" | "failed" | "blocked";
  summary: string;
  filesChanged: string[];
  commandsRun: Array<{
    command: string;
    exitCode: number | null;
    summary: string;
  }>;
  verification: Array<{
    name: string;
    passed: boolean;
    details: string;
  }>;
  artifacts: string[];
  risks: string[];
  suggestedNextSteps: string[];
}
```

Only this result is inserted into the main context. The main Agent checks results, resolves overlapping edits or failed verification, performs any required integration work, and reports a combined outcome.

## 7. Context Management

The MVP deliberately uses a replaceable, simple `ContextStrategy`:

- Estimate tokens from character counts rather than provider-specific tokenizers.
- Retain system instructions, `FLAVOR.md`, the active task graph, and recent turns.
- Truncate large tool output to configured head and tail sections plus result counts.
- Compact older messages into a structured summary with the current main model after a configurable threshold.
- Emit `PreCompact` and `PostCompact` around compaction.
- Store only `SubagentResult` in the main context after subagent completion.
- Save recoverable session data under `.flavor/sessions/`, which `/init` adds to `.gitignore`.

Vector retrieval, hierarchical memory, intelligent file selection, provider tokenizers, and custom compaction algorithms are deferred. The `ContextStrategy` interface allows these to replace the MVP behavior later.

## 8. Coding Tools and Search

The built-in tool set is:

- `Read`: line-based text reads with binary detection and size limits.
- `Glob`: file discovery with ignore handling and result limits.
- `Grep`: regular expressions, globs, file types, context lines, and result limits.
- `Write`: create or replace a file.
- `Edit`: exact replacement that fails unless the old text matches uniquely.
- `ApplyPatch`: apply a workspace-limited unified diff.
- `Shell`: spawn a process with argument arrays, timeout, cancellation, working directory, and output limits.
- `Git`: common read-only status, diff, and log operations.
- `Task`: main-Agent-only submission of validated task graphs.

`Glob` and `Grep` prefer a bundled ripgrep binary and respect ignore files. If the binary is unavailable or incompatible, they fall back to a pure Node.js implementation. Both implementations return the same schema. The fallback ensures Windows and macOS global installations remain usable.

## 9. Permissions

The three modes are:

- `safe`: reads run automatically; writes, shell commands, and network operations ask first.
- `workspace`: workspace reads, writes, and routine build or test commands run automatically; external writes, risky commands, and network operations ask first. This is the default.
- `full`: operations run automatically except explicitly forbidden high-risk actions.

Permission decisions consider tool identity, normalized paths, parsed executable and arguments, Agent identity, plugin permissions, and current mode. Symlink and path traversal checks prevent escaping the workspace. Subagents are always workspace-bound even when the main Agent uses `full`.

## 10. Hooks

The Hook bus emits versioned JSON for:

- Session: `SessionStart`, `UserPromptSubmit`, `Stop`, `SessionEnd`.
- Agent: `BeforePlan`, `AfterPlan`, `SubagentStart`, `SubagentStop`.
- Model: `BeforeModelCall`, `AfterModelCall`.
- Tools: `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PostToolUseFailure`.
- Context: `PreCompact`, `PostCompact`.
- Plugins: `PluginLoad`, `PluginUnload`.
- Notification: `Notification`.

Handlers may be configured shell processes or plugin functions. Shell handlers receive JSON on standard input. Every handler has a timeout and configured failure policy. Blocking handlers return:

```ts
interface HookDecision {
  decision: "allow" | "deny" | "ask";
  reason?: string;
  updatedInput?: unknown;
  additionalContext?: string;
}
```

Hooks can deny work, request approval, modify event input, or add context. Modified values are schema-validated before use.

## 11. Plugins

Plugins may be discovered from:

- Project `.flavor/plugins/<plugin-name>/`.
- User `~/.flavor-code/plugins/<plugin-name>/`.
- Installed npm packages named in configuration.

Each plugin has a `flavor-plugin.json` manifest with its name, version, module entry, API compatibility, requested permissions, and contributions. Contributions may include slash commands, tools, hooks, skills, and model adapters.

The MVP loads plugins in process. The `PluginContext` exposes only registration APIs, logging, redacted configuration, and permission-mediated services; it does not expose mutable Harness internals. One plugin failure disables that plugin and records a diagnostic without terminating the session. Project configuration may disable or override global plugins.

Process isolation, signatures, trust stores, a marketplace, and automatic installation are future work.

## 12. Skills

Each skill is a lowercase, hyphenated folder containing a required `SKILL.md`:

```text
skill-name/
|- SKILL.md
|- scripts/
|- references/
`- assets/
```

`SKILL.md` contains YAML frontmatter with only `name` and `description`, followed by Markdown instructions. Loading has three levels:

1. Startup loads only folder identity plus `name` and `description` metadata.
2. A matching request loads the full `SKILL.md` body.
3. Referenced scripts, references, and assets are accessed only when the active task needs them.

Project skills override global skills with the same name. Skill scripts are never implicitly trusted; execution goes through normal tools, Hooks, and permissions. Parsing failures disable the individual skill and produce a diagnostic.

## 13. Failure Handling

Provider errors normalize to authentication, rate limit, context overflow, missing model, network, cancellation, and unknown categories. Only rate-limit and temporary network failures receive bounded exponential-backoff retries.

Tool failures become structured tool results so the Agent can recover. Hook and plugin failures follow their isolation policy. Invalid model-produced task graphs or subagent results are rejected with a validation message and may be retried within a strict limit.

The first `Ctrl+C` cancels the active operation; a second exits. Logs redact API keys, authorization headers, and resolved secret fields.

## 14. Testing and Packaging

The project uses Node.js 20+, TypeScript ESM, `commander`, `ink`, `zod`, `dotenv`, `vitest`, and `tsup`.

Tests use fake model adapters by default and never spend API credits. Unit coverage targets model normalization, the Agent loop, context compaction, task validation, scheduling, permissions, hooks, extension loading, and the no-recursive-subagent rule. Temporary-directory integration tests cover file tools, ripgrep fallback parity, plugin discovery, and skill disclosure. Child-process tests cover CLI startup, slash commands, cancellation, and exit.

CI runs on Windows and macOS. Packaging verification runs `npm pack`, installs the tarball in an isolated prefix, and invokes `flavor --version` and a non-network smoke command. Optional provider smoke tests run only when explicitly enabled and supplied with credentials.

## 15. Delivery Stages

### Stage 1: CLI and Configuration

Produce an installable `flavor` command, terminal session, layered `flavor.json` and `.env` loading, provider configuration, and `/model` switching.

### Stage 2: Single-Agent Harness

Produce the provider adapters, Agent loop, core coding tools, permission engine, Hook bus, `/init`, and `FLAVOR.md` generation.

### Stage 3: Multi-Agent Execution

Produce complex-task planning, validated DAGs, configurable concurrency, role-specific models, restricted subagents, structured results, and failure propagation.

### Stage 4: Extensibility and Durability

Produce plugins, progressive skills, MVP compaction, session recovery, packaging validation, and Windows/macOS CI.

Each stage must be independently testable and leave a working CLI. Implementation follows test-driven development: introduce a failing behavioral test, observe the expected failure, add the minimal implementation, and rerun the relevant and full suites.

## 16. Future Roadmap

- `/ide`, a VS Code extension, and a bidirectional `IdeBridge` for selections, diagnostics, open buffers, and navigation.
- Browser-based OAuth using PKCE and a validated callback to a temporary local flavor-code server.
- Secure OS credential storage.
- Docker and remote Harness implementations.
- Out-of-process plugin isolation, signatures, trust policy, and marketplace distribution.
- Advanced context retrieval, layered memory, provider-aware token counting, and user-defined compaction strategies.
- MCP, remote plugin catalogs, and updates.

## 17. Acceptance Criteria

The MVP is accepted when a user on Windows or macOS can globally install the packed package, run `flavor` in a repository, configure either official provider or an OpenAI-compatible endpoint, generate `FLAVOR.md`, ask the Agent to inspect and modify code using permission-mediated tools, observe lifecycle Hooks, switch main and subagent models, execute a multi-node task with no more than the configured number of non-recursive subagents, load a local plugin and skill, recover a saved session, and complete the automated test and packaging suite without real API credentials.
