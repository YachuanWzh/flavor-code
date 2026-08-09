<p align="center">
  <img src="./assets/icon-transparent.png" alt="flavor-code 辣椒像素吉祥物" width="168" />
</p>

# flavor-code

<p align="center">
  <b>终端与桌面端的 AI 编程助手</b><br/>
  <sub>像和资深程序员结对编程一样，在命令行或 Electron 桌面应用里完成读、写、搜、改</sub>
</p>

---

`flavor-code` 是一个同时提供终端界面与 Electron 桌面应用的 AI 编程助手。它接入大语言模型（OpenAI GPT、Anthropic Claude 或任何兼容服务），能理解你的项目结构，在工作区范围内安全操作文件，甚至能把复杂任务拆成多块，分给多个"小助手"并行处理。

当前稳定版本：**1.2.3**

## 它能做什么

- **阅读和理解代码** — 你问"这个函数是干什么的"，它读文件然后告诉你
- **修改和创建文件** — "帮我在 `src/` 下新建一个 `utils.ts`"，它写出来
- **搜索代码库** — "项目里哪些地方调用了这个函数"，它用 ripgrep 帮你搜
- **运行命令** — 在受控范围内执行 shell 命令，比如跑测试、装依赖
- **拆分复杂任务** — 如果需求涉及多个文件，它先列出计划，再按步骤执行，独立子任务并行推进
- **主动提问澄清** — 需求不明确时，先给结构化选项，最后一项始终允许用户自行输入
- **实时进度面板** — 终端里显示任务执行状态：○ 待执行 · ⟳ 执行中 · ✓ 完成 · ✗ 失败
- **恢复完整时间线** — 聊到一半退出，下次 `--resume` 会恢复消息、工具调用、任务步骤、重试、用量和 Diff；旧的已压缩会话会明确展示压缩摘要边界
- **长任务不中断** — 上下文快满时自动压缩旧消息并生成工作摘要，检测到活跃进度时自动扩展迭代上限
- **跨会话长期记忆** — 自动保留少量用户偏好、项目约定和行为反馈，新会话不必重复说明
- **插件和 Skill** — 通过插件扩展功能，通过 Skill（技能包）教它新的工作流
- **Agent 自注册工具** — 任务中用自然语言描述一个可复用能力，Agent 创建 `RegisterTool` 持久工具，同一次任务立刻可用，无需重启
- **MCP 服务管理** — CLI 与 Electron 共享项目级配置，可添加、编辑、启停和删除 stdio / HTTP 服务
- **审计日志** — 所有工具执行失败都会被记录到 `.flavor/audit.jsonl`
- **事故上报与 RCA** — 工具执行失败自动上报到 langgraph-claw 告警管道，P0 级错误触发自动根因分析（Auto-RCA）
- **对抗性审查（/goal）** — 分离"规划 - 执行 - 审查"三角色，3 个独立 AI 质疑者多数投票验证目标是否达成，不通过则打回重做
- **运行中追加任务** — CLI 工作时 Enter 保存一条待发送任务，SSE 结束后自动提交；`/steer` 可立即调整仍在执行的任务
- **可逆会话树** — 为上下文和工作区创建内容寻址 checkpoint，可 rewind、unrevert，并从历史节点继续分支
- **SDK、JSONL RPC 与 Eval** — Node 调用方、IDE 和自动化评测共用同一套生产运行时
- **图片上传与多模态** — CLI 中 Ctrl+V 粘贴剪贴板图片、桌面端文件选择器上传，支持 PNG/JPEG/WebP，每张 ≤5MB，去重存储，作为 user 消息的一部分发送给视觉模型分析 UI 截图、设计稿或错误日志
- **PKCE 运行时 LLM 配置管理** — OAuth 令牌可随登录下发实际模型、网关地址与可用模型列表，运行时动态切换主/子 Agent 模型，`/login` 立即生效无需重启，项目文件不被改写
- **提示词缓存优化与命中率量化** — 稳定前缀（系统提示词 + FLAVOR.md + 用户偏好）与动态段严格分离，缓存断点固定在前缀末尾，任务状态更新、记忆修改、`/model` 切换都不再改写前缀字节；对话历史通过滚动尾部断点整段纳入缓存，稳态命中率可达 90~98%；按 `apiType` / `baseURL` 自动识别缓存策略；命中率日志默认写入 `.flavor/usage.jsonl`（无需任何开关，每个新 session 覆盖上一次），携带 `sessionId`
- **Docker 沙箱** — 可选择让 Shell、自治 loop 及其验证命令在无网络、只读根文件系统的容器中运行

### 子 Agent 字节级提示词缓存（0.8.0）

同一次 `Task` 调度现在只冻结一次主 Agent 的模型可见上下文。每个子 Agent 都从这份快照创建独立副本，完整复用 system prompt、`FLAVOR.md`、任务状态、压缩摘要和父会话历史，只在最后追加自己的角色约束与任务 directive。共享部分保持消息顺序和 UTF-8 字节一致，可提高 Anthropic Prompt Cache 与 OpenAI Automatic Prompt Caching 的命中机会，同时父子消息、压缩和 usage 状态仍然彼此隔离。

Anthropic 请求会在 fork 边界发送显式 `cache_control`；OpenAI 与 OpenAI-compatible 服务继续使用自动缓存，不注入可能与旧模型不兼容的专用字段。缓存仍受提供商规则限制：短于最小 token 门槛的前缀不会缓存；主/子 Agent 工具定义或模型不同会阻止整包父子命中；首批完全并发的 Anthropic 子请求也可能在缓存写入可见前同时发生 miss。后续兄弟任务、依赖节点和重试仍可复用相同的父前缀。

