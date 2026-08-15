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
| 🔎 | **代码图导航** | 本地 AST 代码图索引（`.flavor/astgraph/`），通过 `ast_search`/`ast_callers`/`ast_impact` 等查询精确定位符号、追踪可达性 |
| 🎨 | **E2E 需求到交付** | 从粗需求或设计稿到可交付产品：PRD、交互原型、视觉还原、接口联调、自主验收与评分交付（仅 Electron） |
| 🛡️ | **明确的权限边界** | 分别控制读、写、Shell、网络和破坏性操作，也可使用 Docker |

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
| `/pals`、`/chat`、`/co-work` | 发现并协作其他本机 CLI 实例 |
| `/audit` | 查看工具失败审计 |

运行中可以提交 steering 或排队 follow-up；当前模型响应结束后，任务会在安全边界处接收新指令。

#### CLI Pals 与跨项目协作

同一 Windows 或 macOS 用户下的交互式 CLI 可以通过纯本地 IPC 协作（Windows named pipe 或 Unix socket，不回退到 TCP）。先给每个窗口一个容易识别的别名：

```bash
# 终端 A，位于项目 A
flavor --pal-name A

# 终端 B，位于项目 B
flavor --pal-name B
```

常用命令：

```text
/pals                              # 查看别名和每进程 UUID
/pals --verbose                    # 额外显示项目路径和时间
/pals rename api                   # 重命名当前活动实例
/chat B 更新 API 和测试             # 投递给 B，并安全启动其 Agent
/co-work B 先升级 B，再兼容 A        # 先协商同一计划，再并行开工
/co-work status [co-work-uuid]
/co-work cancel <co-work-uuid> [reason]
```

`/chat` 支持双向任务通信。B 空闲时，带来源标识的消息会启动正常模型回合；B 正在运行时，消息会成为 steering；已有本地提交待运行时则成为 follow-up。远端文本会转换成安全的非斜杠 prompt，因此 `/exit` 一类文本不会被当成本地命令分派。B 可以用 `/chat A ...` 回复。

`/co-work` 会先让双方进入规划，等待双方接受同一个哈希计划并声明 READY；较早的 READY 意图会被保留，只有 broker 恰好一次的 START 事件才会放行并行执行。每个 Agent 只在自己的项目内工作，只接收分配给自己的任务，并提交有界的完成证据。broker 指定的集成负责人会检查所有断言，再通过 `CoWorkIntegrate` 广播 END 或 FAIL。通信使用经过认证、有大小上限的本机 IPC，不开放 TCP 监听；peer 输入不能代替本机工具审批，也不能访问另一工作区。UUID/别名路由和协议已能支持第三个活动实例；持久化成果物交换、broker 重启日志与恢复、大规模多方协调属于后续强化。详见 [CLI Pals 规范](./docs/specs/2026-08-14-cli-pals-cowork.md)。

### Electron 桌面端

```bash
npm run desktop:dev      # 开发模式
npm run desktop:start    # 构建并启动
npm run desktop:pack     # Windows 免安装目录
npm run desktop:dist     # Windows NSIS 安装包
```

桌面端提供项目和会话切换、流式 Markdown、工具与 Diff 展示、权限确认、任务状态，以及 Skill、MCP、记忆和模型管理。

侧栏的 **E2E** 模块覆盖从粗需求到可验收成果物的完整交付链路：从粗需求生成 PRD 与可交互原型（支持审阅与退回），确认后进入 D2C 视觉还原（Vue 3 / React），自动启动 Vite dev server 进行像素级对比，输出视觉还原度评分与结构化差异报告，并提供叠加、帘幕、闪烁与热力图等对比模式、SVG 标注层和按严重度排序的问题列表；视觉审阅通过后，自动生成或导入 Swagger/OpenAPI 契约以创建 Axios 封装与 Express mock 服务，随后进行自主交互验收，最终完成评分与成果物交付。

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
- [E2E 需求到交付规范](./docs/specs/2026-08-12-e2e-requirement-to-delivery.md)

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
