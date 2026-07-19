# Claude Code Harness 体系 —— 给 Agent 套上缰绳

> Harness（缰绳）在 Agent 工程中的含义：**让大模型有能力做事，但不能乱来**。是通过多层约束框架，把一个聪明但不可控的模型变成可靠可预期的工程工具。

---

## 一、整体架构：六层递进防线

Claude Code 的 Harness 体系是一个**从软到硬、从提示到代码**的六层防线。每一层都有明确的"允许/拒绝/询问"三态输出，层层递进：

```
第 1 层：系统提示词层       （Prompt Harness）
         └──"你可以做什么、不可以做什么"的行为准则
         └── 最短、最软、最容易突破

第 2 层：工具系统层         （Tool Harness）
         └── 工具分类（只读/破坏性/并发安全）、工具白名单限制
         └── 模型只能调用被授权的工具

第 3 层：权限系统层         （Permission Harness）
         └── 多层决策管道：规则匹配 → 安全检查 → Hook 介入
         └── 精确到输入内容的权限控制

第 4 层：工作流管控层       （Workflow Harness）
         └── TaskPlan/TaskUpdate/TaskOutput 强制规划→执行→汇报
         └── Coordinator 模式的多 Agent 编排

第 5 层：工程化兜底层       （Resilience Harness）
         └── 重试、降级、超时、回退、熔断
         └── "尽量别死，实在不行就降级"

第 6 层：安全检查层         （Safety Harness）
         └── AI 分类器审查 + 路径遍历检测 + 危险目录保护
         └── 绕不过的硬限制
```

**关键设计原则**：先 deny 后 allow —— 拒绝规则永远在允许规则之前处理，保证"一票否决"。

---

## 二、第 1 层：系统提示词（Prompt Harness）

这是最基础的约束层——通过自然语言告诉模型"你是谁、你能做什么、你不能做什么"。

### 2.1 提示词的动态拼装

系统提示词不是写死的一段文字，而是**根据场景动态拼装**的。核心逻辑在 `src/utils/systemPrompt.ts`：

```
优先级从高到低：
  0. Override 提示词（loop 模式等特殊场景直接替换）
  1. Coordinator 提示词（多 Agent 编排模式）
  2. Agent 自定义提示词（用户定义的 Agent）
  3. Custom 提示词（用户通过 --system-prompt 指定）
  4. Default 标准提示词
```

### 2.2 核心行为约束

系统提示词中包含了大量的行为约束（位于 `src/constants/prompts.ts`）：

**"红线"规则（不可逾越）**：
- 不要顺手加功能、重构或改进没被要求的代码
- 不要为一次性操作创建辅助函数
- 三行重复代码好过一个过早的抽象
- 不要给时间估计

**"审慎"原则**：
- 本地、可逆的操作可以随意做
- 难以逆转的操作（删文件、force push、发 PR 评论）必须先问用户
- 用户批准了一次 ≠ 批准所有类似操作

**"工具纪律"**：
- 别用 Bash 做专用工具能做的事（读文件用 Read 不用 cat、搜索用 Grep 不用 grep）
- 独立工具调用并行发，有依赖关系的按顺序

### 2.3 子 Agent 行为收束

子 Agent（Fork agent）有更严格的行为约束：
- "不要对话、不要提问、不要建议下一步"
- "不要在工具调用之间输出文本，静默使用工具，最后一次性报告"
- "不要派生子 Agent（递归防护）"
- 输出必须用标准化格式：Scope → Result → Key files → Files changed → Issues

---

## 三、第 2 层：工具系统（Tool Harness）

### 3.1 工具的分类体系

每个工具都标记了自己的"危险等级"（`src/Tool.ts`）：

| 属性 | 含义 | 默认值（fail-closed） |
|------|------|----------------------|
| `isReadOnly()` | 是否只读 | `false`（假设有写入） |
| `isDestructive()` | 是否破坏性 | `false` |
| `isConcurrencySafe()` | 是否能并行执行 | `false`（假设不安全） |
| `isEnabled()` | 是否启用 | `true` |