### OpenAI-compatible 工具调用兼容修复（1.2.3）

OpenAI Responses 流式适配器现在同时兼容官方事件序列和部分兼容端点的精简事件序列：

- 官方端点通过 `response.function_call_arguments.done` 完成工具参数时，保持原有解析行为。
- 兼容端点省略参数完成事件、只在 `response.output_item.done` 中返回完整 `function_call` 时，也能正确提取工具名、调用 ID 和参数，不再把本轮误判为“无工具调用”并提前结束。
- 同一工具调用同时出现两种完成事件时，按 `output_index` 去重，避免工具被重复执行。
- 修复仅位于 OpenAI Responses 适配层；Anthropic Messages 请求、`tool_use` / `tool_result` 映射和缓存断点逻辑保持不变。

### 提示词缓存优化与命中率量化（1.2.0 / 1.2.1）

1.1.9 把字节级缓存思想扩展到**主会话本身**；1.2.0 重新划分了缓存布局，并加入了按 provider 的缓存能力识别；1.2.1 用滚动尾部断点把**整段对话历史**纳入缓存：

- **主会话滚动缓存断点（1.2.1）** — Anthropic 适配器在每次请求的最后一条消息末尾自动追加 `cache_control` 断点：本轮把全部对话历史写入缓存，下一轮前缀与本轮完全一致、整段命中，只付增量的写入成本。缓存覆盖面从「仅系统前缀」扩展到全部历史，DashScope / Anthropic 兼容端点的命中率从 ~5% 提升到稳态 90~98%，输入成本约为优化前的 1/10。断点固定在请求末尾的 text / tool_result 块上（DashScope 会静默忽略 assistant `tool_use` 块上的标记）；单请求标记预算 4 个，满额时自动淘汰价值最低的既有标记（如 fork 边界）
- **命中率日志默认开启（1.2.1）** — 每次模型请求结束的命中率 JSON 默认写入 `.flavor/usage.jsonl`，不再需要设置 `FLAVOR_DEBUG_USAGE`；每条日志携带 `sessionId`，每个新 session（含清空上下文）会覆盖上一次的文件，始终只反映当前会话。`FLAVOR_DEBUG_USAGE=1` 仍可将同一条日志镜像到 stderr（交互式 TUI 下 ink 会拦截 stderr，以文件为准）
- **缓存布局重构（1.2.0）** — 稳定前缀固定为「系统提示词 + FLAVOR.md + User memory（用户偏好）」，缓存断点设在稳定段末尾；Long-term memory（任务记忆）、Task state、`# Runtime environment`（Model、Permission mode）与 `# Current date` 全部移到断点之后。用户偏好跨任务稳定，而任务记忆、任务状态每轮都会变化，因此重新排序后，记忆更新、`/model`、`/permission` 切换和日期变化都不再改写缓存前缀字节——DeepSeek 等自动前缀缓存服务可持续整段命中。
- **缓存能力识别（1.2.0）** — 新增 `resolveCacheProfile`，根据 provider 的 `apiType`（来自 `.flavor/flavor.json` 或 PKCE 令牌 `llm_config`）与 `baseURL` 识别缓存策略：Anthropic → 显式 `cache_control` 断点；OpenAI 通用端点 → 服务端自动前缀缓存；DashScope / MaaS 网关（`dashscope*.aliyuncs.com`、`*.maas.aliyuncs.com`）经 Responses API 调用时提示 Context Cache 不适用、命中率可能偏低。provider 注册信息附带缓存策略，便于定位命中率问题。
- **FLAVOR.md 缓存断点（1.1.9）** — FLAVOR 段携带 `cacheBreakpoint`，把「系统提示词 + FLAVOR.md」固化为独立缓存单元；Task state 每轮变化只影响其后的小段，DeepSeek 等自动前缀缓存服务仍能命中大块稳定前缀。
- **tools 字节序稳定（1.1.9）** — Anthropic / OpenAI 适配器发送 tools 前按名称排序，MCP 工具重连造成的顺序漂移不再破坏请求前缀字节。
- **命中率量化（1.1.9，1.2.1 起默认开启）** — 每次请求输出一行 JSON，默认写入 `.flavor/usage.jsonl`（可用 `FLAVOR_USAGE_FILE` 覆盖路径），无需任何环境变量；设置 `FLAVOR_DEBUG_USAGE=1` 可额外镜像到 `process.stderr`：

```bash
set FLAVOR_DEBUG_USAGE=1 && flavor   # Windows CMD，仅 stderr 镜像需要
$env:FLAVOR_DEBUG_USAGE="1"; flavor  # PowerShell，仅 stderr 镜像需要
```

```json
{"event":"flavor-usage","sessionId":"session-202608050818405-ab12cd34","provider":"anthropic","model":"qwen3.8-max","inputTokens":6,"cacheReadTokens":23965,"cacheCreationTokens":2562,"totalInputTokens":26533,"cacheHitRatio":0.9032,"requestMessages":15,"requestMarkers":3}
```

**查看位置**:日志文件每个新 session 覆盖上一次的内容,另开一个终端实时观察:

```powershell
Get-Content .flavor\usage.jsonl -Wait
```

