# flavor-code

`flavor-code` 是一个运行在终端里的 AI 编程助手。你可以在命令行里和它对话，让它帮你读代码、写代码、搜索文件、执行命令，就像和一个坐在你旁边的资深程序员结对编程一样。

它接入了大语言模型（比如 OpenAI 的 GPT 或 Anthropic 的 Claude），能理解你的项目结构，在工作区范围内安全地操作文件，甚至能把复杂任务拆成几块，分给多个"小助手"并行处理。

当前版本是 `0.1.0`。

---

## 它能做什么

用大白话说，Flavor 能帮你做这些事情：

- **阅读和理解代码** —— 你问它"这个函数是干什么的"，它会读文件然后告诉你
- **修改和创建文件** —— "帮我在 src 下新建一个 utils.ts"，它会写出来
- **搜索代码库** —— "项目里哪些地方调用了这个函数"，它用 ripgrep 帮你搜
- **运行命令** —— 在受控范围内执行 shell 命令，比如跑测试、装依赖
- **拆分复杂任务** —— 如果一个需求需要改好几个文件，它会先列出计划，然后按步骤推进，甚至并行执行独立的子任务
- **主动提问澄清** —— 当需求不明确时，它会列出选项让你选择，而不是自己瞎猜
- **进度面板** —— 终端里实时显示任务执行状态（哪些完成了、哪些在进行中）
- **记住上下文** —— 聊到一半退出，下次 `--resume` 回来继续；会话以高效的 JSONL 格式存储
- **持续完成长任务** —— 接近模型上下文上限时先回收旧工具输出，再生成结构化工作摘要；即使 provider 报告上下文溢出，也会压缩并续接当前任务
- **插件和 Skill** —— 通过插件扩展功能，通过 Skill（技能包）教它新的工作流
- **审计日志** —— 所有工具执行失败都会被记录到 `.flavor/audit.jsonl`，方便排查问题

---

## 安装

需要 Node.js 20 或更高版本。

### 从 npm 安装

```bash
npm install -g flavor-code
```

### 进入你的项目

```bash
cd your-project
flavor
```

首次使用时可以输入 `/init`，Flavor 会自动检测你的项目（语言、包管理器、源码目录、测试命令等），生成一个 `FLAVOR.md` 项目指南文件。

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

### 方式一：环境变量（最快捷）

**Windows PowerShell：**
```powershell
$env:OPENAI_API_KEY = "sk-你的密钥"
flavor
```

**macOS / Linux：**
```bash
export OPENAI_API_KEY="sk-你的密钥"
flavor
```

### 方式二：.env 文件

在项目根目录放一个 `.env` 文件（记得加入 `.gitignore`）：
```
OPENAI_API_KEY=sk-你的密钥
```