**设计哲学**：默认拒绝（fail-closed）。不给属性赋值的时候，系统假设工具"不安全"。

### 3.2 工具白名单机制

不同类型的 Agent 有**不同级别的工具白名单**（`src/constants/tools.ts`）：

```
主线程 Agent：
  所有工具都可用

异步子 Agent（ASYNC_AGENT_ALLOWED_TOOLS）：
  ✅ Read、Grep、Glob、Bash、Edit、Write、WebSearch、WebFetch
  ✅ Skill、TodoWrite、NotebookEdit、ToolSearch
  ✅ EnterWorktree、ExitWorktree
  ❌ Agent（防止递归派生子 Agent）
  ❌ TaskOutput、ExitPlanMode（主线程抽象）

In-Process Teammate（额外允许）：
  ✅ TaskCreate、TaskUpdate、TaskList、TaskGet
  ✅ SendMessage（Agent 间通信）
  ✅ Cron（定时任务）

Coordinator 模式：
  ✅ Agent（派发任务）
  ✅ TaskStop、SendMessage、SyntheticOutput
  ❌ 所有其他工具（协作者本身不直接操作文件）
```

### 3.3 工具结果大小限制

防止单个工具结果"撑爆"上下文（`src/constants/toolLimits.ts`）：

| 限制 | 值 | 作用 |
|------|-----|------|
| 单个结果最大字符数 | 50,000 | 超出则持久化到磁盘 |
| 单消息所有结果总字符数 | 200,000 | 防止 N 个工具并行结果过大 |
| 结果最大 Token 数 | 100,000 | 系统级硬上限 |

### 3.4 工具输入校验

每个工具可以实现 `validateInput()` 方法，在工具执行**之前**校验参数合法性。校验失败会直接拒绝，不会走到权限检查。

---

## 四、第 3 层：权限系统（Permission Harness）

权限系统是 Harness 体系中最核心、最复杂的部分。它实现了精确到**输入内容级别**的权限控制。

### 4.1 五级决策管道

入口是 `hasPermissionsToUseTool`（`src/utils/permissions/permissions.ts`）：

```
步骤 1a: 工具级 deny 规则 → 直接拒绝
步骤 1b: 工具级 ask 规则   → 询问用户
步骤 1c: 工具自身的 checkPermissions → 按输入内容细粒度判断
步骤 1d: 工具实现层拒绝      → 直接拒绝
步骤 1e: requiresUserInteraction → 强制询问（绕过模式也挡不住）
步骤 1f: 内容级 ask 规则    → 按输入内容询问
步骤 1g: 安全检查（safety check）→ 绕不过的硬限制
步骤 2a: bypass 模式检查    → 白名单放行
步骤 2b: 工具级 allow 规则  → 直接允许
步骤 3:  默认 fallback      → 询问用户
步骤 4:   Auto Mode 分类器  → AI 二次研判
步骤 5:   PermissionRequest Hook → 外部系统介入
```

**关键设计**：
1. 先 deny 后 allow：拒绝优先
2. 每个步骤都可以短路：一旦某步给出确定性决定，后续步骤不再执行

### 4.2 六种权限模式

| 模式 | 含义 | 谁可以用 |
|------|------|---------|
| `default` | 标准模式，每个操作都判断 | 普通用户 |
| `acceptEdits` | 工作区内编辑自动放行 | 用户手动切换 |
| `plan` | 计划模式，只读 | 用户手动切换 |
| `bypassPermissions` | 跳过权限检查 | 高级用户 |
| `auto` | AI 分类器自动判断 | 内部特性 |
| `bubble` | 权限冒泡到父 Agent | Fork 子 Agent |

### 4.3 权限规则语法

规则精确到工具的具体输入参数：
```
Bash(git push:*)          → 允许 git push 开头的所有命令
Edit(.claude/skills/**)   → 允许编辑特定目录
mcp__github__*            → 允许 GitHub MCP 服务器的所有工具
```

### 4.4 规则来源的优先级

八种来源，各有独立的优先级和生命周期：

