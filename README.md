<p align="center"><b><a href="./README.md">English</a></b> | <a href="./README.zh-CN.md">简体中文</a></p>

<div align="center">
  <img src="./assets/icon-transparent-512.png" alt="Flavor Code Logo" width="168" />
  <h1>Flavor Code</h1>
  <p><strong>Local-first, auditable, resumable AI coding assistant</strong></p>
  <p>Read code, edit files, run commands, and complete complex tasks in the terminal, Electron desktop, and VS Code.</p>

  <p>
    <a href="https://www.npmjs.com/package/flavor-code"><img alt="npm version" src="https://img.shields.io/npm/v/flavor-code?color=cb3837&logo=npm" /></a>
    <a href="https://github.com/YachuanWzh/flavor-code/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YachuanWzh/flavor-code/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" />
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  </p>

  <p>
    <a href="#quick-start">Quick Start</a> ·
    <a href="#features">Features</a> ·
    <a href="#entry-points">Entry Points</a> ·
    <a href="#permissions--sandbox">Security</a> ·
    <a href="#development">Development</a> ·
    <a href="./CHANGELOG.md">Changelog</a>
  </p>
</div>

---

Flavor Code connects to OpenAI, Anthropic, or compatible services and works with file, search, Shell, MCP, and custom tools inside a controlled workspace. Complex tasks can be broken into plans and parallel sub-tasks; sessions, diffs, tool calls, checkpoints, and audit records are all stored locally so you can resume, review, and continue at any time.

## Features

| | Capability | What you get |
| --- | --- | --- |
| 🖥️ | **One runtime, three entry points** | CLI, Electron, and VS Code share model configuration, sessions, and tooling |
| 🧭 | **Controlled progress on complex tasks** | Task plans, sub-agents, steering, follow-ups, `/loop`, and `/goal` |
| ⏪ | **Traceable, resumable results** | Full timeline, checkpoints, rewind, traces, diffs, and failure audits |
| 🧠 | **Local long-term context** | Memory, Skills, plugins, and project guides stored on your machine |
| 🎨 | **D2C design-to-code** | Import Pixso exports; the agent generates Vue/React implementations with automatic pixel-level visual evaluation (Electron only) |
| 🛡️ | **Clear permission boundaries** | Independent control over read, write, Shell, network, and destructive actions; Docker supported |

## 1.2.10 D2C Acceptance & Delivery

1.2.10 hardens the D2C acceptance loop: failed authentication prerequisites block protected scenarios immediately, request recording survives navigation, repair prompts accept extra instructions, and the backend process restarts automatically when its source changes.

| Feature | How to use |
| --- | --- |
| **Auth-prerequisite fail-fast** | When a login / sign-in scenario (e.g. `POST /api/v1/auth/login`) fails during interactive acceptance, later protected scenarios are reported as blocked by that failed prerequisite instead of being executed one by one, so the root cause is visible immediately. |
| **Navigation-safe request recording** | Request recording now persists across in-app navigation through `sessionStorage` (up to 500 entries). Requests fired after a click that navigates to another page are captured too, so post-navigation behavior can still be asserted. |
| **Extra repair instructions** | Before repairing failed interaction scenarios, type extra requirements in the “补充修复要求” box; they are injected into the repair prompt as user-supplied constraints together with the failure details. |
| **Acceptance as a separate stage** | The D2C workbench now splits “API Integration” and “Acceptance & Delivery” into two explicit stages; after an automated repair run finishes, the workbench switches to the acceptance tab automatically. |
| **Backend source fingerprinting** | The mock/server backend is fingerprinted when it starts. If its source files change, the runtime detects the fingerprint difference and restarts the backend before acceptance, so tests always run against the code currently on disk. |

## 1.2.9 Runtime Productivity

1.2.9 adds layered project instructions, safe writes, background jobs, persistent terminals, and native web tools. Usually you can just describe the goal in natural language and the agent picks the right tool; when you need precise control, name the tool and its parameters explicitly in the prompt.

