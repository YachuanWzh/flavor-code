# flavor-code

`flavor-code` 是一个面向本地代码库的终端编程 Agent MVP：用统一的模型适配层连接 OpenAI、Anthropic 或 OpenAI-compatible 服务，在工作区权限边界内读写文件、搜索、执行命令，并把可拆分工作交给受限的子 Agent。它强调可审计配置、结构化 Hook/任务结果、渐进加载 Skill，以及显式的会话恢复。

当前版本是 `0.1.0`。它已经具备交互界面、非交互打印、工具权限、插件/Skill、主任务规划、任务 DAG、上下文压缩与本地恢复；还不是 IDE 产品，也没有 OAuth 登录、远程会话同步或插件进程沙箱。

## 安装与快速开始

需要 Node.js 20 或更高版本（CI 覆盖 20 和 24）。

```bash
npm install -g flavor-code
cd your-project
flavor --version
flavor
```

也可在源码仓库运行：

```bash
npm ci
npm run build
node dist/cli.js
```

首次进入项目后执行 `/init`，Flavor 会检查项目结构并创建或更新 `FLAVOR.md` 中由标记包围的自动生成区段，同时确保 `.flavor/sessions/` 被忽略。

## 环境变量与配置

Windows PowerShell：

```powershell
$env:OPENAI_API_KEY = "your-key"
$env:ANTHROPIC_API_KEY = "your-key"
flavor
```

macOS/Linux：

```bash
export OPENAI_API_KEY="your-key"
export ANTHROPIC_API_KEY="your-key"
flavor
```

也可复制 `.env.example` 为项目根目录的 `.env`。不要提交 `.env`。配置优先级从低到高为：`~/.flavor-code/flavor.json`、项目 `.flavor/flavor.json`、调用方 CLI 覆盖；`${NAME}` 插值使用进程环境与项目 `.env`，其中 `.env` 的同名值优先。当前公开 CLI 尚未提供逐字段配置参数，因此通常使用 JSON 配置。

完整的 `.flavor/flavor.json` 示例：

```json
{
  "providers": {
    "openai": {
      "type": "openai",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "${OPENAI_API_KEY}",
      "defaultModel": "gpt-5",
      "cheapModel": "gpt-5-mini"
    },
    "local": {
      "type": "openai-compatible",
      "baseURL": "http://127.0.0.1:1234/v1",
      "apiKey": "local-placeholder",
      "defaultModel": "large-model",
      "cheapModel": "small-model"
    }
  },
  "agents": {
    "main": { "model": "openai:gpt-5" },
    "subagent": { "model": "openai:gpt-5-mini" }
  },
  "maxSubagents": 3,
  "permissionMode": "workspace",
  "context": {
    "compactAtChars": 240000,
    "toolOutputChars": 30000
  }
}
```

模型 ID 始终是 `provider:model`。主 Agent 使用 `agents.main.model`；`Task` DAG 的子 Agent 使用 `agents.subagent.model`，且子 Agent 工具列表移除 `Task`、`TaskPlan` 和 `TaskUpdate`，避免递归委派或修改主计划。未显式指定时，官方 provider 可提供默认主/廉价模型；自定义 provider 必须明确给出 `defaultModel` 与 `cheapModel`，系统不会悄悄让子 Agent复用昂贵主模型。

## 交互命令与 CLI

内置 slash 命令如下：

- `/model <main|subagent> <provider:model>`：切换对应角色模型。
- `/permissions <safe|workspace|full>`：切换主 Agent 权限模式；子 Agent 始终受工作区约束。
- `/init`：生成或更新 `FLAVOR.md`。
- `/config`：显示合并后的脱敏配置、来源与诊断。
- `/skills`、`/plugins`、`/hooks`、`/tasks`：显示发现或运行状态。
- `/compact`：按当前阈值尝试压缩旧上下文。
- `/clear`：清空终端展示（不等同于删除持久化会话）。
- `/help`：显示帮助。
- `/exit`：退出。
- `/<plugin-command> [args...]`：执行已加载插件声明并注册的动态命令。