命中率 = `cacheReadTokens / totalInputTokens`。同一会话内连续请求应逐步接近 90%+；命中率骤降说明前缀字节发生了变化,可按 `event:flavor-usage` 从文件中检索排查。`requestMessages` / `requestMarkers`（1.2.1）记录本次发送的消息数与实际挂载的缓存标记数，与服务端返回的 `cacheCreationTokens` 对照可快速判定命中率异常是客户端没发标记还是服务端不创建缓存块。OpenAI 侧同时兼容 Responses 的 `input_tokens_details.cached_tokens` 与 DeepSeek 的 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`。

### 工具结果溢出保护（0.7.0）

工具输出现在会在执行层主动控制大小：单个结果最多内联 50,000 字符，同一模型轮次的全部工具结果共用 200,000 字符预算。超过任一限制时，Flavor 保留头尾预览，并把完整结果写入工作区的 `.flavor/tool-results/`；返回给模型的结果会包含原始字符数、截断原因和可直接交给 `Read` 的绝对文件路径。

这层保护发生在 `PostToolUse` Hook、UI 事件和上下文入库之前，可避免一次异常大的命令、搜索或 MCP 响应挤占模型窗口。上下文管理器原有的 `toolOutputChars` 截断仍然保留，负责保护恢复的历史会话和外部注入消息。

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
  "sleep": true,
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

`sleep` 默认是 `false`。项目配置为 `true` 且 Flavor 进程跨过本地零点时，
Flavor 会调用 subagent/cheap 模型整理刚结束的前一天会话，并将一份
`日期-摘要.md` 报告写入项目的 `.flavor/sleep/`。前一天没有 session 时不会
调用模型或生成报告；不同项目的 Flavor 进程各自独立整理自己的 workspace。

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

Electron 可从项目栏打开 **MCP 服务** 工作台，以表单添加、编辑、开启/关闭或删除项目级 stdio / HTTP 配置。保存不会打断已经运行的对话，新配置会从下一个任务开始生效。全局 MCP 配置仍会被运行时加载，但工作台只修改当前项目的 `.flavor/flavor.json`。

独立 CLI 使用同一配置管理层，适合脚本和不进入交互会话的场景：

```text
flavor mcp list [--json]
flavor mcp add local --command npx --arg=-y --arg @modelcontextprotocol/server-filesystem --arg .
flavor mcp add docs --url https://mcp.example.com/mcp --header Authorization="Bearer ${MCP_TOKEN}"
flavor mcp update docs --url https://new.example.com/mcp
flavor mcp enable|disable <name>
flavor mcp delete <name>
flavor mcp path
```

`--arg`、`--env KEY=VALUE` 和 `--header KEY=VALUE` 均可重复；`--cwd` 与 `--timeout <毫秒>` 适用于对应传输。CLI 的配置操作从下次运行时启动生效；需要查看连接状态、刷新工具或在当前会话即时启停时，继续使用 `/mcp` 命令。

## 事故上报与 RCA（0.4.0）

Flavor 内置了工具执行失败的事故上报通道，将 `PostToolUseFailure` 事件通过 AlertManager 兼容的 webhook 推送到 langgraph-claw 告警管道，触发自动根因分析（Auto-RCA）。

### 告警分级

工具失败按错误码自动分级：

| 级别 | 严重度 | 错误码 | 处理方式 |
|------|--------|--------|----------|
| **P0** | critical | `tool_error` | 自动触发 RCA，通过 agent harness + code-rca skill 分析根因 |
| **P1** | warning | `permission_denied`, `hook_denied`, `unknown_tool`, `user_denied` | 存储 + SSE 广播，需人工分析 |
| **P2** | info | `approval_required`, `invalid_input` | 低优先级记录 |
| **P3** | none | 其他 | 不上报 |

每条告警自动附带 Git 上下文（分支、commit、工作区是否脏），无需手动补充现场信息。

### 配置方式

在 `.flavor/flavor.json` 中添加：

```json
{
  "incidents": {
    "enabled": true,
    "webhookUrl": "http://localhost:8000"
  }
}
```

或通过环境变量：

```bash
export FLAVOR_INCIDENT_ENABLED=true
export FLAVOR_INCIDENT_WEBHOOK_URL="http://localhost:8000"
```

- 上报是 fire-and-forget 模式：网络失败不会中断 Agent 循环，仅输出 `[incidents]` 日志
- 默认 webhook 端点：`{webhookUrl}/api/otel/alerts`，兼容 AlertManager v4 格式
- 未启用时，IncidentReporter 为零开销空操作

### Loop Engineering

使用 `/loop <goal>` 启动经过宿主验证的前台自治循环，例如：

```text
/loop 修复当前项目的类型错误并通过测试
```

- `loop.maxCycles` 和 `loop.maxTokens` 是每次用户授权的步长；达到门槛后询问是否继续，再按相同步长增加下一道门槛。
- 验证命令从 `package.json` 与 `FLAVOR.md` 自动推断；若启动时没有，则先运行一次 verifier-discovery cycle，让 worker 建立有意义的项目原生检查，再由宿主重新推断。只有宿主执行的确定性验证通过才会结束为 `succeeded`。
- `isolation: "auto"` 对只读目标使用当前目录，对代码修改或不明确目标使用独立 Git worktree；不能安全隔离时进入 `needs_human`。
- 运行状态与证据写入 `.flavor/loops/<loop-id>/`。Ctrl+C 可取消；不会自动 merge、push 或 deploy。

### 对抗性审查（/goal）

`/goal` 提供了一套结构化、多角色对抗验证的质量门禁机制：

```text
/goal 修复项目里所有的 TypeScript 类型错误，并确保 npm test 全部通过
```

**核心思路：干活的和审查的是不同角色。** 流水线分为三个阶段：

1. **Planner（规划者）**：将自然语言目标翻译为结构化验收标准（gating 门槛 + evidence 证据），写入 `.flavor/goal-plan.md`
2. **Worker（执行者）**：在验收标准约束下执行代码变更并自我验证
3. **Skeptic Panel（质疑团）**：3 个独立 AI 并行审查工作成果——默认立场是"我不信，证明给我看"

```mermaid
flowchart LR
    A["/goal objective"] --> B["Planner<br/>生成验收契约"]
    B --> C["Worker<br/>执行代码变更"]
    C --> D["Skeptic Panel<br/>3 AI 对抗审查"]
    D -->|多数通过| E["✓ goal-complete"]
    D -->|打回重做| C
    D -->|不可修复| F["✗ goal-blocked"]
