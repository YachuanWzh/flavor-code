# D2C 嵌入式交互自动化与多模态质量门

## 目标

在现有“视觉审阅 → 接口联调 → 自动/人工交互验收”之后增加最终质量门：

1. 自动化直接操作 Electron D2C 工作台中已经启动并展示的联调页面，不创建第二个浏览器或隐藏窗口。
2. 同时评估表单交互质量和视觉还原度；确定性测试、静态视觉报告与多模态 LLM Judge 共同形成结论。
3. 提供独立的 Judge 模型配置入口，支持 OpenAI 兼容与 Anthropic 多模态接口，并预留 Base URL、API Key、模型和通过阈值。
4. 所有运行时、IPC、配置与 UI 接线均限定在 Electron 桌面端；CLI 的工具集合、会话流程和模型选择保持不变。
5. Judge 通过后任务才能进入 `completed`。

## 为什么不直接使用 Playwright 接管现有 Electron

Playwright 的公开 API 支持由 Playwright 启动 Electron，或通过 CDP 连接 Chromium；它没有受支持的 API
把已运行 Electron 主窗口里的既有 `iframe/WebContents` 转换成 Playwright `Page`。开启远程调试端口再从应用
内部回连会扩大攻击面，并且仍依赖非稳定的 Electron target 发现行为。

本实现采用 Electron 原生的 Playwright-style adapter：

- 通过主窗口 `webContents.mainFrame.framesInSubtree` 按受控 loopback origin 定位 D2C iframe 的 `WebFrameMain`。
- 在同一个 frame 中执行 click/fill/hover/key 与轮询断言。
- 每个 scenario 通过更新现有 iframe 的 `src` 重置，不创建新窗口。
- 通过 `webContents.capturePage(iframeRect)` 截取用户当前看到的联调画布。
- 仍复用纯函数 `runInteractionManifest`，因此交互契约与结果结构不分叉。

如果内嵌 frame 不存在、不可见或 URL 不属于当前 controller 管理的 preview origin，测试立即失败；不静默
降级到外部浏览器，以免用户误以为验收的是同一个页面。

## 工作流

```text
visual-review -> api-mapping -> integrating -> interaction-review
                                                | auto passed + manual accepted
                                                v
                                           quality-judge
                                                | pass
                                                v
                                            completed
```

- 自动交互或人工验收发生变化时，旧 Judge 结果失效。
- 只有自动交互通过且人工验收为 accepted 才允许运行 Judge。
- Judge fail 保持 `quality-judge`，显示可执行问题；重新联调后再次运行。
- Judge pass 才进入 `completed`。
- 旧 workflow 没有 Judge 字段时仍可读取，但不能被误认为满足新的最终质量门。

## 质量评分

Judge 输入包含：

- 设计稿 PNG。
- 同一 Electron 内嵌联调页的当前 PNG；运行前导航到当前报告页面的初始 URL，避免表单提交后的临时状态污染视觉评分。
- 静态 D2C 分项得分、可信度和 Top issues。
- 自动 interaction scenarios、失败信息、耗时和真实 API 请求数。

模型返回 `visualScore`、`interactionScore`、confidence、summary 与结构化 issues。最终综合分由本地确定性计算，
不信任模型自行给出的总分：

```text
overall = 40% * LLM visual
        + 30% * LLM interaction
        + 20% * static D2C score
        + 10% * deterministic interaction result
```

硬门槛：自动交互必须通过、不得存在模型标记的 critical issue、综合分必须达到配置阈值（默认 80）。

## 模型配置与安全

桌面端配置：

```ts
interface D2cJudgeConfigInput {
  protocol: "openai-compatible" | "anthropic";
  baseURL: string;
  apiKey: string;
  model: string;
  passThreshold: number; // 0..100, default 80
}
```

- 渲染端只能读取 `{ configured, protocol, baseURL, model, passThreshold }`，永不回读 API Key。
- 配置写到桌面用户数据目录，复用 Flavor Code 的本机 secret-envelope 加密能力。
- 请求只在用户点击“运行 AI 质量评审”时发送。
- 日志、workflow、报告和错误文本不得包含 API Key 或 Authorization header。
- Base URL 只允许 HTTP(S)，禁止凭证、fragment 与其他协议。

## 存储

- Judge 配置：Electron userData 下 `d2c-judge.json`（加密文档）。
- Judge 结果：`.flavor/d2c/<task>/quality-judge.json`，不包含密钥和原始模型响应。
- workflow 只保存当前结构化 Judge 结果，旧结果在交互状态变化时清除。

## UI

接口联调面板新增“最终质量门”：

- 未配置：展示配置表单。
- 交互未完成：说明必须先完成自动与人工验收。
- 可运行：显示模型、阈值和“运行 AI 质量评审”。
- 运行后：显示视觉分、交互分、综合分、置信度、结论和问题列表。
- Judge pass 后展示“质量门通过”，任务才显示完成。

## TDD 验收

1. 纯函数：Judge 响应解析、综合评分、critical/阈值硬门槛、prompt 不含密钥。
2. 工作流：auto/manual → quality-judge；Judge pass → completed；交互变化使旧 Judge 失效。
3. 嵌入式驱动：定位受控 frame、拒绝外部 origin、复用 iframe、不创建 BrowserWindow、捕获 iframe rect。
4. 配置：合法协议/Base URL/阈值；加密存储；读取结果不暴露 API Key。
5. 控制器：缺 preview、缺配置、交互未通过时拒绝；成功结果落盘并推进状态。
6. IPC/preload：严格 schema、新 channel 完整接线，API Key 不出现在读取响应。
7. Renderer：配置入口、运行按钮、分项得分、失败问题和最终门状态。
8. 回归：D2C 专项、desktop 专项、typecheck、build、pixel worker smoke；CLI 生产测试保持通过。
