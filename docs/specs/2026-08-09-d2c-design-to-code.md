# D2C：设计稿到代码（Design to Code）模块

## Goal

为 Electron 桌面端提供独立的 D2C 功能模块：导入 Pixso 导出的 HTML 设计稿，
在 Agent 按 `d2c-pixso` 技能指导生成前端实现（Vue 或 React，由用户选择）后，
**实际运行**该项目（自动安装依赖并启动 Vite dev server），对"设计稿渲染"与
"运行中的实现页面"做像素级差异评估，输出结构化差异报告（区域偏移量、色值偏差、
字体差异）、视觉还原度相似度评分，并在桌面端提供叠加对比视图（设计稿在底层、
实现在上层半透明叠加，标注各区域 px 偏移与色值对照）。

## Scope

MVP 包含：

- 纯逻辑差异引擎 `src/d2c/`：颜色计算、元素对齐、逐元素 diff、加权评分、报告装配。
- 两个桌面端专属 Agent 工具：`D2cImport`（导入 Pixso 导出目录并安装技能模板）、
  `D2cCompare`（必要时启动前端项目、渲染两侧页面、生成报告）。
- 前端项目运行器 `runner.ts`：识别 Vite 项目（package.json 含 vite 依赖）、
  缺 node_modules 时自动 `npm install`、直接拉起 `node node_modules/vite/bin/vite.js`
  dev server、从输出解析 localhost URL、fetch 探活就绪、对比完成后关闭进程。
  Vue 与 React 项目共用同一运行路径（均为 Vite 驱动）。
- 快照采集走注入式 `D2cCaptureService` 接口；桌面端提供 Electron 隐藏窗口实现，
  CLI 场景下工具明确报"仅桌面端支持"。
- 报告落盘 `.flavor/d2c/<task>/reports/<run-id>/`（report.json + 三张 PNG）。
- 桌面端新增 D2C 视图：报告列表、叠加/并排模式、不透明度滑块、SVG 标注层、问题列表。
- D2C 工作流技能（SOP）由用户自行导入；系统不生成、不写入任何技能文件。

MVP 不包含：

- Pixso API 直连、设计稿图层语义解析（只消费导出的 HTML）。
- 动画、交互态、多视口/响应式断点对比。
- CLI 终端下的渲染对比（无 Chromium 宿主）。
- 差异驱动的自动修复循环 UI（Agent 可凭报告文本自行迭代，不做专门编排）。

## Product behavior

D2C 是端到端模块（非单纯对比工具）：导入设计稿 → 选择框架编码 → 自动展示对比。

1. 用户打开桌面端侧栏的 D2C 视图，填写任务名并选择目标框架（Vue 3 或 React），
   点击"导入设计稿"：主进程弹出目录选择对话框，选中 Pixso 导出的 HTML 目录后
   校验并复制到 `.flavor/d2c/<task>/design/`、写 `manifest.json`（复用
   `importDesign`，与 `D2cImport` 工具同一条路径）。
2. 用户点击"开始实现"：渲染端组装任务 prompt（含 task、入口 HTML、所选框架）
   经 `submit` 投递给当前会话，Agent 依据用户自行导入的 D2C 技能（SOP）
   生成可运行的 Vite 项目并调用 `D2cCompare { task, implementation }`。
3. `D2cCompare` 的 implementation 支持前端项目目录（首选，自动装依赖+起
   dev server）、已启动服务的 `http(s)://` localhost URL、或本地 HTML 文件
   路径；工具完成两侧渲染快照、diff、评分，关闭自启的 dev server，
   写报告并推送 `d2c-report` 桌面事件。对比逻辑与框架无关。
4. 渲染端收到 `d2c-report` 事件后自动切换到 D2C 视图并刷新：叠加模式下
   设计稿在底、实现半透明在上，标注层绘制偏移尺寸线（`[---3px---]`）与
   色值对照块（设计 #xxx → 实际 #yyy），右侧问题列表按严重度排序，
   点击联动高亮。Agent 继续凭报告文本迭代修复直至达标。

## Architecture

### 差异引擎（src/d2c/，纯函数，无 Electron 依赖）

```
types.ts         D2cElementSnapshot / D2cPageSnapshot / D2cReport / 阈值常量
color.ts         hex/rgb 解析、sRGB→Lab、CIE76 ΔE
align.ts         元素对齐：文本签名精确匹配 → 剩余按标签/内容类型/IoU 综合匹配
diff.ts          几何、颜色、字体、文本和图片类型差异
score.ts         加权评分：layout 40% / color 30% / typography 15% / pixel 15%
report.ts        报告装配 + Agent 可读文本摘要（Top N 问题）
store.ts         .flavor/d2c 目录读写：manifest、报告列举、报告加载
skill-template.ts  D2C 工作流参考模板（Vue/React 两套项目 SOP）；仅供测试
                 校验文档化 SOP，系统不将其写入工作区（技能由用户自行导入）
runner.ts        前端项目运行器：装依赖/起 vite dev server/探活/关闭
tools.ts         createD2cTools(workspace, { capture? })
```