| 优先级（高→低） | 来源 | 说明 |
|----------------|------|------|
| 最高 | `policySettings` | 企业 IT 管理员下发，不可编辑 |
| ↑ | `flagSettings` | GrowthBook 远程开关 |
| | `userSettings` | 用户级全局配置 |
| | `projectSettings` | 项目级配置 |
| | `localSettings` | 本地配置（不提交） |
| | `cliArg` | 命令行参数 |
| | `command` | 技能/命令声明的工具 |
| 最低 | `session` | 运行时临时添加 |

### 4.5 安全检查：绕不过的最后防线

以下路径被标记为"安全检查"，**即使 bypassPermissions 模式也绕不开**：
- `.git/` 目录
- `.claude/` 配置目录
- `.vscode/` 和 shell 配置文件
- 路径遍历攻击检测

---

## 五、第 4 层：工作流管控（Workflow Harness）

### 5.1 规划→执行→汇报 强制流程

通过三个工具形成工作流闭环：

```
TaskPlan    → 先把任务拆成步骤，声明依赖关系
TaskUpdate  → 执行前标记 in_progress，完成后标记 completed
TaskOutput  → 汇报结果（改了哪些文件、跑了什么命令、验证结果）
```

约束规则：
- 同一时间只有 1 个 in_progress 任务
- 完成一个立即标记完成
- 必须完全验证通过才标记 completed

### 5.2 Agent 工具的子任务隔离

当主 Agent 需要并行处理复杂任务时，通过 `Agent` 工具派生子 Agent：

```
主 Agent                   子 Agent
  │                          │
  ├─ Agent(description, prompt) → 独立上下文
  │                          ├─ 独立执行工具
  │                          ├─ 标准化报告
  │                          └─ 自动清理
  │                          │
  └─ 收到 <task-notification>
     格式化的结果报告
```

子 Agent 的隔离措施：
- `setAppState` 是 no-op（不能修改父 Agent 的 UI 状态）
- 独立的 abortController（父 abort 传播给子）
- 独立的 denialTracking（拒绝计数器隔离）
- 克隆的 readFileState（文件缓存隔离）

### 5.3 Coordinator 模式

多 Agent 编排模式（`src/coordinator/coordinatorMode.ts`）：

```
用户提出复杂需求
        ↓
Coordinator（协作者）拆解任务
        ↓
   ┌────┼────┐
   ↓    ↓    ↓
Worker1 Worker2 Worker3（并行研究/实现/验证）
   ↓    ↓    ↓
   └────┼────┘
        ↓
Coordinator 综合结果，汇报用户
```

协作者的核心约束：
- 协作者本身不能操作文件（工具白名单只含 Agent/SendMessage/TaskStop）
- Worker 有完整工具集但无 Agent 工具（不能递归派生子 Agent）
- 协作者必须**理解 Worker 的返回结果**后再派发下一步——不能"基于你的发现修复"这种甩锅式 prompt

### 5.4 Fork Subagent 与缓存共享

Fork 模式让子 Agent 继承父 Agent 的完整上下文，同时通过字节级精确控制实现 Prompt Cache 共享：

```
父 Agent API 请求：
  [system_prompt] [context] [msgs...] [assistant with tool_uses]

三个 Fork 子 Agent：
  [system_prompt] [context] [msgs...] [assistant + 占位 result + directive_1]
  [system_prompt] [context] [msgs...] [assistant + 占位 result + directive_2]
  [system_prompt] [context] [msgs...] [assistant + 占位 result + directive_3]
                                              ↑ 前缀相同，三个子 Agent 都命中缓存！
```

---

## 六、第 5 层：工程化兜底（Resilience Harness）

这是让系统"在异常情况下不崩溃"的工程措施。

### 6.1 五大兜底策略

| 策略 | 核心思想 | 典型实现 |
|------|---------|---------|
| 配置兜底 | 层层回退 | 配置文件损坏 → 备份 + 默认值 |
| 重试机制 | 等一等再试 | 指数退避 + 抖动，最多 10 次 |
| 降级回退 | 换条路走 | 主模型 529 → 切 fallback 模型 |
| 超时保护 | 到点放弃 | 各层独立超时配置 |
| 错误兜底 | 吞掉不影响 | Best-Effort 静默跳过 |

