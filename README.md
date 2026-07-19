# flavor-code

<p align="center">
  <b>终端与桌面端的 AI 编程助手</b><br/>
  <sub>像和资深程序员结对编程一样，在命令行或 Electron 桌面应用里完成读、写、搜、改</sub>
</p>

---

`flavor-code` 是一个同时提供终端界面与 Electron 桌面应用的 AI 编程助手。它接入大语言模型（OpenAI GPT、Anthropic Claude 或任何兼容服务），能理解你的项目结构，在工作区范围内安全操作文件，甚至能把复杂任务拆成多块，分给多个"小助手"并行处理。

当前版本：**0.3.0**

## 它能做什么

- **阅读和理解代码** — 你问"这个函数是干什么的"，它读文件然后告诉你
- **修改和创建文件** — "帮我在 `src/` 下新建一个 `utils.ts`"，它写出来
- **搜索代码库** — "项目里哪些地方调用了这个函数"，它用 ripgrep 帮你搜
- **运行命令** — 在受控范围内执行 shell 命令，比如跑测试、装依赖
- **拆分复杂任务** — 如果需求涉及多个文件，它先列出计划，再按步骤执行，独立子任务并行推进
- **主动提问澄清** — 需求不明确时，弹出结构化选择题让你决定方向，而不是自己瞎猜
- **实时进度面板** — 终端里显示任务执行状态：○ 待执行 · ⟳ 执行中 · ✓ 完成 · ✗ 失败
- **记住上下文** — 聊到一半退出，下次 `--resume` 回来继续
- **长任务不中断** — 上下文快满时自动压缩旧消息并生成工作摘要，检测到活跃进度时自动扩展迭代上限
- **插件和 Skill** — 通过插件扩展功能，通过 Skill（技能包）教它新的工作流
- **审计日志** — 所有工具执行失败都会被记录到 `.flavor/audit.jsonl`

---

## 安装

**前置条件：Node.js ≥ 20**

```bash
npm install -g flavor-code
```

进入你的项目，启动：

```bash
cd your-project
flavor
```

首次使用时输入 `/init`，Flavor 会自动检测项目（语言、包管理器、源码目录、测试命令），生成 `FLAVOR.md` 项目指南文件。

### 从源码运行

```bash
git clone <repo-url>
cd flavor-code
npm ci
npm run build
node dist/cli.js
```

---

## 配置模型

Flavor 本身不包含 AI 模型，需要你提供 API Key。支持三种方式：

### 环境变量（最快捷）

```bash
# macOS / Linux
export OPENAI_API_KEY="sk-你的密钥"
flavor

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-你的密钥"
flavor
```

### .env 文件

在项目根目录放一个 `.env` 文件（记得加入 `.gitignore`）：

```
OPENAI_API_KEY=sk-你的密钥
```

### 配置文件（最灵活）

