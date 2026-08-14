<p align="center"><a href="./README.md">English</a> | <b><a href="./README.zh-CN.md">简体中文</a></b></p>

<div align="center">
  <img src="./assets/icon-transparent-512.png" alt="Flavor Code Logo" width="168" />
  <h1>Flavor Code</h1>
  <p><strong>本地优先、可审计、可恢复的 AI 编程助手</strong></p>
  <p>在终端、Electron 桌面端和 VS Code 中读代码、改文件、运行命令并完成复杂任务。</p>

  <p>
    <a href="https://www.npmjs.com/package/flavor-code"><img alt="npm version" src="https://img.shields.io/npm/v/flavor-code?color=cb3837&logo=npm" /></a>
    <a href="https://github.com/YachuanWzh/flavor-code/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/YachuanWzh/flavor-code/actions/workflows/ci.yml/badge.svg?branch=main" /></a>
    <img alt="Node.js 20+" src="https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white" />
    <a href="./LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue.svg" /></a>
  </p>

  <p>
    <a href="#快速开始">快速开始</a> ·
    <a href="#核心能力">核心能力</a> ·
    <a href="#使用入口">使用入口</a> ·
    <a href="#权限与沙箱">安全</a> ·
    <a href="#开发">参与开发</a> ·
    <a href="./CHANGELOG.md">更新日志</a>
  </p>
</div>

---

Flavor Code 接入 OpenAI、Anthropic 或兼容服务，在受控工作区内使用文件、搜索、Shell、MCP 和自定义工具。复杂任务可以拆成计划和并行子任务；会话、Diff、工具调用、checkpoint 与审计记录全部保存在本地，便于恢复、复查和继续工作。

## 核心能力

| | 能力 | 你得到什么 |
| --- | --- | --- |
| 🖥️ | **一个运行时，三个入口** | CLI、Electron 与 VS Code 共享模型配置、会话和工具能力 |
| 🧭 | **复杂任务可控推进** | 任务计划、子 Agent、steering、follow-up、`/loop` 和 `/goal` |
| ⏪ | **结果可追溯、可恢复** | 完整时间线、checkpoint、rewind、trace、Diff 和失败审计 |
| 🧠 | **本地长期上下文** | 记忆、Skill、插件和项目指南均保存在本机 |
| 🎨 | **D2C 设计转代码** | 导入 Pixso 导出结果，由 Agent 生成 Vue/React 实现并自动进行像素级视觉评估（仅 Electron） |
| 🛡️ | **明确的权限边界** | 分别控制读、写、Shell、网络和破坏性操作，也可使用 Docker |

## 1.2.10 D2C 验收与交付

1.2.10 强化 D2C 验收闭环：认证前置失败快速阻断、请求记录跨导航保留、修复提示支持补充要求，后端源码变化时自动重启。

| 功能 | 使用方式 |
| --- | --- |
| **认证前置失败快速阻断** | 交互验收中，登录/认证类场景（如 `POST /api/v1/auth/login`）失败后，后续受保护场景不再逐个执行，直接标记为被该失败前置场景阻断，根因一目了然。 |
| **跨导航请求记录** | 请求记录通过 `sessionStorage` 在页面导航之间保留（最多 500 条），点击跳转等导航之后的请求同样会被捕获，可继续参与断言。 |
| **修复补充要求** | 修复失败的交互场景前，可在“补充修复要求”输入框填写额外约束，它们会与失败详情一起作为“用户补充要求”注入修复提示词。 |
| **验收与交付独立阶段** | D2C 工作台将“接口联调”与“验收与交付”拆分为两个明确阶段；自动修复完成后自动切换到验收页签。 |
| **后端源码指纹检测** | 启动时为 mock/server 后端源码计算指纹；源码文件变化后，运行时检测到指纹差异会自动重启后端，确保验收针对磁盘上的最新代码。 |

## 1.2.9 运行时生产力

1.2.9 新增分层项目指令、安全写入、后台任务、持久终端和原生 Web 工具。通常只需用自然语言描述目标，Agent 会选择合适的工具；需要精确控制时，也可以在提示词中明确指定工具和参数。