```

**关键机制：**

- **多数投票**：3 个 Skeptic 独立审查，≥2 个确认才算通过
- **精准反馈**：打回重做时附带具体缺陷清单（哪条验收标准、什么问题、是否模型可修复）
- **停滞熔断**：连续 2 轮修复后 gap 指纹不变 → 自动熔断（`goal-stalled`），避免烧钱死循环
- **契约清晰**：Planner 只描述结果不指定实现，Skeptic 只审查契约不许发明新需求
- **Fail-open**：Skeptic 解析失败按"不通过"处理，宁可多跑一轮也不错过问题

当前硬编码参数：`skepticCount: 3`、`maxRounds: 5`、`maxStallStreak: 2`。

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
| `defaultModel` | 否 | 主 Agent 的默认模型；PKCE 令牌未下发 `llm_config` 时生效 |
| `cheapModel` | 否 | 子 Agent 的默认模型；PKCE 令牌未下发 `llm_config` 时生效 |

> **1.1.8 起，`defaultModel` / `cheapModel` 变为可选**：授权服务器可在令牌响应中下发 `llm_config`（模型、网关地址、API 协议等）。登录后这些运行时配置会优先于 `flavor.json` 中的 provider 连接与模型字段，详见下方 [PKCE 运行时配置管理](#pkce-运行时配置管理118)。

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

### PKCE 运行时配置管理（1.1.8）

1.1.8 起，flavor-code 支持由 OAuth 令牌**运行时下发**实际的 LLM 配置：模型、网关地址、API 协议和可用模型列表都可以随 PKCE 登录一并下发，项目文件不会被登录改写。

**工作原理：**

1. 授权服务器在 `/token` 响应中携带 `config_version` 和 `llm_config` 字段，后者包含 `provider_id`、`service_name`、`api_type`、`base_url`、`default_model`、`cheap_model`、`models` 和可选的 `max_output_tokens`
2. 令牌校验通过后，Flavor 在启动时加载该配置并生成一个**有效运行时 provider**，其优先级高于项目或全局 `flavor.json` 中的 provider 连接与模型字段；主 Agent、子 Agent、重试、权限分类、幻觉检查、记忆提取、上下文压缩、睡眠回顾和 goal 规划全部改用这份动态配置
3. 每次 SDK 请求使用运行时动态获取的 API Key（即 OAuth access token）和网关 baseURL；`/config` 只暴露脱敏后的有效配置视图
4. UI 的欢迎卡片同时展示 PKCE 服务名称与生效模型；Desktop 的模型列表优先展示 PKCE 令牌中的可用模型
5. 切换模型时校验合法性——只能选择 PKCE 令牌 `models` 列表内的模型

**登录后立即生效：**

```text
/login
```

显式执行 `/login` 会绕过有效缓存令牌，重新完成 PKCE 授权，并立即替换适配器、切换主/子 Agent 模型、更新 UI 状态，**无需重启**。

**会话恢复与兼容：**

- 恢复会话时，若已存储的模型 ID 与当前令牌的 `config_version` 不一致或模型已不在允许列表内，则该模型 ID 被忽略
- 令牌凭据身份由「令牌端点 + client ID」派生，不同 PKCE 服务互不冲突；旧版以 provider 名称存储的令牌会在启动时自动迁移
- `llm_config` 缺失的令牌保持旧版 OAuth 行为（使用 `flavor.json` 中的模型配置）

### 常见问题

**Q: 和直接用 API Key 有什么区别？**
从使用体验上几乎没有区别。从安全角度，你的终端从未持有真正的 LLM API Key——它拿到的只是一个 3 天过期的 JWT。即使 JWT 泄露，影响范围也有限（3 天、受 scope 约束、可被服务端撤销）。

**Q: 缓存过期了怎么办？**
flavor-code 默认在过期前 60 秒自动丢弃缓存，下次启动时自动重新弹出浏览器授权。你也可以手动删除 `~/.flavor-code/auth.json` 强制重新授权。

**Q: 如何搭建授权服务器和网关？**
参考 **flavor-pkce** 项目，提供了完整的 Docker Compose 部署方案（FastAPI + SQLite + JWT RS256），一键启动。

---

## 基本用法

### Electron 桌面端（1.1.0）

1.0.0 正式提供参考 Codex 交互方式设计的 Electron 桌面端。它不是简单套壳网页：Agent 运行时在 Electron 主进程中工作，桌面界面通过受控 IPC 与运行时通信，因此与 CLI 共享同一套工具、会话和配置能力。

桌面端已支持：

- 项目切换、新建会话、历史会话分组、恢复与安全删除
- 消息流式输出、Markdown、思考过程、工具调用、Diff 和子 Agent 状态展示
- 权限确认、Agent 提问、任务取消，以及模型和权限模式切换
- 顶部“完成任务”入口和右侧非阻塞式长期记忆确认栏
- 全部 `/` 命令，以及 Skills、Plugins、MCP、`/loop` 和 `/goal` 等现有运行时能力
- 可视化 Skill 工作台：项目 Skill 支持新建、查看、编辑、删除，所有来源均可按项目开启或关闭
- 可视化 MCP 工作台：项目服务支持 stdio / HTTP 配置、编辑、开启/关闭和安全删除
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
- NSIS 安装包：`release/Flavor-Code-1.2.3-x64.exe`

模型配置仍读取全局 `~/.flavor-code/flavor.json`、项目 `.flavor/flavor.json`、`.env` 和环境变量，因此 CLI 与桌面端可以共享配置与会话。生产版桌面窗口启用了 `contextIsolation` 和 Chromium 沙箱，关闭了渲染进程的 Node.js 集成；文件、命令和 Agent 操作只通过显式 IPC 接口进入主进程。Windows 的 `desktop:dev` 为兼容工作区内 Chromium 子进程启动，仅在本地开发启动器中使用 `--no-sandbox`，打包产物不携带该参数。

Electron 的模型菜单默认提供 `deepseek-v4-pro` 与 `deepseek-v4-flash`，也可以通过“新增”接入 OpenAI 兼容或 Anthropic 协议的其他厂商服务。新增时填写厂商名称、模型名称、Base URL 和 API Key；厂商与模型信息会同时写入全局 `~/.flavor-code/flavor.json` 和项目 `.flavor/flavor.json`，同名字段以项目配置为准。API Key 只写入全局配置并使用本机配置密钥加密，项目配置通过合并继承该密钥，避免明文密钥进入项目仓库。保存后桌面端会新建会话并切换到该模型。CLI 继续沿用通用的 `provider:model` 与现有配置优先级。

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

### 图片上传（多模态）

Flavor 1.1.1 支持将图片作为提示词的一部分发送给视觉模型，让你可以请 AI 帮忙分析 UI 截图、设计稿、错误日志截图等。

**CLI 终端：**

直接在输入框中 Ctrl+V（macOS 用 Cmd+V）粘贴剪贴板中的图片即可。Flavor 会自动检测剪贴板中的图像数据并作为附件包含在下一轮消息中。

- 支持 PNG、JPEG、WebP 格式
- 每张图片最大 5MB
- 每次最多附带 5 张
- 图片存储在 `.flavor/session-assets/` 下，SHA-256 去重
- 当前支持 Windows 和 macOS；Linux 暂不支持

**桌面端：**

在输入框上方通过文件选择器选择图片文件，或直接拖拽图片到输入区域。图片会随同 prompt 一起发送。

**限制：**

- 图片只能随新提示词发送，不能通过 steering/follow-up 追加
- 不能在使用斜杠命令（以 `/` 开头）时附带图片
- 不在子 Agent 的上下文中自动携带图片

### 恢复上次会话

```bash
flavor --resume                    # 恢复最近一次会话
flavor --resume session-20250101   # 恢复指定会话
flavor --resume -p "继续刚才的工作"  # 恢复后非交互执行
```

交互式 CLI 与 Electron 历史会话会恢复完整执行时间线。上下文压缩不会删除新格式会话的可见时间线；对于升级前已经压缩、原始步骤已不存在的会话，界面会显示压缩时间和保存的摘要，不会把摘要伪装成原始对话。`--resume -p` 只恢复模型上下文用于继续执行，不会把历史记录重新打印到标准输出。

### 长任务与上下文压缩

Flavor 的压缩是分层执行的：

1. **微压缩**：上下文接近阈值时，先把旧的工具结果替换为清理标记，保留最近 5 个
2. **完整压缩**：仍然超阈值时，调用模型生成结构化工作摘要，包含用户意图、技术决策、文件、错误、待办、当前工作和下一步
3. **反应式压缩**：模型返回 `context_overflow` 且无可见输出时，强制压缩并重试同一轮

压缩后摘要作为"续接消息"注入，保留系统指令、项目指南、任务状态和近期消息。输入 `/compact` 可手动触发。

---

## 长期记忆

Flavor 使用“任务级长期记忆”：交互式普通任务在 Agent 正常完成后自动评价，失败、取消、拒绝、斜杠命令和应用退出不会触发。CLI `/finish` 与 Electron 顶部“完成任务”保留为手工完成和失败重试入口，并与自动评价共享幂等校验，不会对同一任务重复调用模型。

另有一个用户主动保存的快捷入口：当提示中出现“记住”“帮我记住”“加入长期记忆”“please remember that”等明确表达时，当前回复结束后立即调用 cheap 模型，只分析用户明确要求保存的内容，不必等到 `/finish`，也不受 200 字符下限影响。“不要记住”“不用帮我记住”“别记”“无需保存到长期记忆”等否定表达不会触发。因为保存意图已经由用户明确给出，合格候选通过敏感信息检查和相似度查重后直接写入，不再重复弹出确认栏；`/remember` 仍走不调用模型的精确手工写入。

任务中的 user/assistant 可见文本不足 200 个 Unicode 字符时直接跳过，不产生额外 token；达到门槛后才调用配置的 cheap/subagent 模型。模型把候选归入 `user`（用户偏好）、`feedback`（行为反馈）、`project`（项目约定）或 `reference`（外部引用），并分别按“持久性、未来价值、来源权威性、是否难以从仓库重新推导”打 0–3 分。宿主只保留总分至少 9、且前三项都至少 2 分的最重要候选，每个任务最多 1 条；提取模型还被明确要求宁缺毋滥，常规操作、一次性任务细节、通用编程知识等一律不记。总分达到 `autoStoreThreshold`（默认 11）的高置信候选不再询问，直接写入并提示“已记住：…（`/forget` 可撤销）”；只有 9–10 分的候选才会进入确认栏。

如果 `flavor.json` 配置了 `language`（例如 `zh-CN`），候选摘要、正文和关键词使用该语言，代码标识符、命令、路径和 URL 保持原样。待确认候选只对当前交互有效：用户不处理候选而直接发送新的普通 query 时，旧候选全部作废并立即从 CLI/Electron 隐藏。

确认框也不会无休止打扰：候选默认带 5 秒倒计时（`reviewAutoDismissSeconds`，设 0 可关闭），超时未保存/未忽略会自动静默忽略，倒计时不作为“用户明确忽略”计入学习；连续忽略（CLI `Ctrl+N` 或 Electron 忽略按钮）累计达到 `ignoreStreakLimit`（默认 5）次后，自动评价自动暂停，之后的普通对话不再弹确认栏；暂停状态持久化在 `.flavor/memory/behavior.json`，重启后仍然生效。`/finish`、`/remember` 或显式“记住”成功保存一次即恢复自动提取。

对于自动评价或 `/finish` 产生的隐式候选，通过评分仍不等于写入。CLI 使用 `Ctrl+Y` 保存当前候选、`Ctrl+N` 忽略；Electron 在右侧非阻塞审阅栏逐条处理。用户接受后，宿主再使用规范化文本、单词和字符 n-gram/Jaccard 相似度做最终查重；只有没有同类高置信重复时才追加。密钥、Token、私钥、提示词注入、临时进度、原始工具输出和模型猜测会被拒绝。非交互模式不会运行隐式评价，但用户在输入中明确要求“记住”时仍可执行这条主动保存路径。

存储分为路由索引和正文：

```text
.flavor/memory/
├── MEMORY.md            # 摘要、类型、日期、正文路径、召回次数等路由信息
└── tasks/
    └── <task-id>.md     # 该任务确认保存的完整记忆正文