在项目下创建 `.flavor/flavor.json`：

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "defaultModel": "gpt-5",
      "cheapModel": "gpt-5-mini"
    }
  },
  "agents": {
    "main": { "model": "openai:gpt-5" },
    "subagent": { "model": "openai:gpt-5-mini" }
  },
  "maxSubagents": 3,
  "permissionMode": "default",
  "language": "zh-CN",
  "maxIterations": {
    "main": 80,
    "subagent": 40,
    "softLimitFactor": 0.8,
    "extendBy": 20
  },
  "loop": {
    "maxCycles": 20,
    "maxTokens": 500000,
    "isolation": "auto"
  }
}
```

- 主 Agent 用大模型，子 Agent 用小模型，兼顾质量和成本
- `${OPENAI_API_KEY}` 自动从环境变量或 `.env` 取值
- `language: "zh-CN"` 让 Flavor 用简体中文回复（也支持 `en-US`、`ja-JP` 等 BCP47 标签）
- 支持 Anthropic（`"type": "anthropic"`）和任何兼容 OpenAI 接口的服务（`"type": "openai-compatible"`）
- 关于 OAuth PKCE 企业级认证，请参阅下方 [PKCE 认证配置](#pkce-认证配置)

## MCP 服务器

Flavor 可以作为 MCP client，在启动时连接配置的 server，并把远端 tools 直接加入 Agent 的工具列表。支持本地 stdio 与远程 Streamable HTTP 两种传输。

在项目级 `.flavor/flavor.json`（或全局 `~/.flavor-code/flavor.json`）中添加：

```json
{
  "mcpServers": {
    "mcp-docs": {
      "url": "https://modelcontextprotocol.io/mcp"
    },
    "filesystem": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@modelcontextprotocol/server-filesystem", "."],
      "cwd": ".",
      "timeoutMs": 60000
    },
    "company-api": {
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_API_TOKEN}"
      },
      "timeoutMs": 120000
    }
  }
}
```

- stdio server 使用 `command`，并可配置 `args`、`env`、`cwd`；相对 `cwd` 从工作区解析。
- 上面的 filesystem 配置适用于 Windows；macOS/Linux 可改为 `"command": "npx"`，并从 `args` 删除 `"/c", "npx"`。
- HTTP server 使用 `url`，并可配置 `headers`。鉴权信息建议通过 `.env` 和 `${ENV_NAME}` 插值传入。
- 两种 server 都支持 `disabled: true` 和 `timeoutMs`（默认 60000，范围 100–1800000 毫秒）。
- 远端 tool 暴露为 `mcp__<server>__<tool>`；不兼容模型命名规则的字符会被稳定转义。
- MCP 调用按网络工具处理：`default` / `acceptEdits` 模式会请求批准，`bypassPermissions` 直接允许，`auto` 交给分类器判断；`--print` 不会绕过批准策略。
- MCP tools 只暴露给主 Agent，不会出现在子 Agent 的工具列表中。
- 单个 server 连接失败不会阻止 Flavor 启动，可通过 `/config` 查看已脱敏的 diagnostics。
- 当前版本接入 MCP tools；resources、prompts、sampling、elicitation 与旧式 HTTP+SSE 尚未暴露给 Agent。

运行时可以直接管理 MCP 服务：

```text
/mcp                         # 查看服务状态、传输类型和工具数量
/mcp tools <server>          # 查看服务暴露的工具及输入 schema
/mcp reconnect <server>      # 重新连接服务并刷新模型工具列表
/mcp enable [server|all]     # 启用服务，省略名称时处理全部
/mcp disable [server|all]    # 禁用服务，省略名称时处理全部
```

启用/禁用状态会写入项目的 `.flavor/flavor.json`，并在当前会话中立即更新，无需重启 Flavor。stdio server 的启动日志不会直接写入交互终端；连接失败可通过 `/mcp` 查看。

### Loop Engineering

使用 `/loop <goal>` 启动经过宿主验证的前台自治循环，例如：

```text
/loop 修复当前项目的类型错误并通过测试
```

- `loop.maxCycles` 和 `loop.maxTokens` 是每次用户授权的步长；达到门槛后询问是否继续，再按相同步长增加下一道门槛。
- 验证命令从 `package.json` 与 `FLAVOR.md` 自动推断；若启动时没有，则先运行一次 verifier-discovery cycle，让 worker 建立有意义的项目原生检查，再由宿主重新推断。只有宿主执行的确定性验证通过才会结束为 `succeeded`。
- `isolation: "auto"` 对只读目标使用当前目录，对代码修改或不明确目标使用独立 Git worktree；不能安全隔离时进入 `needs_human`。
- 运行状态与证据写入 `.flavor/loops/<loop-id>/`。Ctrl+C 可取消；不会自动 merge、push 或 deploy。

---

## PKCE 认证配置

> **适用场景**：企业或团队需要通过统一授权体系访问 LLM 服务，且不希望真正的 API Key 暴露给每个开发者。

### 什么是 PKCE

PKCE（Proof Key for Code Exchange，发音 "pixy"）是 OAuth 2.0 的一种扩展协议，专为**无法安全存储客户端密钥**的原生应用设计。flavor-code 内置了完整的 PKCE 客户端能力，配合 **flavor-pkce** 项目（授权服务器 + API 网关）实现"无 API Key 暴露"的 LLM 安全访问。

### 工作原理

一句话概括：**用户浏览器登录授权服务器 → 获取短期 JWT → 用 JWT 通过 API 网关访问 LLM → 网关将 JWT 替换为真正的 API Key 再转发到上游**。

```mermaid
sequenceDiagram
    participant 用户
    participant flavor-code
    participant 浏览器
    participant 授权服务器
    participant API网关
    participant LLM

    用户->>flavor-code: flavor
    flavor-code->>flavor-code: 启动时检测 OAuth 配置
    flavor-code->>浏览器: 打开授权页面
    浏览器->>授权服务器: 登录 + 授权
    授权服务器-->>浏览器: 重定向到本地回调
    浏览器->>flavor-code: code + state
    flavor-code->>授权服务器: code + code_verifier
    授权服务器-->>flavor-code: JWT access_token (3天有效)
    Note over flavor-code: Token 缓存到本地文件

    用户->>flavor-code: 输入 prompt
    flavor-code->>API网关: POST + Authorization: Bearer JWT
    API网关->>API网关: 验证 JWT 签名
    API网关->>LLM: POST + 真实 API Key
    LLM-->>API网关: SSE 流式响应
    API网关-->>flavor-code: 透明转发 SSE
    flavor-code-->>用户: 展示回复
