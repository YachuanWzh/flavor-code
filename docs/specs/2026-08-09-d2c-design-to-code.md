# D2C：设计稿到代码（Design to Code）模块

## Goal

为 Electron 桌面端提供独立的 D2C 功能模块：导入 Pixso 导出的 HTML 设计稿，
在 Agent 按 `d2c-pixso` 技能指导生成 Vue 实现后，对"设计稿渲染"与"实现渲染"
做像素级差异评估，输出结构化差异报告（区域偏移量、色值偏差、字体差异）、
视觉还原度相似度评分，并在桌面端提供叠加对比视图（设计稿在底层、实现在上层
半透明叠加，标注各区域 px 偏移与色值对照）。

## Scope

MVP 包含：

- 纯逻辑差异引擎 `src/d2c/`：颜色计算、元素对齐、逐元素 diff、加权评分、报告装配。
- 两个桌面端专属 Agent 工具：`D2cImport`（导入 Pixso 导出目录并安装技能模板）、
  `D2cCompare`（渲染两侧页面、生成报告）。
- 快照采集走注入式 `D2cCaptureService` 接口；桌面端提供 Electron 隐藏窗口实现，
  CLI 场景下工具明确报"仅桌面端支持"。
- 报告落盘 `.flavor/d2c/<task>/reports/<run-id>/`（report.json + 三张 PNG）。
- 桌面端新增 D2C 视图：报告列表、叠加/并排模式、不透明度滑块、SVG 标注层、问题列表。
- 随 `D2cImport` 自动安装 `d2c-pixso` 项目技能模板（已存在则不覆盖）。

MVP 不包含：

- Pixso API 直连、设计稿图层语义解析（只消费导出的 HTML）。
- 动画、交互态、多视口/响应式断点对比。
- CLI 终端下的渲染对比（无 Chromium 宿主）。
- 差异驱动的自动修复循环 UI（Agent 可凭报告文本自行迭代，不做专门编排）。

## Product behavior

1. 用户把 Pixso 导出的 HTML 目录放进项目，向 Agent 提出 D2C 任务。
2. Agent 匹配 `d2c-pixso` 技能，先调用 `D2cImport { task, exportDir }`：
   校验导出目录（必须含入口 HTML）、复制到 `.flavor/d2c/<task>/design/`、
   写 `manifest.json`、按需安装技能模板。
3. Agent 依据技能指导委派生成 Vue 实现（构建产物或 dev server URL）。
4. Agent 调用 `D2cCompare { task, implementation }`：implementation 支持
   `http(s)://` URL 或本地 HTML 文件路径；工具完成两侧渲染快照、diff、评分，
   写报告并推送 `d2c-report` 桌面事件，返回文本摘要（总分、等级、Top 差异）。
5. 桌面端侧栏新增 D2C 入口：查看任务报告，叠加模式下设计稿在底、实现半透明在上，
   标注层绘制偏移尺寸线（`[---3px---]`）与色值对照块（设计 #xxx → 实际 #yyy），
   右侧问题列表按严重度排序，点击联动高亮。

## Architecture

### 差异引擎（src/d2c/，纯函数，无 Electron 依赖）

```
types.ts         D2cElementSnapshot / D2cPageSnapshot / D2cReport / 阈值常量
color.ts         hex/rgb 解析、sRGB→Lab、CIE76 ΔE
align.ts         元素对齐：文本签名精确匹配 → 剩余按 IoU 贪心（阈值 0.3）
diff.ts          逐元素几何（dx/dy/dw/dh，容差 2px）、颜色（ΔE>3 记差异）、字体 diff
score.ts         加权评分：layout 40% / color 30% / typography 15% / pixel 15%
report.ts        报告装配 + Agent 可读文本摘要（Top N 问题）
store.ts         .flavor/d2c 目录读写：manifest、报告列举、报告加载
skill-template.ts  d2c-pixso 技能模板文本
tools.ts         createD2cTools(workspace, { capture? })
```