### 6.2 API 重试引擎

核心在 `src/services/api/withRetry.ts`：

```
重试参数：
  - 最多重试：10 次
  - 退避公式：500ms × 2^attempt（上限 32s）+ 25% 随机抖动
  - 服务端 Retry-After 头优先

529（服务过载）特殊处理：
  - 前台任务：重试，连续 3 次 529 → FallbackTriggeredError → 切换备选模型
  - 后台任务（摘要、标题生成、分类器等）：直接放弃
    原因：后台重试会放大网关压力，用户也看不到这些失败

Fast Mode 逐级降级：
  限流（Retry-After < 20s）→ 等待后保留 Fast Mode 重试
  限流（Retry-After ≥ 20s）→ 触发 30 分钟冷却，降级到标准速度
  API 拒绝 Fast Mode（400） → 永久关闭 Fast Mode
```

### 6.3 模型回退

```
连续 3 次 529 → FallbackTriggeredError
  ↓
捕获异常 → 切换 model → fallbackModel
  ↓
清空签名块 → 重新发起查询（不消耗重试次数）
```

### 6.4 Token 溢出自动调整

```
API 返回 "input + max_tokens > context_limit"
  ↓
解析：inputTokens=188059, maxTokens=20000, contextLimit=200000
  ↓
availableContext = 200000 - 188059 - 1000(safetyBuffer) = 10941
  ↓
adjustedMaxTokens = max(FLOOR(3000), availableContext) = 10941
  ↓
下次重试生效
```

### 6.5 配置保护机制

- **文件锁**：防止多进程并发写配置
- **Auth-loss guard**：写入前检查不会丢失认证信息，如果会丢失就拒绝写入
- **时间戳备份**：每次写入前创建备份
- **防递归守卫**：配置读取失败 → 记日志 → 可能触发配置读取 → 无限递归。用 `insideGetConfig` 守卫打破循环

### 6.6 上下文压缩：解决"聊太多"问题

当对话接近模型上下文窗口上限时，自动触发压缩（`上下文压缩.md`）：

```
三层压缩策略：
  1. Microcompact（微压缩）
     → 只清理旧工具返回值（不调用 AI，最快）
  2. Session Memory Compact（会话记忆压缩）
     → 用品已有笔记替代旧对话（中等开销）
  3. Full Compact（完整压缩）
     → 调 AI 生成全局摘要（最重、最彻底）
```

压缩后的上下文重建（不丢失关键信息）：
- 最近访问的 5 个文件（总预算 50K tokens）重新注入
- 计划文件、会话笔记、技能附件恢复
- 后台 Agent 状态同步

---

## 七、第 6 层：安全检查（Safety Harness）

### 7.1 Auto Mode 分类器：用 AI 审查 AI

权限系统最独特的设计——用一个专门的模型调用来审查主模型的工具调用是否安全：

```
用户输入 → 主模型产出工具调用
                ↓
          分类器介入检查
                ↓
  ┌─────────┼─────────┐
  ↓         ↓         ↓
allow     ask       deny
（执行）  （询问用户）（阻止）
```

**分类器的输入构造**（防注入设计）：
- 助手的 text/thinking 内容**不传给分类器**（防止模型通过输出"无害文本"干扰判断）
- 每个工具调用被投影为紧凑表示（Bash 只传命令，Edit 只传路径）
- 可选 JSONL 格式：`{"Bash":"rm -rf /"}` 比纯文本更难注入

**两级分类器**：
- Stage 1（快速判断）：thinking disabled，低延迟
- Stage 2（深度思考）：thinking enabled，仅在 Stage 1 不确定时触发

**Fail-closed 策略**：
- 分类器失败/超时 → 默认阻止执行（fail-closed，而非 fail-open）
- 30 分钟内缓存失败状态，避免反复重试

### 7.2 拒绝追踪与自动回落

防止 "AI 审查 AI" 的死循环：