### 前端项目运行器（runner.ts，仅被 D2cCompare 使用）

`runFrontendProject(projectDir, options?): Promise<{ url, stop() }>`：

- 前置校验：目录经 `realpath` 后位于工作区内、含 `package.json`（devDependencies/dependencies
  含 vite）、`node_modules/vite/bin/vite.js` 存在或可安装。不区分 Vue/React，
  只要是 Vite 驱动的项目均可运行。
- `node_modules` 缺失时先执行 `npm install`（一次性子进程，等待退出，超时 8 分钟）。
- 显式 `spawn("node", [node_modules/vite/bin/vite.js, "--host", "127.0.0.1"])`，
  不使用 Electron 主进程的 `process.execPath`；stdout/stderr 合并缓冲解析
  `http://(localhost|127\.0\.0\.1):(\d+)` 得到 URL（vite 端口被占用时自动递增，
  故以输出解析为准）。
- 就绪判定：带单次请求超时地 fetch 该 URL 直至返回非 5xx，整体超时（默认 60 秒）
  或子进程提前退出则报错。
- `stop()`：SIGTERM → 3 秒宽限 → SIGKILL；`D2cCompare` 在 finally 中调用，
  确保异常路径也关闭服务器。工具的 `AbortSignal` 必须传递到依赖安装、探活、
  页面采集和像素对比；取消时立即进入同一清理路径。

评分定义：

- `S_layout = 1 − Σ(area_i·p_i)/Σ(area_i)`，`p_i = clamp(maxOffset/8, 0, 1)`，
  area 加权遍历匹配元素；缺失元素与裁剪到设计画布内的多余元素按面积占比以
  p=1 计入。
- `S_color = 1 − 色差面积/总面积`（匹配元素中 ΔE>3 的 color/backgroundColor）。
- `S_typography` = 含文本匹配元素中 font-size/weight/family 全一致占比。
- `S_pixel = 1 − pixelmatch 不一致像素占比`（两张截图 pad 到同尺寸后比较）。
- 总分四舍五入到 0.1；等级：≥95 像素级还原、≥90 优秀、≥80 合格、<80 需修复。

### 快照采集（注入式）

```ts
interface D2cCaptureService {
  capture(source: D2cCaptureSource, viewport?: { width: number; height: number }):
    Promise<CapturedPage>; // { width, height, elements, screenshotPng }
}
```

桌面端实现（`src/desktop/d2c-capture.ts`）：隐藏、无框、以内容区尺寸为准的
`BrowserWindow`（`nodeIntegration: false, contextIsolation: true, sandbox: true`），两段式——先按默认视口
测量页面自然尺寸（上限 4096），再按目标视口（实现页强制用设计稿尺寸）
注入采集脚本并 `capturePage()`。采集脚本只收录可见且有直接文本、图片或
非透明背景/边框的元素（面积 ≥ 16px²），降低包装节点噪声；采集前等待
`document.fonts.ready`、可见图片 `decode()` 并注入禁用动画/过渡样式。URL 来源仅允许
`http(s)://127.0.0.1|localhost`；文件来源必须位于工作区内。

像素比较在 worker thread 中执行。解码前后都校验尺寸，总像素上限为
8,388,608，避免压缩 PNG 解码膨胀；报告 IPC 同样拒绝超过上限的图片。

### 工具注入接缝

`ProductionRuntimeOptions` 新增 `extraTools?: readonly ToolDefinition<unknown>[]`，
并入 tools 数组（managed tool 冲突检查之后不再重复校验，命名冲突按现有
diagnostic 机制报告）。`RuntimeFactoryOptions` 的 Pick 同步扩展。桌面端在
`main.ts` 构造 controller 时传入 `createD2cTools(workspace, { capture })`。

### 桌面端 IPC

- channels：`d2cImport: "desktop:d2c-import"`、
  `d2cListReports: "desktop:d2c-list-reports"`、
  `d2cGetReport: "desktop:d2c-get-report"`。
