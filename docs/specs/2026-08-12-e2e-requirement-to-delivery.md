# E2E：从粗需求到可验收成果物

## 背景与目标

Electron 已形成“粗需求 → PRD → 交互设计 → 视觉还原 → 接口联调 → 自主验收 → 评分交付”的完整链路。产品一级模块因此命名为 **E2E**；**D2C** 不再代表整条链路，只负责把已确认设计视觉还原为可运行代码。

```text
E2E
├─ 01 粗需求输入
├─ 02 PRD 产品定义
├─ 03 视觉与交互确认
├─ 04 D2C 视觉还原
├─ 05 Swagger / OpenAPI 联调
├─ 06 多模态自主验收
└─ 07 评分与成果物交付
```

同类产品的共同模式不是一次性黑盒生成，而是“计划/上下文 → 可交互原型 → 人工反馈与版本 → 代码和真实数据”。本方案采用显式阶段门，避免未经确认的 PRD 或设计直接污染实现。

## 命名与模块边界

- Electron 侧栏、工作台标题、创建任务、阶段导航和面向用户的完整交付语义统一使用 `E2E`。
- `src/desktop/renderer/e2e-viewer.tsx` 是 Electron 产品入口；当前复用成熟的 `d2c-viewer.tsx` 实现，并显式导出 `E2eViewer`。
- `D2C` 只出现在第 04 阶段及视觉实现相关语义：设计导入、代码生成、像素对比、视觉差异审阅和视觉修复。
- Swagger 联调、交互测试、多模态质量门属于 E2E 后续阶段，不再被描述为 D2C 自身职责。
- 为避免迁移破坏，内部 `D2c*` 类型、工具名、IPC 事件、目录和 `D2cViewer` 兼容导出暂不重命名；后续若做协议 v2，另行提供显式迁移器。

## 兼容原则

1. 保留“已有设计稿”入口；它允许用户跳过前 3 段，直接从 D2C 视觉还原开始。
2. 保留全部 `d2c-*` IPC 语义、`d2c-report` 事件和 Electron `"d2c"` 权限配置。
3. 保留 `.flavor/d2c/<task>`、`src/d2c`、`src/d2c-output`、manifest、report 和 workflow schema，旧任务无需迁移即可在 E2E 工作台打开。
4. 用户确认原型后，通过既有 `importDesign` 导入设计基线，再调用既有 D2C prompt 和 `D2cCompare`；不创建第二套视觉实现链路。
5. 新状态与 prompt 逻辑位于 `src/d2c/product.ts`，无 Electron 依赖；不向 CLI 注册 E2E 命令、不改变现有 CLI 命令或输出。
6. Electron 只增加显式白名单 IPC 和 loopback 原型预览；所有路径由 task 推导，渲染端不能传任意文件路径或 URL。

## 工作流与工件

`product-plan.json` 使用 schema 1，阶段如下：

```text
prd-generating → prd-review → design-generating → design-review → ready-for-d2c
                     ↑                ↑
                  退回修改          退回修改
```

为兼容旧 D2C 与 CLI，E2E 前置工件继续落在现有任务根目录：

```text
.flavor/d2c/<task>/
  product-plan.json
  product/
    prd.md
    prototype/
      index.html
      interaction-manifest.json
      assets/*
```

- PRD 必须描述目标用户、问题、范围/非范围、用户故事、页面/状态、交互规则、数据/API 假设、可验证验收标准和未决问题。
- 原型必须是可离线加载的 HTML 工件，不依赖 CDN；包含主流程与 loading/empty/error/success 等关键状态。
- `interaction-manifest.json` 是后续自动交互测试的行为契约，并随原型一起导入现有 `design/`。
- 行为契约必须以用户旅程组织，而不是控件抽样：列表页覆盖“输入查询条件 → 触发查询 → 结果断言 → 重置 → 恢复断言 → 下一页/上一页”；导航覆盖实际点击入口及二级、三级菜单；表单覆盖必填校验、完整输入、提交、成功/失败反馈和关闭恢复。
- 每个点击、输入、选择、按键动作后必须有可观察的状态、URL、数据或 API 后置条件；只移动指针、只触发 hover、只输入但不提交的场景不算完整验收。
- 行为协议原生支持 `open` 路由切换、`blur` 失焦校验、`hidden` 不可见断言和 `not-exists` DOM 移除断言；这些步骤必须由 Electron 执行器真实执行，不能在导入时静默删除或弱化。
- 用户退回时记录反馈并生成只修改当前工件的迭代 prompt；用户确认原型后才允许进入 D2C 视觉还原。