| 功能 | 使用方式 |
| --- | --- |
| **分层项目指令** | 在项目根目录或子目录放置 `AGENTS.md` / `CLAUDE.md`；同目录需要本地补充时使用 `AGENTS.local.md` / `CLAUDE.local.md`。根规则启动时加载，子目录规则在 Agent 访问该目录文件时自动加载。 |
| **每轮成果物汇总** | 无需配置。`Write`、`Edit` 或 `ApplyPatch` 成功后，回合结束会显示带语义色的 `CHANGESET` 收据，使用工作区相对路径列出 `CREATE` / `UPDATE` / `DELETE` 操作、各文件行数和总计。最多展示 8 个文件，超出时明确显示已展示数与总数。 |
| **文件版本保护** | 无需配置。如果 IDE、格式化器或其他进程在 Agent 读取后修改了文件，后续写入会报 `Stale file`；让 Agent 重新读取后再修改即可。 |
| **标准工具展示协议** | 工具作者可声明 `outputSchema`、`renderForModel`、`presentCall` 和 `presentResult`，让同一结果在模型上下文、CLI 与桌面端分别使用合适的形式。CLI 会把文件 Diff、Web 证据、Job 运行收据、前台 `COMMAND` 和持久 `TERMINAL` 与最终回答明确分开。 |
| **后台 Shell / Job** | 提示“在后台启动开发服务器”，Agent 会调用 `Shell` 并设置 `background: true`。使用 `JobList` 查看任务、`JobRead` 增量读取输出、`JobWait` 等待结束、`JobKill` 停止任务。CLI 使用带状态色边界的 `JOB` 收据区分任务元数据、日志与最终回答；日志最多显示最近 12 行，列表最多显示 8 项。Windows 优先使用 UTF-8，遇到 GBK/GB18030 系统诊断时自动回退。 |
| **前台命令结果** | 前台 `Shell` 显示为带状态色的 `COMMAND` 收据，分别展示命令、stdout、stderr 和退出状态。长输出保留开头 8 行与结尾 8 行，并明确折叠中间部分；持久 PTY 使用独立的 `TERMINAL` 标签。 |
| **桌面后台状态** | Electron 会在会话标题栏自动显示运行中的 Job 数量，并在任务启动、输出、退出或取消时实时更新。 |
| **持久 PTY** | 提示“打开一个持久终端并继续交互”。Agent 使用 `TerminalOpen` 创建终端、`TerminalWrite` 输入、`TerminalRead` 增量读取输出，并用 `TerminalClose` 关闭。 |
| **D2C/E2E 统一进程生命周期** | 使用方式不变。预览和后端服务仍从 E2E/D2C 工作台启动或停止，底层统一处理输出限制、进程树终止和幂等清理。 |
| **原生 WebSearch** | 提示“搜索 Web 上的……”，或明确要求使用 `WebSearch`。默认使用无需密钥的 DuckDuckGo Lite；连接失败、HTTP 拒绝或没有可解析结果时自动降级到 Bing。单次最多返回 20 条；CLI 将前 5 条放入带边界的 `WEB SEARCH` 证据块，按搜索排名显示标题和紧凑来源。 |
| **原生 WebFetch** | 提示“读取这个网页：`https://...`”，或明确要求使用 `WebFetch`。支持 HTTP(S)、重定向、HTML 转文本、超时和响应大小限制，并兼容 Clash/TUN Fake-IP DNS。直接访问 Fake-IP、内网或云元数据地址仍会被拦截；网络操作继续遵守 Flavor 权限审批。 |

常见的精确用法：

```text
使用 Shell 后台模式启动 npm run dev，然后通过 JobRead 检查启动日志。
打开持久终端，在其中运行 Python REPL，连续执行两段代码后关闭终端。
使用 WebSearch 搜索 TypeScript 7 官方迁移说明，再用 WebFetch 读取最相关的官方页面。
这个目录有独立约定，请先遵守 src/payments/AGENTS.md 再修改代码。
```