| Feature | How to use |
| --- | --- |
| **Layered project instructions** | Put `AGENTS.md` / `CLAUDE.md` in the project root or subdirectories; use `AGENTS.local.md` / `CLAUDE.local.md` for local additions in the same directory. Root rules load at startup; subdirectory rules load automatically when the agent touches files there. |
| **Per-turn change summary** | No configuration needed. After a successful `Write`, `Edit`, or `ApplyPatch`, the turn shows a color-coded `CHANGESET` receipt with workspace-relative paths, `CREATE` / `UPDATE` / `DELETE` operations, per-file line counts, and a total. At most 8 files are shown, with an explicit shown/total footer when more changed. |
| **File version protection** | No configuration needed. If the IDE, a formatter, or another process modifies a file after the agent read it, the next write fails with `Stale file`; ask the agent to re-read before editing. |
| **Standard tool presentation protocol** | Tool authors can declare `outputSchema`, `renderForModel`, `presentCall`, and `presentResult`, so the same result can use an appropriate form in the model context, CLI, and desktop. The CLI visually separates file diffs, web evidence, job receipts, foreground `COMMAND` output, and persistent `TERMINAL` output from the final answer. |
| **Background Shell / Jobs** | Say "start the dev server in the background" and the agent calls `Shell` with `background: true`. Use `JobList` to view jobs, `JobRead` for incremental output, `JobWait` to wait, and `JobKill` to stop. The CLI shows a color-bordered `JOB` receipt separating job metadata, logs, and the final answer; logs show at most the latest 12 lines and lists at most 8 items. Windows prefers UTF-8 and falls back automatically on GBK/GB18030 system diagnostics. |
| **Foreground command results** | Foreground `Shell` calls render as state-colored `COMMAND` receipts with separate command, stdout, stderr, and exit regions. Long output keeps the first and last 8 lines and explicitly folds the middle; persistent PTY output uses the distinct `TERMINAL` label. |
| **Desktop background status** | Electron automatically shows the number of running jobs in the session title bar, updated live on start, output, exit, or cancel. |
| **Persistent PTY** | Say "open a persistent terminal and keep interacting". The agent uses `TerminalOpen` to create a terminal, `TerminalWrite` for input, `TerminalRead` for incremental output, and `TerminalClose` to close it. |
| **Unified D2C/E2E process lifecycle** | No usage change. Preview and backend services still start/stop from the E2E/D2C workbench, but the underlying layer unifies output limits, process-tree termination, and idempotent cleanup. |
| **Native WebSearch** | Say "search the web for ...", or explicitly ask for `WebSearch`. It uses keyless DuckDuckGo Lite by default and degrades to Bing on connection failure, HTTP rejection, or no parseable results; up to 20 results per call. The CLI puts the top 5 into a bordered `WEB SEARCH` evidence block with titles and compact sources in search order. |
| **Native WebFetch** | Say "read this page: `https://...`", or explicitly ask for `WebFetch`. Supports HTTP(S), redirects, HTML-to-text, timeouts, and response size limits, and is compatible with Clash/TUN Fake-IP DNS. Direct access to Fake-IP, intranet, or cloud metadata addresses is still blocked; network operations still follow Flavor permission approval. |

Common precise usage:

```text
Start npm run dev with Shell in background mode, then use JobRead to inspect the startup logs.
Open a persistent terminal, run a Python REPL in it, execute two snippets, then close the terminal.
Use WebSearch to find the official TypeScript 7 migration notes, then WebFetch the most relevant official page.
This directory has its own conventions; follow src/payments/AGENTS.md before modifying code here.
```