```

`user` 表示跨任务稳定生效的用户偏好。宿主会读取全部 `user` 正文，将其作为固定系统上下文的最后一段注入，并在该段设置 prompt-cache 断点；它不参与关键词召回。`feedback`、`project` 和 `reference` 仍在每个新任务提示到来时按短摘要做本地相关度排序，再读取最相关的任务文件。相关度综合单词 Jaccard、Unicode 字符三元组和关键词，默认最多召回 5 条，完整注入受 `maxPromptChars` 字符预算限制。一个按需记忆在同一任务中最多计一次召回。滚动 7 天内被 10 个以上不同任务召回会标为 `[hot]` 并小幅加权，超过 3 天未召回会标为 `[cold]` 并降权；标签只代表近期使用频率，不代表更正确或拥有更高权限。当前用户指令、系统规则、`FLAVOR.md` 和仓库证据始终优先。

Electron 左侧“长期记忆”工作台仍可按四种类型筛选、搜索、新建、编辑或删除记忆；`/remember` 和独立 CLI CRUD 属于用户主动写入，不经过模型评分。

交互会话中可以快速维护：

```text
/memory
/remember project 所有仓库脚本使用 pnpm
/remember feedback 不要自动提交代码
/forget pnpm
```

CLI 还提供适合终端和自动化脚本的精确 CRUD。先进入项目目录，再执行：

```bash
flavor memory list
flavor memory list --json
flavor memory add project "所有仓库脚本使用 pnpm"
flavor memory update <12位ID> feedback "不要自动提交代码"
flavor memory delete <12位ID>
flavor memory path
```

`list` 会输出后续更新和删除所需的稳定 ID；更新内容或类型后会生成新的 ID。`--json` 适合由脚本读取。

项目配置支持：

```json
{
  "memory": {
    "enabled": true,
    "autoExtract": true,
    "autoExtractMinChars": 200,
    "scoreThreshold": 9,
    "autoStoreThreshold": 11,
    "ignoreStreakLimit": 5,
    "reviewAutoDismissSeconds": 5,
    "maxCandidatesPerTask": 1,
    "retrievalTopK": 5,
    "maxEntries": 200,
    "maxEntryChars": 1000,
    "maxPromptChars": 12000
  }
}
```

存储更新使用文件锁、备份和原子替换。召回和去重全部在本地完成，不需要向量数据库，也不会为每次查询增加 embedding 调用；当前版本不包含跨设备同步或团队共享。

---

## 睡眠整理

当 Flavor 进程持续运行跨过本地零点时，如果项目配置了 `"sleep": true`，它会自动调用 cheap 模型回顾前一天的项目会话，并生成一份结构化的 Markdown 回顾报告。

### 配置

在 `.flavor/flavor.json` 中设置：

```json
{
  "sleep": true
}
```

默认值为 `false`。设为 `true` 后，进程启动即调度零点回调；如果目标日期没有任何 session，不会调用模型或写文件。不同项目的 Flavor 进程各自独立整理自己的 workspace。

### 报告内容

每份报告生成到 `.flavor/sleep/YYYY-MM-DD-摘要.md`，由宿主渲染 Markdown，模型只负责生成结构化 JSON。报告包含以下章节：

| 章节 | 说明 |
|------|------|
| 当天任务摘要 | 当天完成的主要工作 |
| 执行情况反思 | 工作方式的回顾和反思 |
| 📊 量化统计 | 工具调用分布、Token 消耗估算、人工干预统计 |
| 关键决策与收获 | 重要的技术决策和经验 |
| 🛡️ 质量与可信度 | 幻觉告警、失败与重试、代码变更概要、整体评估 |
| 🧠 知识沉淀 | 值得记住的技术发现、陷阱和模式 |
| 未决事项与风险 | 尚待解决的问题和潜在风险 |
| 明日可能规划 | 下一步的工作方向建议 |
| 涉及会话 | 被审查的所有 session ID 列表 |

报告由宿主渲染 Markdown，模型只负责生成结构化 JSON。文件名中的不安全字符会被规范化，长度最多 60 个中文字符。

### 并发安全

- 同一日期使用排他锁（`.lock` 文件），防止并发进程重复整理
- 报告通过临时文件 + `fsync` + `rename` 原子写入，不会出现半写文件
- 获取锁后会再次检查报告是否已存在，消除 TOCTOU 竞态
- 整理失败（模型错误、解析失败等）不会留下损坏的报告或永久锁文件，下一个零点的定时器保持调度

报告写入 `.flavor/sleep/` 目录，可随时手动查看或删除。

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
| `/memory` | 查看长期项目记忆及文件路径 |
| `/remember [user\|feedback\|project\|reference] <text>` | 保存一条长期记忆（默认 `project`） |
| `/forget <text-or-id>` | 删除匹配的长期记忆 |
| `/finish` | 完成当前任务，并在达到门槛时评价长期记忆候选 |
| `/compact` | 强制压缩上下文 |
| `/clear` | 清空终端显示 |
| `/mcp [status\|tools\|reconnect\|enable\|disable]` | 管理 MCP 服务器 |
| `/ide` | 查看 VS Code 连接、活动文件、光标和选区 |
| `/loop <goal>` | 启动经验证的前台自治循环 |
| `/goal <objective>` | 启动对抗性审查流水线（Plan → Execute → Verify） |
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

独立子任务会被分派给子 Agent **并行处理**：多个子 Agent 同时工作，每个使用独立的上下文窗口和便宜模型，完成后返回结构化结果。一次 DAG 调度中的子 Agent 从同一份父上下文快照 fork，只在末尾追加各自任务，因此可共享字节一致的缓存前缀；任何子 Agent 的后续消息和压缩都不会回写父会话。最大并行数由 `maxSubagents` 配置（默认 3，最大 16）。

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

桌面端点击侧栏“技能”可打开管理工作台。项目 Skill（`.flavor/skills/`）支持完整增删改查；全局和插件提供的 Skill 以只读方式展示，但仍可为当前项目开启或关闭。关闭后，自动匹配、显式调用和 Skill 资源读取都会拒绝该 Skill。状态保存在当前项目的 `.flavor/flavor.json`：

```json
{
  "skills": {
    "disabled": ["code-review"]
  }
}
```

CLI 与桌面端共享这套配置语义，并提供轻量的启停命令：

```bash
flavor skills list
flavor skills disable code-review
flavor skills enable code-review
```

---

## 插件

插件放在 `.flavor/plugins/` 下，可以注册自定义命令、工具、Hook、Skill 根目录等。插件命令可以直接通过 `/command-name` 调用。

> ⚠️ 插件是进程内运行的 Node.js 代码，不是沙箱隔离。请只加载你信任的插件。

### Agent 自注册工具与热加载

CLI 和桌面端都向主 Agent 提供三个管理工具：`RegisterTool`、`RemoveTool` 和 `ListRegisteredTools`。它们是 Agent 可调用的结构化工具，不是 `/registerTool` 斜杠命令。直接用自然语言说明要创建的持久能力即可，例如：

```text
创建一个项目级工具 EchoUpper，参数是字符串 text，返回它的大写形式；创建后马上调用它处理 "flavor code"。
```

Agent 会生成 JSON Schema 和 async JavaScript 实现，申请写入权限，然后调用 `RegisterTool`。注册成功后，无需重启或输入 `/reload`，同一次任务的下一次模型调用就能看到并调用 `EchoUpper`。项目工具保存在 `.flavor/tools/`；要求 `scope: "global"` 时保存在 `~/.flavor-code/tools/`，以后启动仍会加载。

工具实现接收三个变量：`input` 是已按 JSON Schema 校验的参数，`signal` 用于取消，`context` 包含 `workspace`、`scope` 和 `toolName`。`implementation` 既可以是必须显式 `return` 的函数体，也可以是完整的普通函数、async 函数或箭头函数表达式；这些形式都可以使用 `await import("node:...")`。等价的注册内容示例：

```json
{
  "name": "EchoUpper",
  "description": "Uppercase the provided text",
  "inputSchema": {
    "type": "object",
    "properties": { "text": { "type": "string" } },
    "required": ["text"],
    "additionalProperties": false
  },
  "implementation": "return { value: input.text.toUpperCase() };",
  "scope": "project",
  "agents": ["main"]
}
```

管理同样使用自然语言：

```text
列出你注册过的持久工具。
删除项目级 EchoUpper 工具。
```

注册是仅新增语义，不会覆盖已有工具。需要修改时，先用 `RemoveTool` 删除，再重新注册。删除只允许作用于这套机制创建的记录，不会删除内置、插件或 MCP 工具。Agent 也可能在长任务中发现明确、可复用的重复操作后建议自动创建工具，但一次性操作不应持久化；写入和删除仍经过正常权限确认。

> ⚠️ 自注册工具与普通插件一样，是进程内运行的可信 JavaScript，不是安全沙箱。确认注册前应审阅 Agent 展示的用途和权限请求；首次调用自定义工具也会按当前权限策略进行确认。

---

## 控制面、会话树与自动化

CLI 运行期间按 Enter 会保存一条待发送任务，显示在输入框上方，并在当前 SSE 完整结束后自动提交；待发送槽最多一条。按 Esc 会取消待发送并把内容回填输入框。运行中输入 `/steer <指令>` 可显式发送 steering。桌面端和 VS Code 继续使用普通发送进行 steering、`Alt+Enter` 排队 follow-up。Steering 不会打断正在传输的单次模型响应；它会在完整工具批次之后、下一次模型请求之前注入。CLI 内可用以下历史命令：

```text
/checkpoint [标签]     保存当前上下文和工作区
/tree                  查看追加式会话节点
/rewind <节点 ID>      恢复节点的文件、上下文和活动分支
/unrevert              撤销最近一次 rewind
/fork <节点 ID>        只移动上下文和分支，不修改文件
```

非交互调用可通过公开 SDK：

```ts
import { createFlavorRuntime } from "flavor-code/sdk";