```
consecutiveDenials ≥ 3  → 分类器停止尝试，回落（fallback）到提示用户
totalDenials ≥ 20       → 同上

一次成功的 allow 会重置 consecutiveDenials = 0
但 totalDenials 不清零（防止"间歇性恶意"攻击）
```

### 7.3 路径安全检查

文件操作必须通过多层路径检查（`src/utils/permissions/filesystem.ts`）：

```
文件编辑路径检查流程：
  1. 匹配 allow 规则 → 放行
  2. 匹配 deny 规则  → 拒绝
  3. 危险目录检查（.git/.claude/.vscode 等）→ 强制询问（不可绕过）
  4. 危险文件检查（.gitconfig/.bashrc 等）→ 询问
  5. 路径遍历攻击检测 → 拒绝
  6. acceptEdits 模式 + 工作区内 → 放行
  7. 默认 → 询问
```

### 7.4 Hooks 系统：外部拦截点

Hooks 在关键生命周期节点提供外部介入能力（`src/types/hooks.ts`）：

```
可用 Hook 事件：
  - PreToolUse          → 工具调用前的最后一道检查
  - PostToolUse         → 工具调用后修改输出
  - PostToolUseFailure  → 工具调用失败后
  - PermissionRequest   → 权限决策的最后一环
  - PermissionDenied    → 权限被拒绝后
  - UserPromptSubmit    → 用户提交消息前
  - SessionStart        → 会话开始
  - SubagentStart       → 子 Agent 启动
  - Notification        → 系统通知
  - FileChanged         → 文件变更
```

Hook 可以返回三种决定：
- `allow`：放行，可选修改工具输入
- `deny`：阻止并给出原因
- `passthrough`：不做决定，继续后续流程

---

## 八、Harness 体系的模块索引

| 模块 | 核心文件 | 职责 |
|------|---------|------|
| 系统提示词 | `src/constants/prompts.ts`, `src/utils/systemPrompt.ts` | 行为准则的动态拼装 |
| 工具系统 | `src/Tool.ts`, `src/constants/tools.ts`, `src/constants/toolLimits.ts` | 工具定义、分类、白名单、大小限制 |
| 权限核心 | `src/utils/permissions/permissions.ts` | 五级决策管道 |
| 文件权限 | `src/utils/permissions/filesystem.ts` | 路径安全检查、内部路径白名单 |
| 分类器 | `src/utils/permissions/yoloClassifier.ts` | AI 审查 AI |
| 拒绝追踪 | `src/utils/permissions/denialTracking.ts` | 连续拒绝检测与回落 |
| 规则加载 | `src/utils/permissions/permissionsLoader.ts` | 磁盘加载和持久化 |
| 工作流管控 | `src/Task.ts`, `src/tools/TodoWriteTool/`, `src/tools/TaskOutputTool/` | 规划→执行→汇报 |
| 多 Agent | `src/coordinator/coordinatorMode.ts`, `src/tools/AgentTool/` | Coordinator + Worker 编排 |
| Fork 优化 | `src/utils/forkedAgent.ts`, `src/tools/AgentTool/forkSubagent.ts` | 零成本上下文克隆 |
| API 重试 | `src/services/api/withRetry.ts` | 指数退避 + 降级 + 回退 |
| 上下文压缩 | `src/services/compact/` | 三层压缩策略 |
| 配置安全 | `src/utils/config.ts` | 文件锁、auth 守卫、备份 |
| 环境变量 | `src/utils/envUtils.ts` | 多级回退链 |
| Hooks | `src/types/hooks.ts`, `src/utils/hooks/` | 外部生命周期拦截 |
| 沙箱 | `src/components/sandbox/` | Bash 沙箱隔离 |

---

## 九、设计哲学总结

Claude Code 的 Harness 体系体现了**四层递进的设计哲学**：

**第一层：引导（Guide）**
- 通过系统提示词告诉模型"怎样做是对的"
- 通过工具分类让模型知道"哪些是安全的"
- 最小化不需要的干预

