# 子 Agent 字节级提示词缓存设计

## 目标

Flavor 0.8.0 在创建子 Agent 时，不再重新生成一套与主 Agent 不同的上下文。每批 Task 执行先冻结一次父 Agent 的模型可见上下文；每个子 Agent 从该冻结点创建独立副本，并只在末尾追加自己的执行 directive。这样，同批子 Agent 的静态前缀在角色、内容、顺序和 UTF-8 字节上完全一致。

## 行为规格

1. `ContextManager.fork()` 返回新的 `ContextManager`，不得共享可变消息数组、压缩状态或 usage 计数器。
2. fork 后、追加新消息前，父上下文与子上下文的模型可见消息在 `role`、`content`、工具调用数据和顺序上相同；缓存元数据不参与提示词文本。
3. 动态 system prompt 在 fork 时解析一次并冻结，避免后续模型、权限或任务状态变化改写已共享前缀。
4. 已存在的 compact summary 和近期消息保持原有顺序；子上下文仍可独立微压缩或完整压缩。
5. 一次 Task DAG 执行只捕获一个父前缀。并行兄弟节点、依赖后续节点及重试均从同一冻结点 fork。
6. 子 Agent 的角色约束、任务描述、预期输出、验证方式与修复提示合并为 fork 后的第一个新 user 消息。不得把子 Agent 角色段插入共享 system 或历史消息中间。
7. fork 边界携带提供商无关的 `cacheBreakpoint` 元数据。Anthropic 适配器把它映射为最后一个共享 content block 上的 `cache_control: { type: "ephemeral" }`；OpenAI 适配器忽略该元数据，依赖 Automatic Prompt Caching 的精确前缀匹配。
8. 父 Agent 与子 Agent 的 `ContextManager`、工具运行时和权限仍然隔离；子 Agent 仍不获得 `Task` 工具，不能递归委派。

## 提供商边界

- Anthropic 的缓存层次是 `tools → system → messages`。工具定义变化会使 system 和 messages 缓存失效；因此主/子工具集不同时，不能承诺主请求直接命中子请求缓存。显式 fork 断点主要保证使用相同子工具集的兄弟节点、后续依赖节点和重试能够共享父历史前缀。
- Anthropic 并发请求只有在首个响应开始后才能读取刚写入的缓存；同时启动的首批兄弟节点可能各自写缓存，后续节点仍可命中。
- OpenAI 只对完全相同的 prompt 前缀命中缓存，图片和工具也必须一致；符合条件的请求由服务端自动缓存。Flavor 不向任意 OpenAI-compatible 服务发送只被部分模型接受的显式断点字段。
- 两家提供商都有最小可缓存 token 门槛；短上下文保持行为正确，但不保证产生计费层面的缓存命中。

## TDD 验收

- 上下文单测先证明：fork 前缀的 UTF-8 序列一致、动态 system 被冻结、父子追加/压缩互不影响、断点固定在最后一个继承消息上。
- Harness 单测先证明：每次子上下文工厂都收到父上下文；显式传入的批次父上下文会被复用。
- Adapter 单测先证明：Anthropic 能在 system、普通文本和工具结果边界输出合法 `cache_control`，且不改变未标记请求的既有形状；OpenAI 输入文本不包含缓存元数据。
- 生产集成测试证明：同一 DAG 的兄弟节点收到相同前缀，只在最后的任务 directive 处分叉。
- 最终通过 `npm test`、`npm run typecheck` 与 `npm run build`。