评分定义：

- `S_layout = 1 − Σ(area_i·p_i)/Σ(area_i)`，`p_i = clamp(maxOffset/8, 0, 1)`，
  area 加权遍历匹配元素；缺失/多余元素按面积占比以 p=1 计入。
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

桌面端实现（`src/desktop/d2c-capture.ts`）：隐藏 `BrowserWindow`
（`nodeIntegration: false, contextIsolation: true`），两段式——先按默认视口
测量页面自然尺寸（上限 4096），再按目标视口（实现页强制用设计稿尺寸）
注入采集脚本并 `capturePage()`。采集脚本只收录可见且有直接文本、图片或
非透明背景/边框的元素（面积 ≥ 16px²），降低包装节点噪声；采集前等待
`document.fonts.ready` 并注入禁用动画样式。URL 来源仅允许
`http(s)://127.0.0.1|localhost`；文件来源必须位于工作区内。

### 工具注入接缝

`ProductionRuntimeOptions` 新增 `extraTools?: readonly ToolDefinition<unknown>[]`，
并入 tools 数组（managed tool 冲突检查之后不再重复校验，命名冲突按现有
diagnostic 机制报告）。`RuntimeFactoryOptions` 的 Pick 同步扩展。桌面端在
`main.ts` 构造 controller 时传入 `createD2cTools(workspace, { capture })`。

### 桌面端 IPC

- channels：`d2cListReports: "desktop:d2c-list-reports"`、
  `d2cGetReport: "desktop:d2c-get-report"`。
- contracts：`D2cReportRefSchema { task, reportId? }`；`FlavorDesktopApi`
  增加 `listD2cReports()` / `getD2cReport(task, reportId?)`；`DesktopEvent`
  增加 `{ type: "d2c-report", payload: { task, reportId, total, grade } }`。
- 报告图片经主进程读取后以 data URL 返回，渲染进程不直接访问文件路径。

### 渲染端视图

`app.tsx` view 联合类型增加 `"d2c"`，侧栏增加 D2C 入口；新组件
`d2c-viewer.tsx`：报告列表 → 画布（底图设计稿、上层实现图 opacity 可调、
SVG 标注层）+ 问题列表。标注：几何差异画设计稿矩形框与偏移尺寸线
`[---{n}px---]`；颜色差异在区域旁渲染双色块与 `设计 #x → 实际 #y`。

### 目录结构

```
.flavor/d2c/<task>/
  manifest.json                      # 入口 HTML、画布尺寸、导入时间
  design/…                           # 导入的 Pixso 导出物
  reports/<run-id>/report.json|design.png|implementation.png|heatmap.png
```

## Security and limits

- 工具输入经 zod 校验；task 名限 `^[a-z0-9][a-z0-9-]{0,63}$`；路径全部解析后
  校验位于工作区内，符号链接拒绝。
- 隐藏窗口禁用 nodeIntegration；不加载任意外部 URL；`setWindowOpenHandler` 拒绝弹窗。
- 报告 data URL 只包含 PNG；report.json 大小上限 2 MiB。
- 采集脚本为静态字符串常量，不接受用户输入拼接。

## Acceptance criteria

1. 引擎单测：颜色解析/ΔE、文本与 IoU 对齐、容差内不报差异、评分与等级、
   缺失/多余元素扣分。
2. 工具单测：`D2cImport` 校验失败路径、复制与 manifest、技能幂等安装；
   `D2cCompare` 用 fake capture 完成端到端报告落盘；无 capture 服务时报
   "仅桌面端支持"。
3. contracts 单测：D2C 输入 schema 拒绝非法 task/reportId。
4. `npm run typecheck`、`vitest run`、`npm run build`（含桌面端）全部通过。
5. 现有文本/多模态请求不受影响：extraTools 为空时工具列表与现状一致。