**第二层：管控（Govern）**
- 权限管道确保每一次工具调用都有授权
- 工作流强制规划→执行→汇报
- "先 deny 后 allow"，一票否决

**第三层：兜底（Resilience）**
- 重试、降级、回退、超时保护
- 配置损坏自动恢复
- 上下文不够自动压缩
- "尽量别死，实在不行就降级"

**第四层：审查（Audit）**
- AI 分类器二次审查（用 AI 把关 AI）
- Hook 系统提供外部拦截
- 路径安全检查不可绕过
- Fail-closed：不确定就拒绝

**核心信条**：**不是限制能力，而是控制行为的边界**。大模型的能力应该被充分利用，但每一步操作都必须在可控范围内。这就是 Harness 的精髓——既有速度，又有刹车。

---

## 十、TODO：文档与实现差异跟踪

> 基于 2026-07-19 全量代码审查，按优先级分级。状态标记：🔴 未开始 / 🟡 进行中 / 🟢 已完成。

### P0 — 功能缺失 / 安全风险（应优先修复）

| # | 条目 | 层级 | 详情 | 关联文件 | 状态 |
|---|------|------|------|----------|------|
| P0-1 | **配置保护已补齐** | 第5层 | 已实现排他文件锁、锁内重读、存活 PID 检测、`.bak` 恢复、临时文件 + `fsync` + 原子替换。全局配置敏感字段和 OAuth Token Store 使用 AES-256-GCM 认证加密，并支持旧明文自动迁移、认证失败回退与主备均损坏时失败关闭。 | `src/config/protected-file.ts`、`src/config/secret-envelope.ts`、`src/config/load.ts`、`src/auth/store.ts` | 🟢 |
| P0-2 | **Hook 系统已实现但未集成到主循环** | 第6层 | `src/hooks/bus.ts` 的 `HookBus` 实现了完整的注册/分发/聚合机制，覆盖 20 个生命周期事件。但未在 `src/agent/loop.ts` 或等价核心流程中找到 `emit()` 调用，全部拦截点处于挂载但未激活状态。 | `src/hooks/bus.ts` → `src/agent/loop.ts` | 🔴 |

### P1 — 架构偏差 / 文档不一致（影响可维护性）

| # | 条目 | 层级 | 详情 | 关联文件 | 状态 |
|---|------|------|------|----------|------|
| P1-1 | **工具分类：集中式而非属性式** | 第2层 | 文档描述 `ToolDefinition` 上定义 `isReadOnly()`/`isDestructive()`/`isConcurrencySafe()`/`isEnabled()` 四个属性方法（fail-closed 默认值）。实际实现采用集中式分类：`engine.ts` 中 `READ_TOOLS`/`WRITE_TOOLS`/`DESTRUCTIVE_TOOLS` 等名称集合 + `isDestructiveTool()` 独立函数。两种设计各有优劣，但需同步文档或统一实现方向。 | `src/tools/types.ts` vs `src/permissions/engine.ts:15-31` | 🔴 |
| P1-2 | **六种权限模式已统一** | 第3层 | 已实现 `default`、`acceptEdits`、`plan`、`bypassPermissions`、`auto`、`bubble` 六种规范模式；旧 `safe`/`workspace`/`full` 配置自动迁移。`auto` 接入有界、脱敏的便宜模型分类器并在失败时回退正常审批，子 Agent 使用 `bubble` 将未决请求交给主会话审批。 | `src/config/schema.ts`、`src/permissions/engine.ts`、`src/permissions/classifier.ts`、`src/tools/runtime.ts`、`src/harness/local.ts` | 🟢 |
| P1-3 | **提示词优先级拼装未实现** | 第1层 | 文档描述五级优先级覆盖：Override → Coordinator → Agent 自定义 → Custom → Default。实际 `src/prompts/system.ts` 的 `buildSystemPrompt()` 采用固定线性顺序组装（identity → security → doingTasks → actions → tools → tone → role → environment），无任何覆盖机制。 | `src/prompts/system.ts` | 🔴 |
| P1-4 | **模块索引文件路径与实际不匹配** | 全局 | 文档第八章"模块索引"引用 `src/constants/prompts.ts`、`src/utils/systemPrompt.ts`、`src/Tool.ts`、`src/constants/tools.ts`、`src/utils/permissions/permissions.ts` 等路径，实际项目结构为 `src/prompts/system.ts`、`src/tools/types.ts`、`src/permissions/engine.ts` 等。 | 第八章全部 | 🔴 |