See [Technical Design Report §38](./技术方案报告.md#38-129-运行时生产力与原生-web-能力) for tool parameters, state machines, security boundaries, and extension interfaces; acceptance criteria are in the [Runtime productivity spec](./docs/specs/2026-08-13-runtime-productivity-waves.md).

## Quick Start

> [!IMPORTANT]
> The CLI requires Node.js 20 or later. Windows desktop builds can also be downloaded directly from [Releases](https://github.com/YachuanWzh/flavor-code/releases).

**1. Install**

```bash
npm install -g flavor-code
```

**2. Start in your project**

```bash
cd your-project
flavor
```

**3. Initialize project context**

Run `/init` the first time you enter a project. Flavor analyzes the language, package manager, source directories, and verification commands, then generates a `FLAVOR.md` project guide.

You can also run one-off tasks directly:

```bash
flavor --print "Analyze this project and list the top three issues worth fixing"
flavor --resume
flavor --resume -p "Continue the remaining work"
```

Non-interactive mode refuses actions that require human approval and never hangs waiting for input.

## Configuring Models

The fastest way is to set environment variables:

```bash
# macOS / Linux
export OPENAI_API_KEY="sk-..."

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-..."
```

You can also put the key in a `.env` file at the project root.

<details>
<summary><strong>Configure multiple providers with <code>.flavor/flavor.json</code></strong></summary>

Example project configuration:

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "apiKey": "${OPENAI_API_KEY}",
      "defaultModel": "gpt-5",
      "cheapModel": "gpt-5-mini"
    }
  },
  "agents": {
    "main": { "model": "openai:gpt-5" },
    "subagent": { "model": "openai:gpt-5-mini" }
  },
  "permissionMode": "default",
  "maxSubagents": 3,
  "language": "zh-CN"
}
```

Configuration is merged in the following order, with later sources taking precedence:

1. Global `~/.flavor-code/flavor.json`
2. Project `.flavor/flavor.json`
3. `.env`
4. Process environment variables

Commonly supported provider types:

- `openai`: OpenAI's official API
- `anthropic`: Anthropic's official API
- `openai-compatible`: Services compatible with the OpenAI protocol

</details>

Runtime behavior and configuration conventions for OAuth PKCE are described in the [PKCE spec](./docs/specs/pkce-runtime-config.md). The [config schema](./src/config/schema.ts) is the source of truth for all fields.

## Entry Points

| Entry point | Best for | How to start |
| --- | --- | --- |
| **CLI** | Daily development, remote environments, scripting, and CI | `flavor` |
| **Electron** | Visual sessions, diffs, permissions, and resource management | `npm run desktop:start` |
| **VS Code / Qoder** | Editor context, diagnostic fixes, and a task control plane | `npm run ide:install` |

### CLI

Run `flavor` and type natural language. Typing `/` shows built-in commands, plugin commands, and Skills.

Common commands:

| Command | Purpose |
| --- | --- |
| `/init` | Generate or update `FLAVOR.md` |
| `/model` | View or switch main/sub-agent models |
| `/permissions` | Switch permission modes |
| `/tasks` | View task plans and sub-agent status |
| `/compact` | Manually compact long session context |
| `/checkpoint`, `/tree` | Save state, view the session tree |
| `/rewind`, `/unrevert`, `/fork` | Resume or fork sessions |
| `/memory`, `/remember`, `/forget`, `/forget-cold` | Manage long-term memory; `/forget-cold` purges cold entries and their files |
| `/mcp` | View and manage MCP servers |
| `/loop <goal>` | Run an autonomous loop with verification |
| `/goal <objective>` | Run the plan, execute, adversarial-review workflow |
| `/audit` | View tool failure audits |

You can submit steering or queue follow-ups while a run is in progress; once the current model response finishes, the task picks up new instructions at safe boundaries.

### Electron Desktop

```bash
npm run desktop:dev      # dev mode
npm run desktop:start    # build and start
npm run desktop:pack     # Windows portable directory
npm run desktop:dist     # Windows NSIS installer
```

The desktop app provides project and session switching, streaming Markdown, tool and diff views, permission confirmations, task status, and management of Skills, MCP, memory, and models.

The **D2C** module in the sidebar supports a complete design-to-code loop: import a Pixso-exported HTML directory, choose a target framework (Vue 3 / React), and submit the generation task to the current session. The agent implements it under `src/d2c-output/<task>/` following the `d2c-pixso` skill (SOP); a Vite dev server then starts automatically for pixel-level comparison, producing a visual-fidelity score and a structured diff report (region offsets, color deviations, font differences). The results workbench offers overlay, curtain, flicker, and heatmap comparison modes, an SVG annotation layer, and a severity-sorted issue list, so each diff can be accepted or rejected individually and trigger module-level fixes. Once visual review passes, you can import a Swagger/OpenAPI document to auto-generate Axios wrappers and an Express mock server, moving into API integration and interactive acceptance.

### VS Code / Qoder

```bash
npm run vscode:install   # install into VS Code
npm run qoder:install    # install into Qoder
npm run ide:install      # auto-select the installed IDE
```

The extension includes the `@flavor` Chat Participant, Mission Control, Changes & Health, Time Machine, diagnostic fixes, CodeLens, checkpoints, and rewind. If `flavor` is not on your `PATH`, set `flavorCode.executable`.

## MCP, Skills & Plugins

Flavor can connect to stdio or Streamable HTTP MCP servers. Example project configuration:

<details>
<summary><strong>MCP configuration and CLI examples</strong></summary>

```json
{
  "mcpServers": {
    "docs": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_TOKEN}"
      }
    }
  }
}
```

MCP configuration can also be managed from the CLI:

```bash
flavor mcp list
flavor mcp add docs --url https://example.com/mcp
flavor mcp disable docs
```

</details>

A Skill is a `SKILL.md` with YAML frontmatter, placed in `.flavor/skills/<name>/` or `~/.flavor-code/skills/<name>/`. Flavor loads skills progressively based on the task, and you can invoke one explicitly with `/<skill-name>`.

Plugins live in `.flavor/plugins/` and can register commands, tools, hooks, Skill roots, and model adapters.

> [!WARNING]
> Plugins and agent self-registered tools are in-process JavaScript, not a security sandbox. Only install, enable, and approve code you trust.

## Sessions, Memory & Execution Records

Project runtime data lives under `.flavor/`:

```text
.flavor/
├── flavor.json       # Project config
├── sessions/         # Session timelines
├── session-assets/   # Image attachments
├── session-trees/    # Session branches
├── checkpoints/      # Workspace snapshots
├── memory/           # Long-term memory
├── traces/           # Optional execution traces
├── audit.jsonl       # Tool failure audits
├── skills/           # Project skills
└── plugins/          # Project plugins
```

Long-term memory distinguishes user preferences, behavioral feedback, project conventions, and external references. Automatic extraction only keeps high-confidence candidates and provides confirm, ignore, and delete actions; secrets, tokens, raw tool output, and model guesses are rejected.

Image prompts support PNG, JPEG, and WebP, with a 5 MiB per-image maximum and up to 5 images per prompt. The desktop app supports picking or drag-and-drop; CLI clipboard images currently work on Windows and macOS.

## Permissions & Sandbox

| Mode | Behavior |
| --- | --- |
| `default` | Reads are auto-approved; writes, Shell, network, and destructive actions are confirmed on demand |
| `acceptEdits` | Workspace writes and routine verification are auto-approved |
| `plan` | Read-only planning; no modifications or execution |
| `bypassPermissions` | The main agent executes as much as possible after hard safety checks |
| `auto` | A classifier decides, falling back to human approval when uncertain |
| `bubble` | Uncertain operations bubble up to the main session for approval |

> [!CAUTION]
> Local Shell still runs as your current user. Consider enabling Docker when working with untrusted projects.

<details>
<summary><strong>Docker execution environment example</strong></summary>

```json
{
  "execution": {
    "mode": "docker",
    "image": "node:24-bookworm-slim",
    "network": false,
    "memory": "2g",
    "cpus": 2
  }
}
```

If Docker is unavailable, tasks fail rather than silently falling back to the host. Sensitive fields in config files and OAuth tokens are encrypted at rest with AES-256-GCM using a local configuration key.

</details>

## SDK, RPC & Evaluation

<details>
<summary><strong>Node.js SDK example</strong></summary>

```ts
import { createFlavorRuntime } from "flavor-code/sdk";

