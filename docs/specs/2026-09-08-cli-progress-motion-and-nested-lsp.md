# CLI 双轨进度、持续动作与嵌套项目 LSP 规格

## 背景与目标

Flavor CLI 当前把主任务计划与子 Agent 状态串成一个纵向列表。子 Agent 在计划较长时会落到面板底部，用户无法同时观察主线与探索进度。模型开始输出正文后，`Flavoring` 活动行又会立即消失，长内容或大型工具参数生成期间缺少持续反馈。LSP 则只在 Flavor 工作区根目录检查项目标记文件，并且 TypeScript 服务未登记 JavaScript 扩展名，导致 macOS 上常见的嵌套 sandbox/monorepo 文件误报无项目或无语言服务。

本版本交付三个可验证结果：

1. 同时存在主任务与子 Agent 时，宽终端将它们呈现为左侧 `task plan`、右侧 `subagent exploration` 的双轨面板；任一侧单独存在时占满整行。窄终端回落为纵向分区，避免每列窄到不可读。
2. 模型流式输出正文时，活动行保持在最新输出之后并由 `Flavoring` 切换为 `Writing response`；模型结束、工具开始、取消或完成时仍按原有生命周期移除。动画沿用终端 spinner，不新增干扰性装饰。
3. LSP 从目标文件目录向上、但不越出工作区寻找最近的语言项目根；连接按“语言 + 项目根”隔离复用。TypeScript LSP 同时支持 `.js/.jsx/.mjs/.cjs`，并发送正确的文档 language id。

## 交互与布局

宽终端（至少 72 列）：

```text
── task plan ───────────────────  ── subagent exploration ─────────
⠋ Implementing feature… (12s)    · subagent: Inspect API · running
· Run tests · pending             ✓ subagent: Audit types · done
```

只有一类工作时：

```text
── task plan ───────────────────────────────────────────────────────
⠋ Implementing feature… (12s)
```

小于 72 列且两类都存在时，先显示 task plan，再显示 subagent exploration；两者共享原有滚动视口和鼠标滚动行为。颜色、字形和状态语义保持现状，双轨只改变信息结构。

## 行为契约

- 双轨面板的主任务与子 Agent 均从各自第一项开始显示，不能因为主任务数量较多而把子 Agent 推到滚动区域末尾。
- 面板不裁掉数据；超出视口的项目仍可通过既有 ScrollBox 浏览。
- `text` 流事件不得结束模型活动计时；活动行移动到最新文本之后并显示 `Writing response`，且连续文本增量仍合并为一个有界文本块。
- `model-end`、`tool-start`、`done` 和异常/取消边界继续清理模型活动行。
- LSP 项目根选择最近的祖先标记文件；不得选择工作区之外的标记文件。
- 同一语言的不同嵌套项目不得错误共享以另一项目为根初始化的连接。
- TypeScript/JavaScript 文件继续使用随包分发的 TypeScript LSP，不增加外部依赖。
- LSP manager 销毁时必须等待服务进程真正关闭，不能让其 cwd 短暂锁住嵌套项目目录。

## TDD 验收

- UI 渲染测试覆盖双轨同一行、单轨满宽语义和窄终端回落。
- transcript reducer 测试覆盖长正文输出期间动作行保留、更新、置底，以及连续文本块合并。
- LSP 单元/集成测试覆盖嵌套 `tsconfig`、最近根选择、工作区边界、`.cjs` 诊断和进程关闭后的目录清理。
- 通过目标测试、全量 `npm test`、`npm run typecheck`、`npm run build` 与 `npm run vscode:typecheck`。
