# D2C 人工审阅与接口联调

## 目标

在现有 Pixso → Vite → 视觉评测链路上增加可恢复的人工验收和接口联调阶段：

1. 首次视觉评测后停止自动修复，进入人工审阅。
2. 支持逐条或批量通过、退回；退回项可附加要求并触发局部 AI 修复。
3. 所有有效差异均通过后导入 Swagger 2.0 或 OpenAPI 3.x JSON。
4. 自动匹配页面模块与接口出入参；低置信结果留给用户在面板中确认。
5. 生成统一 Axios client、绑定计划和可启动的 Express mock server。

## 非目标

- 不修改历史 `report.json`；评测报告继续作为不可变证据。
- 不执行 Swagger 中的任意脚本，也不解析远程 `$ref`。
- 不把真实凭证写入生成源码。

## 状态模型

任务状态写入 `.flavor/d2c/<task>/workflow.json`，采用原子替换和单任务写锁。

```text
visual-review -> api-mapping -> integrating -> interaction-review -> completed
      ^               |                         |       |
      |--- repair ----|                         | auto + manual
                                                | failed / withdrawn
```

- 每个问题由 `pageId + fingerprint` 标识。
- 决策为 `pending | accepted | needs-fix`。
- 新报告到达时，同 fingerprint 且问题签名未变化的 accepted 决策可继承；已消失问题视为已解决。
- `invalid` 报告不能进入接口阶段。
- 没有差异或所有当前差异 accepted 后进入 `api-mapping`。

## 模块级修复

新生成项目必须包含 `d2c.modules.json`，每个模块声明稳定 id、标签和源码文件。组件根节点使用
`data-d2c-module`。采集器把最近模块边界写入元素快照和报告。

修复提示词包含：问题证据、用户要求、模块 id 和允许修改的源码文件。没有模块元数据时回退为
页面级模块并明确列出输出项目目录，兼容旧任务。修复后仍执行整页视觉评测，以发现布局回归。

## OpenAPI 归一化与匹配

- 接受 UTF-8 JSON，最大 8 MiB。
- 支持 Swagger 2.0、OpenAPI 3.0/3.1 和文档内 JSON Pointer `$ref`。
- 归一化 method、path、operationId、tags、参数、request body、2xx response 和示例。
- 根据模块 id/label/keywords/dataNeeds/actions 与 operationId/tags/summary/path 进行确定性打分。
- 高置信且第一、第二候选有明显间隔时自动确认；其余标记 `needs-confirmation`。
- 用户确认结果持久化，不依赖临时 Agent 问答。

## 生成物

写入 `src/d2c-output/<task>/`：

```text
src/api/http.js                 # Axios instance 与统一错误模型
src/api/d2c-api.js              # operation 封装
src/api/d2c-bindings.json       # 模块/接口/字段绑定
mock/server.mjs                 # Express mock server
```

同时安全合并项目 `package.json` 的 `axios`、`express` 和 `mock` script。随后由 Agent 根据绑定计划将
模块接入 API；生成文件可重复执行且结果稳定。

## Mock 生命周期

- 仅绑定 `127.0.0.1`，使用动态端口。
- 启动前按需安装项目依赖，探测 `/_d2c/health`。
- 重复启动返回现有实例；停止幂等。
- 切换工作区或退出桌面应用时终止进程树。

## 右侧面板

右侧保持现有质量检查器视觉语言，增加两个阶段 tab：`视觉审阅`、`接口联调`。

- 审阅顶部显示待审/通过/退回计数和批量动作。
- 每张问题卡展示状态、证据、通过、退回并修复、补充要求。
- 接口 tab 在视觉审阅完成前锁定并说明原因。
- 导入后展示模块、候选 operation、置信度、字段摘要和确认控件。
- 生成后提供 Mock 启停、地址复制和“开始联调”动作。

## 验证

- 纯函数：状态迁移、继承规则、OpenAPI 解析、引用解析、匹配、示例生成、代码生成。
- 存储：损坏文件恢复、并发更新、原子写入、路径约束和大小限制。
- IPC：输入边界、未知字段、任务/报告/operation id 校验。
- Renderer：批量/逐条动作、锁定状态、空状态、invalid 状态和首次评测即暂停提示词。
- Runner：端口、启动、重复启动、停止、超时、提前退出和清理。
- 回归：D2C 全套测试、桌面测试、typecheck、build、mock smoke。

## 可交互联调验收

联调完成的交付物不能只有截图或 API 文件。生成绑定后，Flavor Code 同时保持 Express mock 与生成的
Vite 项目运行在 loopback 地址，并把联调主画布切换为 Electron 内可操作的实时页面；同时提供在外部
浏览器打开同一地址的兜底入口。

Pixso 导出目录可携带 `interaction-manifest.json`。Flavor Code 校验该文件，在实时实现上执行
click/fill/hover/key 场景，检查可见结果并记录 XHR/fetch 请求。页面完全没有真实 API 请求时，不能把
静态交互误判为联调通过。自动化结果和独立的人工验收决定写入 `workflow.json`；只有自动交互检查通过
且用户标记人工验收完成后，任务才进入 `completed`。

安全约束：

- 预览与测试导航只能停留在生成项目的 loopback origin。
- 内嵌页面使用 iframe，不能访问 Electron preload bridge。
- 禁止弹窗、webview、远程 frame origin 和非 loopback 预览 URL。
- 切换工作区或退出应用时同时终止预览与 mock 进程树。

自动验收只统计发往当前任务 Express mock origin 的 XHR/fetch；Vite 资源、HMR、图片和其他请求不计入 API 调用证据。