```

真实 API Key **只存在于 API 网关**，在整个授权和调用过程中不会离开网关。

### 配置方法

#### 方式一：显式 OAuth 配置（推荐）

在 `.flavor/flavor.json` 中配置完整的 OAuth 参数：

```json
{
  "providers": {
    "openai": {
      "type": "oauth-callback",
      "apiType": "openai",
      "baseURL": "https://api-gateway.your-company.com",
      "authorizationUrl": "https://auth.your-company.com/authorize",
      "tokenUrl": "https://auth.your-company.com/token",
      "clientId": "flavor-code-cli",
      "scope": "models:read models:use",
      "defaultModel": "gpt-5",
      "cheapModel": "gpt-5-mini"
    }
  }
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `type` | 是 | 固定为 `"oauth-callback"` |
| `apiType` | 是 | `"openai"` 或 `"anthropic"`，决定上游 API 协议 |
| `baseURL` | 是 | API 网关地址（注意：不是 LLM 服务商的地址） |
| `authorizationUrl` | 是 | 授权服务器的 `/authorize` 端点 |
| `tokenUrl` | 是 | 授权服务器的 `/token` 端点 |
| `clientId` | 是 | 在授权服务器注册的客户端标识 |
| `scope` | 否 | 空格分隔的权限范围，默认 `"models:read models:use"` |
| `defaultModel` | 是 | 主 Agent 使用的模型 |
| `cheapModel` | 是 | 子 Agent 使用的模型 |

#### 方式二：环境变量内建默认值

如果不想在每个项目配置文件里写 OAuth 地址，可以通过环境变量设置全局默认值（`.env` 或 shell 环境变量）：

```bash
export OAUTH_AUTHORIZATION_URL="https://auth.your-company.com/authorize"
export OAUTH_TOKEN_URL="https://auth.your-company.com/token"
export OAUTH_CLIENT_ID="flavor-code-cli"
export OAUTH_SCOPE="models:read models:use"
```

此时 `.flavor/flavor.json` 只需最简配置：

```json
{
  "providers": {
    "openai": {
      "type": "oauth-callback",
      "apiType": "openai",
      "baseURL": "https://api-gateway.your-company.com",
      "defaultModel": "gpt-5",
      "cheapModel": "gpt-5-mini"
    }
  }
}
```

### 首次使用流程

1. 按上述方式配置 `.flavor/flavor.json`
2. 运行 `flavor`
3. 系统自动打开浏览器，跳转到授权服务器登录页面
4. 输入用户名和密码登录
5. 在授权确认页面点击 Approve
6. 浏览器显示"授权成功，请返回终端"
7. flavor-code 自动获取 JWT Token 并缓存（3 天有效）
8. 后续 3 天内重启 flavor 无需再次授权

Token 缓存文件位于 `~/.flavor-code/auth.json`。

### 常见问题

**Q: 和直接用 API Key 有什么区别？**
从使用体验上几乎没有区别。从安全角度，你的终端从未持有真正的 LLM API Key——它拿到的只是一个 3 天过期的 JWT。即使 JWT 泄露，影响范围也有限（3 天、受 scope 约束、可被服务端撤销）。

**Q: 缓存过期了怎么办？**
flavor-code 默认在过期前 60 秒自动丢弃缓存，下次启动时自动重新弹出浏览器授权。你也可以手动删除 `~/.flavor-code/auth.json` 强制重新授权。

**Q: 如何搭建授权服务器和网关？**
参考 **flavor-pkce** 项目，提供了完整的 Docker Compose 部署方案（FastAPI + SQLite + JWT RS256），一键启动。

---

## 基本用法

### Electron 桌面端（0.3.0 MVP）

0.3.0 新增了参考 Codex 交互方式设计的 Electron 桌面端。它不是简单套壳网页：Agent 运行时在 Electron 主进程中工作，桌面界面通过受控 IPC 与运行时通信，因此与 CLI 共享同一套工具、会话和配置能力。

MVP 已支持：

- 项目切换、新建会话、历史会话分组、恢复与安全删除
- 消息流式输出、Markdown、思考过程、工具调用、Diff 和子 Agent 状态展示
- 权限确认、Agent 提问、任务取消，以及模型和权限模式切换
- 全部 `/` 命令，以及 Skills、Plugins、MCP 和 `/loop` 等现有运行时能力
- 接近 Codex 的三栏工作台与单层自绘顶栏，并适配窄窗口显示

从源码运行或打包：

```powershell
npm run desktop:dev      # 启动带热更新的桌面开发环境
npm run desktop:start    # 构建后启动桌面应用
npm run desktop:pack     # 生成 release/win-unpacked（Windows）
npm run desktop:dist     # 生成 Windows NSIS 安装包
```

Windows 打包产物位于：

- 免安装目录：`release/win-unpacked/Flavor Code.exe`
- NSIS 安装包：`release/Flavor-Code-0.3.0-x64.exe`

模型配置仍读取全局 `~/.flavor-code/flavor.json`、项目 `.flavor/flavor.json`、`.env` 和环境变量，因此 CLI 与桌面端可以共享配置与会话。生产版桌面窗口启用了 `contextIsolation` 和 Chromium 沙箱，关闭了渲染进程的 Node.js 集成；文件、命令和 Agent 操作只通过显式 IPC 接口进入主进程。Windows 的 `desktop:dev` 为兼容工作区内 Chromium 子进程启动，仅在本地开发启动器中使用 `--no-sandbox`，打包产物不携带该参数。

### 交互模式

```bash
flavor
```

直接打字聊天：

- "这个项目的入口文件是什么"
- "帮我在 src/utils 下写一个日期格式化的函数"
- "把所有 console.log 替换成 logger.debug"
- "解释一下 src/config/load.ts 里的配置加载逻辑"

### 非交互模式（脚本/CI 调用）

```bash
flavor --print "列出 src/ 下所有导出了类的文件"
flavor -p "分析这个项目的依赖关系"
```

`--print` 模式下所有需要审批的操作默认拒绝，不会悬挂等待。

### 恢复上次会话

```bash
flavor --resume                    # 恢复最近一次会话
flavor --resume session-20250101   # 恢复指定会话
flavor --resume -p "继续刚才的工作"  # 恢复后非交互执行
```

### 长任务与上下文压缩

Flavor 的压缩是分层执行的：

1. **微压缩**：上下文接近阈值时，先把旧的工具结果替换为清理标记，保留最近 5 个
2. **完整压缩**：仍然超阈值时，调用模型生成结构化工作摘要，包含用户意图、技术决策、文件、错误、待办、当前工作和下一步
3. **反应式压缩**：模型返回 `context_overflow` 且无可见输出时，强制压缩并重试同一轮

压缩后摘要作为"续接消息"注入，保留系统指令、项目指南、任务状态和近期消息。输入 `/compact` 可手动触发。

---

## 内置命令

交互模式下，以 `/` 开头触发命令：

| 命令 | 作用 |
|------|------|
| `/model main <provider:model>` | 切换主 Agent 模型 |
| `/model subagent <provider:model>` | 切换子 Agent 模型 |
| `/permissions default\|acceptEdits\|plan\|bypassPermissions\|auto\|bubble` | 切换权限模式 |
| `/init` | 生成或更新 FLAVOR.md |
| `/config` | 查看当前配置（密钥已脱敏） |
| `/skills` | 列出已发现的 Skill |
| `/plugins` | 列出已加载的插件 |
| `/hooks` | 列出 Hook 状态 |
| `/tasks` | 显示当前任务计划与进度 |
| `/audit [toolFilter]` | 查看工具失败审计日志 |
| `/compact` | 强制压缩上下文 |
| `/clear` | 清空终端显示 |
| `/mcp [status\|tools\|reconnect\|enable\|disable]` | 管理 MCP 服务器 |
| `/loop <goal>` | 启动经验证的前台自治循环 |
| `/help` | 显示帮助 |
| `/exit` | 退出 |

输入 `/` 后弹出交互式菜单，列出所有可用命令（内置 + 插件 + Skill），支持模糊匹配和实时过滤。还可以直接输入 `/<skill-name>` 调用某个 Skill，或 `/<plugin-command>` 执行插件命令。

---

## 权限模式

为了安全，Flavor 提供六种权限模式。旧配置会自动迁移：`safe` / `workspace` → `default`，`full` → `bypassPermissions`。

| 模式 | 读文件 | 写文件 | Shell | 网络 | 破坏性操作 |
|------|--------|--------|-------|------|------------|
| **default**（默认） | 自动放行 | 需确认 | 需确认 | 需确认 | 需确认 |
| **acceptEdits** | 自动放行 | 工作区内自动放行 | 例行验证自动放行 | 需确认 | 需确认 |
| **plan** | 自动放行 | 拒绝 | 拒绝 | 拒绝 | 拒绝 |
| **bypassPermissions** | 自动放行 | 自动放行 | 通过硬安全检查后放行 | 主 Agent 放行 | 通过硬安全检查后放行 |
| **auto** | 自动放行 | 工作区内自动放行 | AI 分类 | AI 分类 | AI 分类 |
| **bubble** | 自动放行 | 冒泡审批 | 例行验证自动放行，其余冒泡 | 冒泡审批 | 冒泡审批 |

子 Agent 使用 **bubble** 模式，把无法本地判定的请求交给主会话审批；主会话处于 **plan** 时，子 Agent 同样只读。`auto` 分类器不可用或不确定时会退回人工确认。权限系统是纵深防御，但它不是操作系统级别的沙箱——被批准的命令仍然以你的用户权限运行。

配置写入使用排他锁、锁内重读、`.bak` 备份和原子替换。全局 `~/.flavor-code/flavor.json` 的敏感字段与 OAuth `auth.json` 使用 AES-256-GCM 认证加密；旧明文数据会在读取/下一次保存时迁移。

---

## 任务计划与子 Agent 并行

当你提出复杂需求时，Flavor 会先制定任务计划，然后逐步推进。终端显示实时进度面板：

```
── task progress ──
✓ 分析项目结构
⟳ 重构配置加载模块 (1.2s)
○ 更新测试用例
○ 更新文档
```

独立子任务会被分派给子 Agent **并行处理**：多个子 Agent 同时工作，每个使用独立的上下文窗口和便宜模型，完成后返回结构化结果。最大并行数由 `maxSubagents` 配置（默认 3，最大 16）。

---

## Skill（技能包）

Skill 是放在 `.flavor/skills/` 或全局 `~/.flavor-code/skills/` 下的 Markdown 包，用来教 Flavor 处理特定场景。每个 Skill 是一个含 `SKILL.md` 的目录：

```markdown
---
name: code-review
description: Review code for common issues
---

# Code Review

检查代码时关注：
1. 类型安全
2. 错误处理
3. 命名规范
4. 可测试性

参考 `references/checklist.md` 中的详细清单。
```

当你提问时，Flavor 自动匹配相关 Skill 并加载指导。也可以直接输入 `/code-review` 显式调用。Skill 正文中的资源（`assets/`、`references/`、`scripts/`）只有被显式引用才能被访问。

---

## 插件

插件放在 `.flavor/plugins/` 下，可以注册自定义命令、工具、Hook、Skill 根目录等。插件命令可以直接通过 `/command-name` 调用。

> ⚠️ 插件是进程内运行的 Node.js 代码，不是沙箱隔离。请只加载你信任的插件。

---

## 审计日志

每次工具执行失败都会被记录到 `.flavor/audit.jsonl`，包含时间戳、会话 ID、工具名、Agent 角色和错误信息：

```bash
/audit          # 查看所有工具失败汇总
/audit Shell    # 按工具名过滤
```

---

## 项目文件结构

Flavor 相关的文件都放在 `.flavor/` 目录下：

```
.flavor/
├── flavor.json        # 项目级配置
├── sessions/          # 会话存档（v2 JSONL 格式）
│   └── session-xxx.jsonl
├── audit.jsonl        # 工具失败审计日志
├── skills/            # 项目 Skill
└── plugins/           # 项目插件
```

---

## 安全须知

- AI 模型的输出不一定总是正确或安全的，请审查它生成的代码
- Skill 和插件中的内容应视为潜在不可信输入
- 被批准执行的 shell 命令以你的用户身份运行
- 不要将 `.flavor/sessions/` 中的会话文件当作秘密仓库
- 建议在版本控制下使用、配置最小权限的 API Key

---

## 开发

```bash
npm ci              # 安装依赖
npm test            # 跑测试
npm run test:watch  # 监听模式
npm run typecheck   # 类型检查
npm run build       # 构建
npm run smoke:install  # 验证打包和安装
```

- **语言**：TypeScript（strict 模式，ES2022 目标）
- **构建**：tsup → ESM `dist/cli.js`
- **测试**：Vitest，零真实凭据
- **CI**：Windows / macOS × Node 20 / 24

---

## 路线图

后续方向包括（这些是未来规划，非 0.3.0 已交付能力）：

- `/loop` 的后台恢复、调度与并发 loop 管理
- 后台 Session Memory 持久化记忆系统
- 更细粒度的任务恢复与重放
- IDE 集成（VS Code / JetBrains 扩展）
- 系统凭据存储（keychain 集成）
- 插件隔离/签名验证
- 跨设备会话

---

## 技术架构

详细技术方案请参阅 [技术方案报告](./技术方案报告.md)，涵盖：

- 系统架构拓扑与全链路时序
- Agent 核心循环（迭代控制、流式处理、工具执行）
- 三级上下文压缩（微压缩、模型摘要、反应式压缩）
- 任务系统（TaskPlan 六状态机、子 Agent DAG 并行调度）
- Provider 适配层与错误标准化
- **PKCE 到 SSE 全链路（OAuth 授权 → API 网关 → 流式代理）**
- 权限引擎决策树与 Shell 安全分析
- Hook 事件总线（19 个事件）
- Skill 渐进加载与资源安全
- 插件生命周期与信任模型
- 会话 JSONL 持久化与 v1/v2 兼容
- 安全威胁模型与缓解措施

---

## License

见 [LICENSE](./LICENSE) 文件。