脚本调用：

```bash
flavor --print "解释 src/config/load.ts 的配置优先级"
flavor -p "列出风险最高的三个模块"
```

无密钥时进程仍可启动，并给出如何配置 provider 的错误；`--print` 不会等待交互审批，所有需要询问的操作按拒绝处理。

## 任务规划与进度

复杂请求包含至少三个实现或验证步骤、多个独立修改，或需要非平凡协调时，主 Agent 会先通过 `TaskPlan` 创建计划，再用 `TaskUpdate` 即时更新步骤状态。简单问答和单步操作不会为了展示而强制创建计划。

计划状态包括 `pending`、`in_progress`、`completed`、`failed`、`blocked` 和 `cancelled`。同一时间只允许一个主任务处于 `in_progress`；现有 `Task` DAG 仍可并发运行多个子 Agent。交互终端为主任务显示一个带耗时的动态状态行，并在完成、失败或取消时原位替换为静态结果；并行子任务显示在其下方，但不会同时争用前台 spinner。

`/tasks` 会同时显示主计划与子 Agent DAG。计划会随会话保存并注入后续模型上下文；恢复会话时遗留的主 `in_progress` 任务归一为 `cancelled`，遗留的子 Agent `running` 状态继续按依赖归一。执行过程中按 Ctrl+C 会中止当前操作，并把仍在运行的主计划步骤标记为 `cancelled`。

## 权限模式

- `safe`：读取可自动允许；写入和大多数 shell/network 操作需要确认。
- `workspace`（默认）：工作区内的常规读写和例行命令可自动允许；越界读写、包装 shell、网络等需要确认。
- `full`：放宽主 Agent 的常规操作，但明确识别的高风险命令仍可被拒绝，路径遍历和符号链接逃逸也不会被放行。

子 Agent 固定使用 `workspace` 权限：不得调用 `Task`，破坏性命令拒绝，shell 必须有工作区内 `cwd`；非例行或不透明操作不会自动执行。权限引擎是纵深防御，不是操作系统沙箱。

## Hook

Hook 事件版本为 1：`SessionStart`、`UserPromptSubmit`、`Stop`、`SessionEnd`、`BeforePlan`、`AfterPlan`、`SubagentStart`、`SubagentStop`、`BeforeModelCall`、`AfterModelCall`、`PreToolUse`、`PermissionRequest`、`PostToolUse`、`PostToolUseFailure`、`PreCompact`、`PostCompact`、`PluginLoad`、`PluginUnload`、`Notification`。

处理器返回 `{ decision: "allow" | "deny" | "ask", reason?, updatedInput?, additionalContext? }`。总线按注册顺序合并决定；拒绝会终止对应边界，`ask` 进入权限审批语义，部分前置事件允许受校验的 `updatedInput`。处理器可配置超时与 `error/allow/deny/ask` 失败策略。插件可通过 `registerHook` 注册 JavaScript 处理器；Hook 不是绕过权限引擎的通道。

## 插件

项目插件位于 `.flavor/plugins/<name>/`，全局插件位于 `~/.flavor-code/plugins/<name>/`。同名时项目级优先于 npm，再优先于全局。每个插件必须有严格的 `flavor-plugin.json`：

```json
{
  "name": "taste",
  "version": "1.0.0",
  "apiVersion": "1",
  "main": "index.mjs",
  "permissions": ["filesystem:read"],
  "contributes": {
    "commands": [{ "name": "taste" }],
    "tools": [],
    "hooks": [{ "name": "Notification" }],
    "skillRoots": [{ "name": "taste-skills", "path": "skills" }],
    "modelAdapters": []
  }
}
```

```js
// .flavor/plugins/taste/index.mjs
export function activate(ctx) {
  const remove = ctx.registerCommand("taste", (args) => ({ ingredients: args }));
  ctx.logger.info("taste activated");
  return () => remove();
}
```

