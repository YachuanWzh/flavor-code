# E2E P0：PRD 治理、可追溯节点与可靠执行

## 目标

Electron E2E 从粗需求进入 PRD 评审后，允许用户在确认前通过自然语言要求重新生成 PRD，或直接修改指定 Markdown 章节。PRD 一经确认即成为不可变开发基线；设计、实现、接口联调和验收只能消费该基线，任何内容漂移都会阻断后续阶段。自动验收必须同时证明当前实现对应已确认的 PRD、设计原型、交互契约和接口契约。

本规格同时完成此前确定的 P0 基础设施：统一节点运行记录与产物失效、带乐观并发控制和崩溃恢复的工作流存储、真实 Electron 应用级冒烟回归。

## 非目标

- 本期不增加节点级 Skill 配置。
- 不开放任意拖拽 DAG 或第三方节点执行代码。
- 不允许 AI 评分替代确定性测试、人工验收或基线完整性检查。
- 不迁移已有 `.flavor/d2c/<task>` 目录；旧任务采用读取时兼容升级。

## 术语

- **PRD 草稿**：`product/prd.md` 在 `prd-review` 及之前的内容，可重新生成或按章节编辑。
- **已确认 PRD**：用户确认时记录 SHA-256、确认时间和验收标准 ID 的不可变基线。
- **验收标准 ID**：PRD 验收标准定义中形如 `[AC-001]` 的稳定标识。确认 PRD 前必须至少存在一个；同一 ID 的定义只提取一次，用户故事和追踪矩阵中的重复引用不视为重复定义。
- **产物引用**：路径、SHA-256、字节数和生成时间组成的只读证据。
- **过期节点**：任一输入产物摘要与节点最后成功执行时不同的节点；过期节点及其下游不得作为交付证据。

## 产品行为

### PRD 重新生成

`prd-review` 阶段展示“重新生成要求”输入框。提交非空 query 后：

1. 计划回到 `prd-generating`；
2. query 作为本轮唯一修订要求写入 feedback；
3. PRD 节点开始新 attempt，并使所有下游节点失效；
4. Agent 只能修改 `product/prd.md`；
5. 新文件被发现并通过预检后重新进入 `prd-review`。

### PRD 指定区域编辑

PRD 按 Markdown 二至六级标题切分为可定位章节；标题前的导言作为“文档说明”章节。用户点击章节的“修改”操作后只编辑该章节正文。保存请求必须携带当前 PRD SHA-256；若磁盘内容已变化则拒绝并要求刷新，不能覆盖并发修改。

章节编辑仅允许发生在 `prd-review`。编辑后保留同一阶段、更新 PRD 摘要并使已有下游运行记录失效。标题文本本期不可直接修改，避免章节定位歧义；可以通过重新生成 query 调整结构。

### PRD 确认与冻结

确认 PRD 时必须：

1. 对当前 UTF-8 内容计算 SHA-256；
2. 提取并校验 `[AC-NNN]` 验收标准，至少一项；按列表、标题、表格、普通引用的优先级为每个 ID 选择唯一规范定义，允许其他章节重复引用同一 ID；
3. 将 `{ hash, approvedAt, criteria }` 写入 `product-plan.json`；
4. 将 PRD 节点标记为成功并记录产物引用；
5. 后续 prompt 明确给出已确认 hash、验收标准清单和只读要求。

从 `design-generating` 开始，所有产品读取、设计确认、设计导入、视觉评审、OpenAPI 映射、代码生成、交互验收和质量评审入口都必须先重新计算 PRD hash。若不匹配，返回 `PRD_LOCK_VIOLATION`，不自动接受新内容、不更新基线、不继续执行。任何系统 API 都不得在确认后写入 PRD。

## 严格验收基线

设计确认时生成 `acceptance-baseline.json`，包含：

- 已确认 PRD 的 hash 和验收标准；
- 原型 `index.html` hash；
- `interaction-manifest.json` hash；
- `product/openapi.json` hash（存在时）；
- 生成时间和 schema 版本。

接口映射确认后，工作流追加规范化 OpenAPI hash；生成联调代码后追加绑定计划 hash。每次自动验收前重新计算所有文件摘要并拒绝任何漂移。

交互场景增加 `requirementIds: string[]`：

- 每条场景至少关联一个已确认验收标准；
- 每个 PRD 验收标准至少被一个场景覆盖；
- 未知 ID、空覆盖、重复 ID 均阻断设计确认或自动验收；
- 场景仍必须执行真实动作与可观察断言；`requireApi` 场景继续要求真实请求证据。

自动验收结果持久化一份 `acceptance-evidence.json`，记录四类基线摘要、验收标准到场景及结果的映射。只有全部标准有当前、通过的证据时，自动验收才为通过。

## 统一节点运行记录

新增 `.flavor/d2c/<task>/delivery-run.json`，schema 1，固定节点：

1. `requirement`
2. `prd`
3. `design`
4. `d2c`
5. `api`
6. `acceptance`
7. `delivery`

每个节点保存状态、attempt、开始/结束时间、输入/输出产物、错误。节点只能在依赖成功后开始。输出 hash 改变时，其所有传递下游节点变为 `stale` 并清除可交付结论，但保留历史 attempt 供诊断。

节点运行记录是可观测和失效依据；现有 `product-plan.json` 与 `workflow.json` 在本期仍作为兼容业务视图，不复制其大对象。

## 可靠存储

`workflow.json` 与 `delivery-run.json` 使用统一受保护更新：

- 写入必须提供 `expectedRevision`；锁内重读后不一致则抛出 `STALE_REVISION`；
- revision 每次成功事务只增加一次；
- 纯读取绝不写回或增加 revision；
- 主文件损坏或缺失时从 `.bak` 恢复读取；
- 写入使用唯一临时文件、fsync、备份和原子替换；Windows 的 `EPERM/EACCES/EBUSY/EEXIST` 允许安全覆盖复制回退；
- 锁文件可检测已退出进程留下的陈旧锁。

## Electron 应用级回归

使用 `playwright-core` 的 Electron launcher 启动构建后的真实应用，至少验证：

- BrowserWindow 成功加载且 preload API 存在；
- 点击 E2E 入口后显示七阶段流程；
- 应用关闭后 Electron 子进程退出，无遗留窗口；
- 测试使用临时 userData，不读取用户真实配置。

该套件通过独立 `test:desktop:e2e` 命令运行；常规单元测试不重复构建应用。

## SDD/TDD 验收

1. PRD 单元测试覆盖章节解析、局部替换、并发 hash 冲突、验收标准提取、确认冻结和篡改检测。
2. 节点运行测试覆盖依赖、attempt、传递失效、落盘恢复和 CAS 冲突。
3. Workflow 测试覆盖纯读取、单次 revision、并发旧写拒绝、备份恢复和 Windows 替换回退。
4. Controller/IPC 测试覆盖重新生成 query、章节保存、确认后所有后续入口的 PRD 锁检查。
5. 交互测试覆盖 requirementIds schema、全量 PRD 覆盖和证据落盘。
6. Renderer 测试覆盖章节编辑入口、保存/取消、重新生成输入和冻结提示。
7. Electron 应用级测试真实启动构建产物并点击 E2E 导航。
8. 最终运行相关测试、完整测试、typecheck、desktop build 和 Electron E2E。