## Electron 产品行为

新建 E2E 提供两个入口：

- “从需求开始”：只输入任务名与粗需求，不要求用户额外选择技术栈；默认采用前端 Vue 3、服务端 Python，若需求原文明确指定 React、Next.js、Java、FastAPI 等技术则自动识别并覆盖对应默认值。随后生成 PRD，在工作台内审阅/退回；确认后生成并嵌入展示交互原型；再次确认后自动导入并进入 D2C 视觉还原。
- “已有设计稿”：保留 Pixso HTML 导入能力，明确提示“从 D2C 视觉还原开始”。

技术栈识别结果写入 `product-plan.json`，并区分默认值与需求明示来源；旧计划没有该字段时继续按原 `framework` 推导前端、按 Python 推导服务端。D2C 的兼容 `framework` 字段仍只使用 `vue | react`，不改变既有 IPC 与 CLI schema。

“从需求开始”的接口契约属于 E2E 自身成果物：设计阶段优先生成 `product/openapi.json`；旧任务没有该文件时，Electron 根据已确认 PRD 来源和 `d2c.modules.json` 自动生成 OpenAPI 3.1 契约并完成确定性映射，不弹出文件选择器。默认 Python 方案在联调生成阶段同时产出 `server/main.py`、`server/requirements.txt` 与运行说明。Swagger/OpenAPI 手动上传仅作为“已有设计稿”或覆盖默认契约的入口。

视觉采集必须等待可见的 `aria-busy`、骨架屏和 loading 状态结束后才允许评分；页面在就绪时限内未稳定时，本次评测标记为未完成并输出“页面未就绪”诊断，不允许拿两个相同骨架屏得出高分。

工作台持续展示七段 E2E 交付轨道，D2C 阶段使用独立强调色。报告态阶段导航将视觉审阅标为“04 D2C 视觉还原”，将接口联调、自主验收与交付归为后续 E2E 阶段。

原型通过只监听 `127.0.0.1` 的静态服务器展示。服务端限制在推导出的 prototype 根目录、拒绝路径穿越、禁用缓存，并设置限制脚本/网络能力的 CSP；iframe 使用 sandbox。由于原型与 Electron 渲染器分属不同 origin，sandbox 仅为原型增加 `allow-same-origin`，使登录态所需的 `sessionStorage` 可用，同时继续隔离 Electron 父页面。切换工作区和退出时必须停止服务。

## 多模态自主交互审阅

Electron 自动验收采用“模型规划 + 确定性执行”的双层结构：

1. 嵌入式执行器逐页恢复基准状态，采集页面截图、标题/正文、标题层级及带稳定 selector 的可操作 DOM，同时保留 PRD、已确认 interaction manifest 和 API 映射作为上下文。
   - 受保护业务路由直达登录页属于合法鉴权跳转：执行器用本次导航的唯一标记确认 iframe 已完成加载，不能要求重定向后的 URL 与请求 URL 完全相等。
   - 若采集目标因未登录落到登录页，执行器必须从已确认交互契约中选择包含目标路由证据的安全导航前缀，仅执行登录和菜单导航直到抵达目标页，再采集页面；禁止将登录页截图冒充多个业务页面交给多模态模型。
2. 已配置的多模态质量模型先判断页面真实类型、用户目标、深层路径和风险，再生成适合当前产品的完整用户旅程；不预设页面一定是分页列表，也可能识别为表单、大屏、详情、向导、编辑器或混合页面。
3. 模型计划只能使用已观察页面，必须包含 action、可观察后置断言和业务语义；计划经过严格 schema、路径、数量、唯一性和完整性校验。
4. 模型计划与已确认设计契约合并，不能删除原有场景。Electron 执行器负责实际点击、输入、选择、导航、断言和 API 证据采集；多模态模型不能直接宣布通过。
   - 点击目标未出现在当前列表页时，执行器可识别通用上一页/下一页控件并以可视化方式有限遍历分页；遍历后仍不存在才失败。该恢复只允许执行无副作用的分页导航，不能猜测或强制触发业务提交。