- contracts：`D2cImportInputSchema { task }`，返回 `{ task, entryHtml, files }`
  或 `undefined`（用户取消选择）；`D2cGetReportInputSchema { task, reportId? }`；
  `FlavorDesktopApi` 增加 `importD2cDesign(task)` / `listD2cReports()` /
  `getD2cReport(task, reportId?)`；`DesktopEvent` 增加
  `{ type: "d2c-report", payload: { task, reportId, total, grade } }`。
- `d2cImport` 由主进程 handler 打开目录选择对话框（`openDirectory`），
  选中后经 controller 复用 `importDesign` 完成导入；目录校验逻辑与工具一致。
- 报告图片经主进程读取后以 data URL 返回，渲染进程不直接访问文件路径。

### 渲染端视图

`app.tsx` view 联合类型增加 `"d2c"`，侧栏入口命名 "D2C"；收到 `d2c-report`
事件时自动切换到 D2C 视图。`d2c-viewer.tsx` 包含：

- 启动面板：任务名输入、框架选择（Vue 3 / React）、导入设计稿按钮（经
  `importD2cDesign` 弹目录对话框）、"开始实现"按钮（组装 prompt 经 `onStartTask`
  投递到会话并切回对话视图）。
- 报告列表 → 画布（底图设计稿、上层实现图 opacity 可调、SVG 标注层）
  + 问题列表。标注：几何差异画设计稿矩形框与偏移尺寸线
  `[---{n}px---]`；颜色差异在区域旁渲染双色块与 `设计 #x → 实际 #y`。
- 报告保存导入时的设计 hash；若同任务后来重新导入，查看旧报告时显示“对应旧版本”提示。
- 只有消息提交成功才进入 pending；会话 busy 时禁止再次派发，提交失败、运行错误、
  中断或会话结束但没有报告时退出 pending。

### 目录结构

```
.flavor/d2c/<task>/
  manifest.json                      # 入口 HTML、文件列表、设计 hash、导入时间
  design/…                           # 导入的 Pixso 导出物
  reports/<run-id>/report.json|design.png|implementation.png|heatmap.png
```

## Security and limits

- 工具输入经 zod 校验；task 名限 `^[a-z0-9][a-z0-9-]{0,63}$`，reportId 限制为
  `run-YYYYMMDD-HHMMSS[-N]`；viewport 宽高必须同时提供；路径 `realpath` 后
  校验位于工作区内，符号链接逃逸拒绝。manifest/report JSON 读取后经 schema 校验。
- 隐藏窗口禁用 nodeIntegration；导航和重定向只允许初始本地文件或 localhost
  来源；`setWindowOpenHandler` 拒绝弹窗，阻止下载。
- 报告 data URL 只包含经过 PNG 签名、尺寸和像素上限校验的内容；report.json
  大小上限 2 MiB。
- 采集脚本为静态字符串常量，不接受用户输入拼接。
- runner 只执行两条固定命令：工作区内 `npm install` 与
  `node node_modules/vite/bin/vite.js`（路径经工作区内校验，不接受任意命令拼接）；
  对比结束（含异常路径）必须关闭自启的服务器进程。
- 设计导入和报告写入使用同父目录临时目录 + rename 发布；导入源不得与目标设计
  目录重叠。manifest 保存设计内容 hash，报告保存对应 hash，重导入后旧报告可识别。

## Acceptance criteria

1. 引擎单测：颜色解析/ΔE、文本与类型感知对齐、错误文本/图片类型差异、容差内
   不报差异、评分与等级、缺失/多余元素扣分、解码后像素上限与取消。
2. 工具单测：`D2cImport` 校验失败路径、复制与 manifest、不写入任何技能文件；
   `D2cCompare` 用 fake capture 完成端到端报告落盘；无 capture 服务时报
   "仅桌面端支持"；implementation 为前端项目目录时经注入式 runner 启动并关闭。
2a. runner 单测：显式 Node 启动、URL 解析、缺依赖时执行 npm install、dev server
   输出解析与带超时探活、stop 杀进程、AbortSignal、子进程 error 和超时/无 URL
   报错；另有真实 Electron/打包 smoke test 验证 Vite 可启动。
3. contracts 单测：D2C 输入 schema 拒绝非法 task/reportId；channel 白名单含
   三个 d2c 通道。
4. capture 单测/集成测试覆盖长页面、慢字体与图片、动画禁用、内容区 viewport、
   localhost 导航边界和弹窗拦截。
5. UI 测试覆盖 submit 失败不进入 pending、busy 时不错误派发，以及失败/取消后
   pending 可恢复。
6. `npm run typecheck`、`vitest run`、`npm run build`（含桌面端）全部通过。
7. 现有文本/多模态请求不受影响：extraTools 为空时工具列表与现状一致。