### P2 — 改进建议（非阻塞）

| # | 条目 | 层级 | 详情 | 关联文件 | 状态 |
|---|------|------|------|----------|------|
| P2-1 | **模型回退仅在 AgentLoop 层** | 第5层 | `ModelRegistry` 是纯 key-value 映射，无原生 per-provider 回退链。fallback 逻辑硬编码在 `src/agent/loop.ts:149-153`。不支持根据错误码动态选择不同 provider。 | `src/models/registry.ts` | 🔴 |
| P2-2 | **权限管道阶段边界不清晰** | 第3层 | 文档描述 8 个命名阶段（deny→ask→checkPermissions→实现层拒绝→safety check→bypass→allow→fallback）。实际 `checkPermissions` 不是独立决策阶段（仅通过 `tool.permissions()` 注入元数据），bypass 逻辑分散在三处（CONTROL_TOOLS 放行 + `alwaysAllowed` 缓存 + `full` 模式放宽），缺少统一 bypass 入口。 | `src/permissions/engine.ts` | 🔴 |
| P2-3 | **子Agent 汇报格式与文档差异** | 第1层 | 文档要求子Agent输出格式 `Scope → Result → Key files → Files changed → Issues`；实际 `roleSection('subagent')` 要求 `changed → findings → verification → blocker`。 | `src/prompts/system.ts:153-158` | 🔴 |
| P2-4 | **TodoWrite 与 TaskPlan 并行可能导致状态不一致** | 第4层 | `TodoWrite`（轻量级步骤追踪）和 `TaskPlan`（结构化任务计划）均支持 `in_progress` 状态标记且各自独立维护"同一时间只有 1 个 in_progress"约束，双重标记可能偏离。 | `src/tools/todo-write.ts` + `src/agent/task-plan.ts` | 🔴 |
| P2-5 | **缺少 isConcurrencySafe 标注** | 第2层 | 集中式分类系统中无并发安全标注，所有工具被隐式视为并发不安全。但 `Read`/`Glob`/`Grep`/`LspFindRefs` 等只读工具理论上可安全并行执行，缺少标注阻止了并行优化。 | `src/permissions/engine.ts` | 🔴 |
| P2-6 | **缺少 isEnabled 运行时开关** | 第2层 | 无法在运行时动态禁用单一工具（只能通过 `replaceMainTools` 批量替换整个工具集）。 | `src/tools/runtime.ts` | 🔴 |
| P2-7 | **子Agent 缺少"静默执行"和"不提问"约束** | 第1层 | 文档 §2.3 描述子Agent应"不要在工具调用之间输出文本"和"不要对话、不要提问、不要建议下一步"。实际 `roleSection('subagent')` 仅包含"自包含"和"递归防护"，未明确限制工具调用间的文本输出。 | `src/prompts/system.ts:153-158` | 🔴 |
| P2-8 | **危险目录保护未区分 bypass 模式** | 第3层 | 文档 §4.5 描述 `.git/`、`.claude/`、`.vscode/` 等路径"即使 bypassPermissions 模式也绕不开"。实际实现中 `classifyPath()` 对所有模式统一拒绝路径逃逸，但未明确区分"无论如何都绕不开"和"normal 模式绕不开"。 | `src/permissions/engine.ts:227-243` | 🔴 |

### 已完成项

| # | 条目 | 详情 | 完成日期 |
|---|------|------|----------|
| P0-1 | 配置保护与认证存储加固 | 文件锁、原子写、备份恢复、AES-256-GCM 认证加密及明文迁移 | 2026-07-19 |
| P1-2 | 六种权限模式统一 | 规范模式、旧配置迁移、auto 分类器与 bubble 审批冒泡 | 2026-07-19 |
