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
    <a href="#development">Development</a>
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
| 🛡️ | **Clear permission boundaries** | Independent control over read, write, Shell, network, and destructive actions; Docker supported |

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