const runtime = await createFlavorRuntime({
  workspace: process.cwd(),
  approvalPolicy: "deny",
  output: console.log,
});

await runtime.session.start();
await runtime.session.submit("fix the failing tests");
await runtime.dispose();
```

</details>

Other IDEs or languages can integrate over JSONL RPC:

```bash
flavor --mode rpc --workspace . --trace .flavor/traces/run.jsonl
```

Run evaluations:

```bash
flavor eval eval.json --output report.json
```

Design constraints for RPC, traces, replay, eval, session trees, and Docker are in the [control-plane spec](./docs/specs/2026-07-29-control-plane-sandbox-vscode.md).

## Development

```bash
npm ci
npm test
npm run typecheck
npm run vscode:typecheck
npm run build
npm run smoke:install
```

- TypeScript strict, targeting ES2022, Node.js 20+
- Vitest for unit and integration tests
- tsup builds the CLI, SDK, Electron main process, and VS Code extension
- Vite builds the Electron renderer
- CI covers Windows/macOS with Node 20/24

Release builds do not generate or package source maps by default. For a local debugging build, enable them explicitly:

```bash
# macOS / Linux
FLAVOR_SOURCEMAP=1 npm run build

# Windows PowerShell
$env:FLAVOR_SOURCEMAP = "1"
npm run build
```

## Documentation

- [Technical Design Report](./技术方案报告.md): overall architecture, agent loop, context, permissions, plugins, and security model
- [Runtime reliability spec](./docs/specs/2026-07-26-runtime-reliability.md)
- [Control plane, sandbox & VS Code spec](./docs/specs/2026-07-29-control-plane-sandbox-vscode.md)
- [Multimodal image attachments spec](./docs/specs/2026-07-30-multimodal-image-attachments.md)
- [D2C design-to-code spec](./docs/specs/2026-08-09-d2c-design-to-code.md)
- [D2C review & integration spec](./docs/specs/2026-08-10-d2c-review-and-integration.md)
- [1.2.9 runtime productivity spec](./docs/specs/2026-08-13-runtime-productivity-waves.md)
- [VS Code next steps](./docs/specs/2026-08-01-flavor-code-vscode-next.md)

## Security Notes

- Review model-generated code and commands, especially dependency installs, scripts, and deletions.
- Do not treat `.flavor/sessions/`, traces, or long-term memory as secret stores.
- Use least-privilege API keys and never commit `.env`.
- Skill content can influence model behavior; plugins and self-registered tools also have in-process Node.js permissions.
- Work under version control and create checkpoints before high-risk tasks.

## Contributing

Issues and Pull Requests are welcome. Please at least run the following before submitting:

```bash
npm test
npm run typecheck
npm run vscode:typecheck
npm run build
```

For architecture changes, read the [Technical Design Report](./技术方案报告.md) and the relevant [design specs](./docs/specs/) first.

## License

[MIT](./LICENSE)

<p align="center">
  Made with 🌶️ by Flavor Code contributors.
</p>