5. 未配置模型时继续执行原有确定性契约，保证旧 D2C 和 CLI 行为不变；自主计划与执行结果分别落盘，便于 CR、复盘和重现。
6. 多模态请求遇到瞬时网络失败或 408、429、5xx 时允许一次有限重试，并保留端点与底层网络原因但不得泄露密钥。观察或规划仍失败时不得中断整轮验收：必须明确标记“自主规划失败”，保存诊断文件，并继续可视化执行已确认的确定性交互契约；不得将降级结果伪装成自主审阅成功。
7. 交互实现预览必须保持设计契约使用的 `1280 × 800` 桌面视口，再按工作台可用区域等比缩放展示；禁止让工作台窄栏触发被测应用的移动端断点，否则桌面侧栏和菜单会被错误判定为不可点击。
8. AI 质量评测允许对自动验收失败或尚未人工确认的当前版本进行诊断评分，但最终交付状态仍必须同时满足自动验收通过、人工确认和质量门通过；诊断评分不得绕过交付门槛。

## 生成状态恢复与 Windows 持久化

- E2E/D2C 权限配置下的 PRD、原型和实现生成是内部产物任务，成果已经由任务目录和会话持久化，不参与通用长期记忆自动提取；生成完成后不得因 `Stop` 收尾钩子超时而向用户误报失败。普通对话与 CLI 的标准权限配置继续保留原有记忆行为。
- 原型只有 `index.html`、尚无交互清单时属于半成品，轮询不得递增 revision 或反复写 `product-plan.json`。
- 标准交互清单路径固定为 `product/prototype/interaction-manifest.json`；若模型误写到 `product/interaction-manifest.json`，发现器应保留源文件并自动复制到标准路径，再推进到设计评审。
- 同一 `product-plan.json` 的进程内写入必须串行，临时文件名必须唯一；Windows 拒绝 rename-over-existing（`EPERM`/`EACCES`/`EBUSY`/`EEXIST`）时允许回退为覆盖复制并清理本次临时文件。
- 模型常见但语义明确的清单写法在严格校验前归一化：API 路径数组转为 `requireApi` 布尔值，`{ action: "expect", type }` 转为 `{ expect }`，以及将 `visible`、`hidden`、`not-exists`、`text`、`text-contains`、`attribute`、`class`、`count`、`value`、`url` 等误写在 `action` 中的断言转为 `{ expect }`；`attribute` 转为 `name`，hash URL 补全当前页面入口。不能安全推导的字段仍必须拒绝。
- 工件发现阶段必须先解析并严格校验 `interaction-manifest.json`，通过后才能进入设计评审和展示确认按钮；可安全归一化的内容回写为唯一规范格式，无法归一化的清单停留在生成态，展示可定位的预检错误和单独的自动修复入口。
- 用户确认设计时将归一化后的清单重新落盘，确保后续导入、可视回放和自主验收读取同一份可执行契约。

## SDD/TDD 验收

1. 纯逻辑测试覆盖 schema、工件发现、合法状态迁移、退回反馈和两阶段 prompt。
2. 静态服务器测试覆盖 loopback、HTML/资源响应、CSP 和路径穿越。
3. Controller 测试覆盖创建、PRD 确认、原型预览、设计确认后复用 `importDesign`。
4. IPC contract/security 测试覆盖所有新增通道和输入上限。
5. Renderer 测试验证 E2E 一级入口、七段流程、D2C 子模块标识、双入口、PRD Markdown、sandbox iframe 和确认门。
6. 兼容测试验证 `d2c-report` 自动打开 E2E、D2C permission profile 保留、`D2cViewer` 旧导出可用且 CLI 无变化。
7. Electron 回放测试覆盖同一清单连续执行两次、相邻场景重复加载同一 URL、真实 click 事件确认、页面内导航后 frame 恢复，以及可视化节奏不进入 CLI。
8. 回归运行 D2C/desktop 专项、完整测试、typecheck、desktop/CLI build；不提交 commit。

## 后续扩展点

Figma/Pixso 直连应实现为 `DesignArtifactProvider` 适配器：输入统一 PRD/设计上下文，输出可预览 URL、版本 id 和可导入 HTML 快照。当前版本以本地交互 HTML 作为确定性内置 provider；既有 Pixso 导出入口继续作为外部设计工具的稳定兼容路径。