原生工具的参数、状态机、安全边界和扩展接口详见[技术方案报告第 38 节](./技术方案报告.md#38-129-运行时生产力与原生-web-能力)；验收规格见[运行时生产力规范](./docs/specs/2026-08-13-runtime-productivity-waves.md)。

## 快速开始

> [!IMPORTANT]
> CLI 需要 Node.js 20 或更高版本。Windows 桌面端也可以直接从 [Releases](https://github.com/YachuanWzh/flavor-code/releases) 下载。

**1. 安装**

```bash
npm install -g flavor-code
```

**2. 在项目中启动**

```bash
cd your-project
flavor
```

**3. 初始化项目上下文**

首次进入项目后运行 `/init`。Flavor 会分析语言、包管理器、源码目录和验证命令，并生成 `FLAVOR.md` 项目指南。

也可以直接执行一次性任务：

```bash
flavor --print "分析这个项目并列出最值得修复的三个问题"
flavor --resume
flavor --resume -p "继续完成剩余工作"
```

非交互模式会拒绝需要人工审批的操作，不会悬挂等待输入。

## 配置模型

最快的方式是设置环境变量：

```bash
# macOS / Linux
export OPENAI_API_KEY="sk-..."

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-..."
```

也可以把密钥放在项目根目录的 `.env`。

<details>
<summary><strong>使用 <code>.flavor/flavor.json</code> 配置多个 Provider</strong></summary>

项目配置示例：

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

配置按以下顺序合并，后者优先：

1. 全局 `~/.flavor-code/flavor.json`
2. 项目 `.flavor/flavor.json`
3. `.env`
4. 进程环境变量

支持的常用 Provider 类型：

- `openai`：OpenAI 官方接口
- `anthropic`：Anthropic 官方接口
- `openai-compatible`：兼容 OpenAI 协议的服务

</details>

OAuth PKCE 的运行时行为与配置约定见 [PKCE 规范](./docs/specs/pkce-runtime-config.md)。完整配置字段以 [配置 Schema](./src/config/schema.ts) 为准。

## 使用入口

| 入口 | 适合场景 | 启动方式 |
| --- | --- | --- |
| **CLI** | 日常开发、远程环境、脚本与 CI | `flavor` |
| **Electron** | 可视化会话、Diff、权限和资源管理 | `npm run desktop:start` |
| **VS Code / Qoder** | 编辑器上下文、诊断修复和任务控制面 | `npm run ide:install` |

### CLI

直接运行 `flavor` 后输入自然语言即可。输入 `/` 会显示内置命令、插件命令和 Skill。

常用命令：

| 命令 | 作用 |
| --- | --- |
| `/init` | 生成或更新 `FLAVOR.md` |
| `/model` | 查看或切换主/子 Agent 模型 |
| `/permissions` | 切换权限模式 |
| `/tasks` | 查看任务计划和子 Agent 状态 |
| `/compact` | 手动压缩长会话上下文 |
| `/checkpoint`、`/tree` | 保存现场、查看会话树 |
| `/rewind`、`/unrevert`、`/fork` | 恢复或分叉会话 |
| `/memory`、`/remember`、`/forget`、`/forget-cold` | 管理长期记忆；`/forget-cold` 清空 cold 记忆及其文件 |
| `/mcp` | 查看和管理 MCP 服务 |
| `/loop <goal>` | 运行带验证的自治循环 |
| `/goal <objective>` | 运行规划、执行、对抗审查流程 |
| `/audit` | 查看工具失败审计 |

运行中可以提交 steering 或排队 follow-up；当前模型响应结束后，任务会在安全边界处接收新指令。

### Electron 桌面端

```bash
npm run desktop:dev      # 开发模式
npm run desktop:start    # 构建并启动
npm run desktop:pack     # Windows 免安装目录
npm run desktop:dist     # Windows NSIS 安装包
```

桌面端提供项目和会话切换、流式 Markdown、工具与 Diff 展示、权限确认、任务状态，以及 Skill、MCP、记忆和模型管理。

### VS Code / Qoder

```bash
npm run vscode:install   # 安装到 VS Code
npm run qoder:install    # 安装到 Qoder
npm run ide:install      # 自动选择已安装的 IDE
```

扩展包含 `@flavor` Chat Participant、Mission Control、Changes & Health、Time Machine、诊断修复、CodeLens、checkpoint 和 rewind。若 `flavor` 不在 `PATH`，请设置 `flavorCode.executable`。

## MCP、Skill 与插件

Flavor 可以连接 stdio 或 Streamable HTTP MCP 服务。项目配置示例：

<details>
<summary><strong>MCP 配置与 CLI 示例</strong></summary>

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

MCP 配置也可以通过 CLI 管理：

```bash
flavor mcp list
flavor mcp add docs --url https://example.com/mcp
flavor mcp disable docs
```

</details>

Skill 是带有 YAML 头信息的 `SKILL.md`，放在 `.flavor/skills/<name>/` 或 `~/.flavor-code/skills/<name>/`。Flavor 会按任务渐进加载，也支持通过 `/<skill-name>` 显式调用。

插件放在 `.flavor/plugins/`，可以注册命令、工具、Hook、Skill 根目录和模型适配器。

> [!WARNING]
> 插件和 Agent 自注册工具是进程内执行的 JavaScript，不是安全沙箱。只安装、启用和批准你信任的代码。

## 会话、记忆与执行记录

项目运行数据集中在 `.flavor/`：

```text
.flavor/
├── flavor.json       # 项目配置
├── sessions/         # 会话时间线
├── session-assets/   # 图片附件
├── session-trees/    # 会话分支
├── checkpoints/      # 工作区快照
├── memory/           # 长期记忆
├── traces/           # 可选执行 trace
├── audit.jsonl       # 工具失败审计
├── skills/           # 项目 Skill
└── plugins/          # 项目插件
```

长期记忆会区分用户偏好、行为反馈、项目约定和外部引用。自动提取只保存高置信候选，并提供确认、忽略和删除入口；密钥、Token、原始工具输出和模型猜测会被拒绝。

图片提示支持 PNG、JPEG 和 WebP，单图最大 5 MiB、每次最多 5 张。桌面端支持选择或拖放；CLI 剪贴板图片目前支持 Windows 和 macOS。

## 权限与沙箱

| 模式 | 行为 |
| --- | --- |
| `default` | 读操作自动放行，写、Shell、网络和破坏性操作按需确认 |
| `acceptEdits` | 工作区写入和例行验证自动放行 |
| `plan` | 只读规划，不允许修改和执行 |
| `bypassPermissions` | 主 Agent 在硬安全检查后尽量自动执行 |
| `auto` | 使用分类器判断，无法确定时回到人工确认 |
| `bubble` | 将不确定操作冒泡给主会话审批 |

> [!CAUTION]
> 本地 Shell 仍然以当前用户身份运行。处理不可信项目时建议启用 Docker。

<details>
<summary><strong>Docker 执行环境示例</strong></summary>

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

Docker 不可用时任务会失败，不会静默回退到本机。配置文件中的敏感字段与 OAuth Token 使用本机配置密钥进行 AES-256-GCM 认证加密。

</details>

## SDK、RPC 与评测

<details>
<summary><strong>Node.js SDK 示例</strong></summary>

```ts
import { createFlavorRuntime } from "flavor-code/sdk";

const runtime = await createFlavorRuntime({
  workspace: process.cwd(),
  approvalPolicy: "deny",
  output: console.log,
});

await runtime.session.start();
await runtime.session.submit("修复失败的测试");
await runtime.dispose();
```

</details>

其他 IDE 或语言可以通过 JSONL RPC 接入：

```bash
flavor --mode rpc --workspace . --trace .flavor/traces/run.jsonl
```

评测运行：

```bash
flavor eval eval.json --output report.json
```

RPC、trace、replay、eval、会话树与 Docker 的设计约束见 [控制面规范](./docs/specs/2026-07-29-control-plane-sandbox-vscode.md)。

## 开发

```bash
npm ci
npm test
npm run typecheck
npm run vscode:typecheck
npm run build
npm run smoke:install
```

- TypeScript strict，目标 ES2022，Node.js 20+
- Vitest 单元与集成测试
- tsup 构建 CLI、SDK、Electron 主进程和 VS Code 扩展
- Vite 构建 Electron renderer
- CI 覆盖 Windows/macOS 与 Node 20/24

发布构建默认不生成或打包 source map。需要本地调试构建时显式开启：

```bash
# macOS / Linux
FLAVOR_SOURCEMAP=1 npm run build

# Windows PowerShell
$env:FLAVOR_SOURCEMAP = "1"
npm run build
```

## 文档

- [技术方案报告](./技术方案报告.md)：整体架构、Agent 循环、上下文、权限、插件和安全模型
- [运行时可靠性规范](./docs/specs/2026-07-26-runtime-reliability.md)
- [控制面、沙箱与 VS Code 规范](./docs/specs/2026-07-29-control-plane-sandbox-vscode.md)
- [多模态图片规范](./docs/specs/2026-07-30-multimodal-image-attachments.md)
- [VS Code 后续规划](./docs/specs/2026-08-01-flavor-code-vscode-next.md)

## 安全提示

- 审查模型生成的代码和命令，尤其是依赖安装、脚本和删除操作。
- 不要把 `.flavor/sessions/`、trace 或长期记忆当作秘密仓库。
- 使用最小权限 API Key，不要提交 `.env`。
- Skill 内容可能影响模型行为；插件和自注册工具还拥有进程内 Node.js 权限。
- 建议在版本控制下工作，并在高风险任务前创建 checkpoint。

## 参与贡献

欢迎提交 Issue 和 Pull Request。提交前请至少运行：

```bash
npm test
npm run typecheck
npm run vscode:typecheck
npm run build
```

架构改动建议先阅读 [技术方案报告](./技术方案报告.md) 和相关 [设计规范](./docs/specs/)。

## License

[MIT](./LICENSE)

<p align="center">
  Made with 🌶️ by Flavor Code contributors.
</p>