Host 会校验 manifest、入口包含关系和文件身份，限制激活/卸载时间，并反向释放注册项。重要边界：插件在 MVP 中是受信任的进程内 Node.js 代码，窄 API 与 manifest 权限不是进程沙箱；只安装和启用你信任的插件。

## Skill 与渐进加载

Skill 放在全局 `~/.flavor-code/skills/<name>/SKILL.md` 或项目 `.flavor/skills/<name>/SKILL.md`；项目同名 Skill 覆盖全局版本。最小格式：

```markdown
---
name: dependency-audit
description: Audit JavaScript dependencies and lockfiles
---

# Dependency audit

先读取 package.json；需要规则明细时读取 `references/policy.md`。
```

目录可包含 `assets/`、`references/`、`scripts/`。启动只发现有大小上限的元数据；提示词匹配后才加载正文；正文明确引用的资源再通过 `SkillResource` 按需读取。资源读取检查目录包含、符号链接、文件身份和大小；`scripts/` 内容只作为数据返回，绝不会由 `SkillResource` 自动执行。

## FLAVOR.md 与初始化

项目根 `FLAVOR.md` 是固定注入的项目指导。`/init` 检测语言、包管理器、源码目录、测试/构建命令和已有 Agent 指令文件，只替换 `<!-- flavor-code:start -->` 与 `<!-- flavor-code:end -->` 之间的托管区段，保留人工内容。恢复旧会话时仍以当前磁盘上的系统提示和 `FLAVOR.md` 为准。

## 会话保存与恢复

会话默认保存到当前工作区 `.flavor/sessions/<session-id>.json`。保存内容包括规范化主对话、压缩摘要、任务图/状态/结构化结果、主/子模型 ID、权限模式、时间戳和工作区身份；不会保存 provider 配置、API key 或授权 header，凭据形态内容会被删除或脱敏。写入使用同目录临时文件、同步和原子重命名；读取有大小上限并拒绝目录逃逸/符号链接。损坏或不兼容文件会被隔离。

恢复必须显式请求，绝不自动加载：

```bash
flavor --resume                 # 当前工作区最近更新的会话
flavor --resume session-id      # 指定会话
flavor --resume -p "继续检查"   # 恢复后非交互运行
```

恢复会保留当前系统/`FLAVOR.md`，只恢复 provider 可接受的对话轮次；遗留 `running` 任务按依赖确定性归一为 `pending` 或 `failed`。会话版本、工作区或已保存模型与当前配置不兼容时会报出可操作错误。

## 安全边界

请把模型输出、仓库文本、Hook、Skill 和插件都视为潜在不可信输入。核心文件工具做真实路径与符号链接检查，搜索遵守 ignore 规则并限制输出，shell 使用参数化执行、超时/输出上限、取消和危险命令分类；会话不应成为秘密仓库。尽管如此，MVP 不是容器、VM 或强隔离沙箱：主进程、被批准的 shell、provider SDK 与受信插件仍具有宿主进程能力。建议在版本控制、最小权限凭据和可丢弃工作区中使用。

## 开发、测试与打包

```bash
npm ci
npm test
npm run typecheck
npm run build
npm run smoke:install
npm pack --dry-run
```

`smoke:install` 会执行 `npm pack --json`，在临时 npm prefix 全局安装，跨平台定位 `flavor`/`flavor.cmd`，离线验证 `--version` 和 `--help`，最后删除临时目录与 tarball。发布包 allow-list 只包含 `dist/`、README、技术报告与 LICENSE，不包含源码测试、`.env` 或会话文件。

## 路线图

后续方向包括 IDE 集成、更细粒度的任务恢复/重放、OAuth 与系统凭据存储、远程 provider 登录、插件隔离/签名和跨设备会话。以上均为路线图，不是 `0.1.0` 已交付能力。