const runtime = await createFlavorRuntime({
  workspace: process.cwd(),
  approvalPolicy: "deny",
  output: console.log,
});
await runtime.session.start();
await runtime.session.submit("修复测试");
await runtime.dispose();
```

其他语言和 IDE 可启动严格 JSONL 协议：

```bash
flavor --mode rpc --workspace . --trace .flavor/traces/run.jsonl
```

RPC 支持 `prompt`、`steer`、`follow_up`、`abort`、队列查询、checkpoint/tree/rewind/fork 和 `shutdown`。每行必须是单个 JSON 对象；输出也是逐行 response/event。

评测文件示例：

```json
{
  "name": "fix-parser",
  "workspace": "./fixture",
  "prompt": "Fix the parser",
  "verification": [{ "command": "npm", "args": ["test"], "timeoutMs": 120000 }],
  "maxTokens": 200000
}
```

```bash
flavor eval eval.json --output report.json
```

## Docker 沙箱

本地执行仍是默认行为。在项目 `.flavor/flavor.json` 中显式启用 Docker：

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

需要预先安装并启动 Docker。默认容器禁止网络、使用只读根文件系统、移除 capabilities，并限制进程数、内存和 CPU；工作区以 `/workspace` 绑定挂载。Docker 不可用时命令会失败并保持在沙箱模式，不会静默回退到本机。

## VS Code

从源码安装或更新扩展时，在仓库根目录运行一条命令即可。脚本会构建 CLI 和扩展、生成 VSIX、覆盖安装并核对版本：

```bash
npm run qoder:install   # 安装到 Qoder
npm run vscode:install  # 安装到 VS Code
npm run ide:install     # 自动优先选择 Qoder，其次 VS Code
```

IDE 已打开时，安装完成后执行一次 **Developer: Reload Window**。生成的 VSIX 会保留在 `release/flavor-code-vscode-<version>.vsix`。

扩展源码位于 `extensions/vscode`。仅做开发调试时可手动构建：

```bash
npm run build:cli
npm run vscode:build
npm link
```

在 VS Code 的 Extension Development Host 中加载该目录。扩展会在启动完成后注册一个仅监听 loopback、带随机令牌认证的 IDE bridge；从同一工作区启动的 `flavor` 会自动发现它。CLI 中运行 `/ide` 可查看活动文件、光标和选区，普通提示提交时也会自动附带这份最新编辑器上下文。终端底部右侧会实时显示 `In <文件名>`、`1 line selected` 或 `N lines selected`。

点击 Activity Bar 中的 Flavor 气泡可打开原生工作台：**Mission Control** 展示任务计划、子 Agent、工具、loop 与 token 状态，**Changes & Health** 聚合 Problems、Git 变更和 Agent 文件足迹，**Time Machine** 提供 checkpoint、rewind、fork 与 undo-rewind。扩展还注册 `@flavor` Chat Participant、诊断 Quick Fix、函数/类 CodeLens、Test Explorer 修复入口、代码导览和对抗性审查命令。从同一工作区终端手动启动的 `flavor` 会通过 IDE bridge v2 注册并把实时任务事件转发到 Mission Control；提示输入和取消操作仍由原终端负责。

执行 `Flavor: Start Agent` 仍可由扩展直接启动 RPC Agent；扩展同时支持对选区执行任务、修复 Problems 诊断、steering、follow-up、停止、checkpoint、查看树和 rewind。VS Code 发起的编辑任务默认先创建可恢复 checkpoint，可用 `flavorCode.autoCheckpoint` 关闭。若 `flavor` 不在 `PATH`，请配置 `flavorCode.executable` 为 CLI 的绝对路径。IDE bridge 不包含内联代码补全；补全需要单独的低延迟 completion 服务和 VS Code `InlineCompletionItemProvider`。

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
├── goal-plan.md       # /goal 生成的验收契约
├── sessions/          # 会话存档（v2 JSONL 格式）
│   └── session-xxx.jsonl
├── session-trees/     # 追加式会话分支和上下文节点
├── checkpoints/       # 内容寻址的工作区对象与 manifest
├── memory/            # 跨会话长期记忆
│   └── MEMORY.md
├── sleep/             # 睡眠整理每日报告
│   └── YYYY-MM-DD-摘要.md
├── audit.jsonl        # 工具失败审计日志
├── skills/            # 项目 Skill
└── plugins/           # 项目插件
```

---

## 安全须知

- AI 模型的输出不一定总是正确或安全的，请审查它生成的代码
- Skill 和插件中的内容应视为潜在不可信输入
- 本地模式中，被批准执行的 shell 命令以你的用户身份运行；不可信任务建议启用 Docker 模式
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

后续方向包括（这些是未来规划，非 1.1.0 已交付能力）：

- `/loop` 的后台恢复、调度与并发 loop 管理
- 长期记忆的全文/语义检索和质量整合
- 更细粒度的任务恢复与重放
- JetBrains 扩展
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
- **事故上报与 RCA（PostToolUseFailure → langgraph-claw → 自动根因分析）**
- **对抗性审查流水线（Plan → Execute → Skeptic Panel 多数投票 → 停滞检测熔断）**
- **多模态图片支持（剪贴板/文件选择器 → 验证存储 → Provider-Native 翻译 → 混合内容上下文管理）**
- 权限引擎决策树与 Shell 安全分析
- Hook 事件总线（19 个事件）
- Skill 渐进加载与资源安全
- 插件生命周期与信任模型
- 会话 JSONL 持久化与 v1/v2 兼容
- 安全威胁模型与缓解措施

---

## License

见 [LICENSE](./LICENSE) 文件。
