# Claude 风格长程上下文压缩设计

## 目标

让 Flavor Code 在长程编码任务中接近上下文窗口时，能够主动回收低价值内容、生成可继续执行的结构化摘要，并在 provider 报告上下文溢出时自动恢复，而不是终止任务。

本次设计以 `C:\Users\wangzh\Desktop\资料\AI\claude-code-rev` 的上下文压缩机制为参照，适配 Flavor Code 现有的 `ContextManager`、`AgentLoop`、模型适配器、Hook 和 JSONL 会话持久化架构。它同时为后续 `/loop` 和 loop-engineering 提供稳定的长程状态续接基础，但不实现 `/loop` 本身。

## 范围

本次实现包含：

- 基于 token 窗口、摘要输出预留和安全缓冲的自动压缩阈值。
- 在没有 provider 精确 usage 时使用保守估算，在获得 usage 后优先使用最近一次输入 token 数。
- 压缩前清理旧的、可回收的工具结果，并保留最近 5 个工具结果。
- 使用当前 Agent 模型执行一次无工具的结构化摘要请求。
- Claude Code 风格的九段摘要，明确保留用户意图、技术决策、文件、错误、待办、当前工作和紧接着的下一步。
- 去除摘要响应中的 `<analysis>` 草稿，只持久化 `<summary>` 内容。
- 将摘要包装为可直接续接工作的 user 消息语义，同时保留固定 system、`FLAVOR.md` 和最新任务状态。
- 按完整 API 回合选择压缩边界，避免切断 assistant tool call 与 tool result。
- 摘要请求发生 context overflow 时，从最旧完整回合开始裁剪输入并重试，最多 3 次。
- 正常模型调用发生 context overflow 时强制压缩并重试当前回合。
- 自动压缩连续失败 3 次后熔断；手动 `/compact` 不受熔断限制。
- 压缩摘要、边界元数据和剩余消息随 JSONL 会话保存，并能在 `--resume` 后恢复。
- 更新 `README.md` 和 `技术方案报告.md`。

本次不包含：

- Anthropic 内部 cache editing 或 fork prompt-cache 协议。
- 后台 Session Memory 提取 Agent。
- 图片、文档、最近读取文件和 Skill 附件恢复。
- UI 选区驱动的 partial compact。
- `/loop` 命令与 loop-engineering 调度器。

## 方案选择

采用“分层压缩核心适配”方案，而不是逐文件移植 `claude-code-rev`。Flavor 的消息类型和 provider 抽象更小，直接移植会引入不存在的 cache、附件、thinking block 和内部实验开关。核心语义保持一致：轻量回收优先、完整摘要兜底、溢出时响应式恢复、失败熔断、压缩后直接续接。

不采用仅替换摘要提示词的最小方案，因为它仍然以字符阈值触发、无法响应 provider 溢出，也不能显著提升长程任务可靠性。

不采用本次同时新增 Session Memory 的完整方案，因为它需要后台提取生命周期、独立持久化格式和调度资源，会与未来 `/loop` 的运行状态设计耦合。该层应在 loop-engineering 状态模型确定后单独设计。

## 架构

### 上下文策略模块

新增聚焦于压缩策略的模块，负责：

- 根据配置计算有效窗口和自动压缩阈值。
- 计算 warning、auto compact 和 blocking 状态。
- 按工具调用关系识别可清理的旧 tool result。
- 按完整 user/API 回合分组，选择安全保留区和摘要输入。
- 构造与解析结构化摘要提示词。

`ContextManager` 继续拥有消息与摘要状态，但不再内嵌所有策略细节。

### 模型摘要器

生产组合根为每个 ContextManager 注入摘要函数。摘要函数通过相应 Agent 的当前模型和现有 `ModelRegistry` 发起请求，工具列表为空，输出只接受文本。主 Agent 切换模型后，后续摘要使用新模型；子 Agent 使用自己的模型。

摘要器最多执行 3 次 prompt-too-long 恢复尝试。每次失败都按完整回合删除最旧的一组摘要输入，不能留下孤立 tool result。非 context overflow 错误立即返回。

### AgentLoop 集成

每轮调用前：