### 方式三：配置文件（最灵活）

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
  "permissionMode": "workspace",
  "language": "zh-CN",
  "maxIterations": {
    "main": 80,
    "subagent": 40,
    "softLimitFactor": 0.8,
    "extendBy": 20
  },
  "context": {
    "windowTokens": 200000,
    "reservedOutputTokens": 20000,
    "autoCompactBufferTokens": 13000,
    "warningBufferTokens": 20000,
    "blockingBufferTokens": 3000,
    "microcompactKeepRecentToolResults": 5,
    "recentTokens": 10000,
    "recentTextMessages": 5,
    "maxRecentTokens": 40000,
    "toolOutputChars": 30000
  }
}
```

这样主 Agent 用能力强的大模型，子 Agent 用便宜的小模型，兼顾效果和成本。`${OPENAI_API_KEY}` 会自动从环境变量或 `.env` 中取值。

`language` 设为 `"zh-CN"` 后 Flavor 会用简体中文回复（也支持 `en-US`、`ja-JP` 等 BCP47 标签）。`maxIterations` 控制 Agent 每轮对话的最大推理步数：主 Agent 默认 80 步、子 Agent 默认 40 步；在 80% 处发出预警；如果任务进度仍然活跃，到达上限后会自动扩展 20 步（最多扩展 3 次），避免长任务中途断掉。

`context` 控制长程上下文。默认 200K token 窗口先为输出预留 20K，再留出 13K 自动压缩缓冲，因此约在 167K token 触发完整压缩。`toolOutputChars` 是单次工具结果的头尾截断上限；`microcompactKeepRecentToolResults` 控制微压缩保留的最近工具结果数。旧配置中的 `compactAtChars` 仍可读取，但已弃用，新配置应使用 token 字段。

也支持 Anthropic（`"type": "anthropic"`）和任何兼容 OpenAI 接口的服务（`"type": "openai-compatible"`），比如本地部署的模型。

---

## 基本用法

### 交互模式

```bash
flavor
```

进入后直接打字聊天。比如：

- "这个项目的入口文件是什么"
- "帮我在 src/utils 下写一个日期格式化的函数"
- "把所有 console.log 替换成 logger.debug"
- "解释一下 src/config/load.ts 里的配置加载逻辑"

### 非交互模式（脚本调用）

```bash
flavor --print "列出 src/ 下所有导出了类的文件"
flavor -p "分析这个项目的依赖关系"
```

适合 CI/CD 或写脚本时使用。`--print` 不会等待用户确认，所有需要审批的操作默认拒绝。

### 恢复上次会话

```bash
flavor --resume                    # 恢复最近一次的会话
flavor --resume session-20250101   # 恢复指定 ID 的会话
flavor --resume -p "继续刚才的工作"  # 恢复后非交互执行
```

### 长任务与上下文压缩

Flavor 的压缩是分层执行的：

1. 上下文接近阈值时，先把旧的 Read、Shell、Grep、Glob、Edit、Write 等工具结果替换为清理标记，默认保留最近 5 个结果。
2. 如果仍然超过阈值，使用当前 Agent 模型发起一次无工具摘要请求，生成包含用户意图、技术决策、文件、错误、待办、当前工作和下一步的九段式摘要。
3. 摘要只在 `PreCompact`、模型调用和 `PostCompact` 全部成功后提交；失败或取消不会破坏原对话。自动压缩连续失败 3 次后会熔断，避免重复消耗 API。
4. 正常模型请求如果在尚未输出内容时返回 `context_overflow`，Flavor 会强制压缩并重试同一回合一次，不会重复追加用户消息或重复执行工具；若流式内容已经可见，则保留原始错误而不拼接一次新的响应。

压缩后 Flavor 会把摘要作为“上一段会话续接”消息注入，并保留当前 system 指令、`FLAVOR.md`、任务状态和近期完整消息。摘要和边界写入 v2 JSONL 会话，因此 `--resume` 后可直接继续。手动输入 `/compact` 会绕过自动熔断并立即尝试完整压缩。

当前没有移植 Claude Code 的服务器 cache editing、后台 Session Memory、文件/Skill 附件恢复和 partial compact UI；这些不影响本次长程任务核心链路。

---

## 内置命令

在交互模式下输入 `/` 开头的内容会触发命令：

| 命令 | 作用 |
|------|------|
| `/model main openai:gpt-5` | 切换主 Agent 模型 |
| `/model subagent openai:gpt-5-mini` | 切换子 Agent 模型 |
| `/permissions safe` | 设为安全模式（写入需确认） |
| `/permissions workspace` | 设为工作区模式（默认，推荐） |
| `/permissions full` | 设为宽松模式 |
| `/init` | 生成或更新 FLAVOR.md |
| `/config` | 查看当前配置（密钥已脱敏） |
| `/skills` | 列出已发现的 Skill |
| `/plugins` | 列出已加载的插件 |
| `/hooks` | 列出 Hook 状态 |
| `/tasks` | 显示当前任务计划与进度 |
| `/audit` | 查看工具失败审计日志（可选 `toolFilter`） |
| `/compact` | 强制生成结构化摘要并压缩当前上下文 |
| `/clear` | 清空终端显示 |
| `/help` | 显示帮助 |
| `/exit` | 退出 |

输入 `/` 后 Flavor 会弹出交互式菜单，列出所有可用命令（内置命令、插件命令、已安装的 Skill），输入关键词即时过滤。你还可以直接输入 `/<skill-name>` 来调用某个 Skill，或 `/<plugin-command>` 执行插件命令。

---

## 权限模式

为了安全，Flavor 有三个权限级别：

- **safe（安全）**：读文件自动放行；写文件和执行 shell 需要你确认
- **workspace（工作区，默认）**：工作区内的常规操作自动放行；越界访问、网络请求需要确认
- **full（宽松）**：放宽主 Agent 的大部分限制，但明确危险的操作（如删库命令）仍会被拦截

子 Agent（执行子任务的"小助手"）始终使用 workspace 模式，且不能再次委派任务。权限系统是纵深防御，但它不是操作系统级别的沙箱——被批准的命令仍然以你的用户权限运行。

---

## 和它协作的方式

### 计划与进度面板

当你提出一个涉及多个步骤的复杂需求时，Flavor 会先制定一个任务计划（`TaskPlan`），然后逐个推进。终端会显示实时任务进度面板：

```
── task progress ──
✓ 分析项目结构
⟳ 重构配置加载模块 (1.2s)
○ 更新测试用例
○ 更新文档
```

左侧图标随状态变化：○ 待执行、⟳ 执行中（计时）、✓ 完成、✗ 失败、⛔ 阻塞。Flavor 的迭代上限在检测到活跃进度时会自动扩展（最多 3 次），避免长任务中途中断。

### 主动提问

当你的需求有歧义或多条路可走时，Flavor 不会自己瞎猜——它会弹出结构化的选择题让你决定方向。这在非交互模式（`--print`）下会直接拒绝，避免悬挂。

### 子 Agent 并行

如果一个任务可以拆成互不依赖的几块（比如同时修改三个独立文件），Flavor 会创建子 Agent 并行处理。子 Agent 使用便宜模型、权限受限，完成后返回结构化结果。

### Skill（技能包）

Skill 是放在 `.flavor/skills/` 目录下的 Markdown 文件，用来教 Flavor 处理特定场景。比如你可以创建一个 `code-review` Skill：

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

当你提问时，Flavor 会自动匹配相关的 Skill 并加载其中的指导。你也可以直接输入 `/code-review` 来显式调用。

### 插件

插件放在 `.flavor/plugins/` 下，可以注册自定义命令、工具、Hook 等。插件命令也可以直接通过 `/command-name` 调用。插件是进程内运行的 Node.js 代码，所以只加载你信任的插件。

### 审计日志

每次工具执行失败都会被记录到 `.flavor/audit.jsonl`，包含时间戳、会话 ID、工具名、Agent 角色和错误信息。输入 `/audit` 查看汇总，`/audit Shell` 按工具名过滤。

---

## 项目结构

`FLAVOR.md` 是项目根目录下的指导文件，Flavor 每次对话都会读取它，以确保它了解你的项目约定。用 `/init` 命令自动生成，你也可以手动编辑标记区段之外的内容。

Flavor 相关的文件都放在 `.flavor/` 目录下：

- `.flavor/flavor.json` —— 项目级配置
- `.flavor/sessions/` —— 会话存档（v2 JSONL 格式，兼容读取 v1）
- `.flavor/audit.jsonl` —— 工具失败审计日志
- `.flavor/skills/` —— 项目 Skill
- `.flavor/plugins/` —— 项目插件

---

## 安全须知

请记住：

- AI 模型的输出不一定总是正确或安全的，请审查它生成的代码
- Skill 和插件中的内容应视为潜在不可信输入
- 被批准执行的 shell 命令以你的用户身份运行
- 不要把 `.flavor/sessions/` 中的会话文件当秘密仓库
- 建议在版本控制下使用、配置最小权限的 API Key、在可丢弃的工作区中实验

---

## 开发

```bash
npm ci              # 安装依赖
npm test            # 跑测试
npm run typecheck   # 类型检查
npm run build       # 构建
npm run smoke:install  # 验证打包和安装
```

---

## 路线图

后续方向包括 `/loop` 与 loop-engineering、后台 Session Memory、更细粒度的任务恢复与重放、IDE 集成、OAuth 与系统凭据存储、远程 Provider 登录、插件隔离/签名以及跨设备会话。这些是未来规划，不是当前 0.1.0 已交付的能力。