1. ContextManager 根据最近一次 provider input usage 或保守估算判断压力。
2. 达到回收压力时先执行微压缩。
3. 仍达到自动阈值时执行完整压缩。
4. 构造正常模型请求。

每轮调用后保存该次 input token usage，供下一轮判断使用。

如果正常请求返回 `context_overflow`，AgentLoop 请求一次强制完整压缩并重试同一轮。该重试不能重复追加用户消息，也不能重复提交工具结果。若无法压缩或压缩失败，则返回原始 provider 错误。

### 会话恢复

压缩摘要使用独立的 compact boundary 数据，而不是伪装成普通历史 system 指令。发送给模型时，ContextManager 将其渲染为 Claude Code 风格的续接 user 消息；保存时保留摘要正文和元数据。恢复时只接受 schema 合法的边界，并继续过滤孤立 tool result。

会话格式升级时保留 v1 读取兼容，新写入使用新版格式。升级不能持久化 API key、动态 system prompt 或隐藏推理。

## 配置

`context` 配置从字符阈值扩展为 token 策略，默认值与 Claude Code 核心常量对齐：

- `windowTokens`: 200000。
- `reservedOutputTokens`: 20000。
- `autoCompactBufferTokens`: 13000。
- `warningBufferTokens`: 20000。
- `blockingBufferTokens`: 3000。
- `microcompactKeepRecentToolResults`: 5。
- `recentTokens`: 10000，用于完整压缩后保留近期消息的目标值。
- `recentTextMessages`: 5。
- `maxRecentTokens`: 40000。

继续读取旧的 `compactAtChars`，将其转换为 token 阈值以保持配置兼容；文档不再推荐该字段。`toolOutputChars` 仍负责单次工具结果进入上下文时的头尾截断，与后续微压缩互补。

## 摘要结构

摘要提示明确禁止工具调用并要求一次性返回文本，包含：

1. Primary Request and Intent。
2. Key Technical Concepts。
3. Files and Code Sections。
4. Errors and Fixes。
5. Problem Solving。
6. All User Messages。
7. Pending Tasks。
8. Current Work。
9. Optional Next Step。

第 9 节必须引用最近用户请求或最近工作原文，避免长程任务在多次压缩后发生目标漂移。解析器移除 `<analysis>`，优先提取 `<summary>`；没有标签但包含非空文本时可作为兼容结果，空文本视为失败。

## 错误与熔断

- PreCompact 拒绝时不修改上下文。
- 摘要、PostCompact 或取消失败时采用事务语义，原消息和原摘要保持不变。
- 自动压缩失败计数只在自动路径累计，成功后清零，达到 3 次后当前 ContextManager 不再主动发起完整压缩。
- `/compact` 强制尝试并绕过自动熔断，但仍遵守取消信号和事务语义。
- provider context overflow 触发响应式压缩；同一模型回合只允许一次响应式恢复，避免循环。
- 微压缩只替换已完成工具调用的旧结果，不清除最近 5 个，也不修改 toolCallId。

## 测试策略

按 TDD 覆盖以下行为：

- token 阈值和旧字符配置兼容。
- 微压缩只清除允许工具的旧结果并保留最近 5 个。
- 保留区满足 token、文本消息和最大 token 约束。
- 所有切割点维持 tool call/result 配对。
- 摘要提示包含九段结构和禁止工具要求。
- `<analysis>` 被去除，`<summary>` 被正确提取。
- 自动压缩、手动压缩和连续失败熔断。
- 摘要 context overflow 的按回合重试上限。
- 普通模型请求 context overflow 后压缩并重试一次。
- 压缩失败、Hook 失败和取消时上下文不变。
- 新版会话保存、恢复和 v1 兼容读取。
- 完整单元测试、类型检查和生产构建。

## 完成标准

- 长对话可以在接近默认 200K token 窗口前自动压缩。
- 压缩确实调用模型生成结构化摘要，而不是拼接并截取历史文本。
- provider context overflow 不会立即终止可恢复的长程任务。
- 多次压缩后仍保留当前任务状态、明确待办和最近工作原文。
- `/compact`、自动压缩、会话保存和 `--resume` 使用同一套边界语义。
- README 和技术报告准确区分已实现能力与未实现的 Session Memory、cache editing、附件恢复、partial compact 和 `/loop`。
