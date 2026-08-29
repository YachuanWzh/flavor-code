# 更新公告 / Changelog

[Flavor Code](https://github.com/YachuanWzh/flavor-code) 是一个本地优先、可审计、可恢复的 AI 编程助手，在终端、Electron 桌面端和 VS Code 中读代码、改文件、运行命令并完成复杂任务。

本文档记录 1.0.0 到 1.3.16 的版本更新，内容与仓库提交历史对应。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。各版本安装包可从 [GitHub Releases](https://github.com/YachuanWzh/flavor-code/releases) 或 npm 获取。

## [1.3.16] - 2026-08-29

### 修复
- 修复长会话在接近上下文阈值时因内存压力发生堆 OOM 的问题：自动压缩触发缓冲区由 13,000 调整为 27,000 tokens（200K 窗口下约在有效窗口的 85% 处触发），不再让会话贴着 ~92.8% 的临界点运行
- 修复上下文可见性审计日志无限增长的问题：该日志随每次会话保存全量序列化，长时间子代理任务会膨胀到数百兆；现在限制最多保留 1,000 条记录且单条内容截断到 2,048 字符，恢复旧会话快照时同样施加边界
- 修复上下文更新公告重复堆积占用窗口的问题：被新版取代的 "Context update" 公告在每次模型调用前自动清理，源内容更新仅推送追加的增量部分，完整状态仍由固定源消息暴露
- 启动器为 CLI 进程统一追加 `--report-on-fatalerror`：V8 致命错误（堆 OOM、原生崩溃）会绕过 JavaScript 异常处理只留下不可用的原生栈，现在会在崩溃现场生成 Node 诊断报告文件便于事后定位
- 新增堆水位受控重启防护：每次模型调用前检查堆占用，达到 V8 堆上限的 80% 时以 `memory_pressure` 干净中断当前轮次并保存会话，进程以约定退出码结束，启动器随即自动以 `--resume` 在新堆上续跑同一会话（30 分钟内最多 3 次），把未知内存驻留导致的原生 OOM 闪退降级为无感重启；即使重启预算耗尽也只会停止续跑而不会丢失会话
- 启动器追加 `--heapsnapshot-near-heap-limit=1`：堆逼近上限时自动落一份 `.heapsnapshot` 堆快照，与诊断报告一起为下一次 OOM 留下可做 retainer 分析的现场（快照文件可能很大，请勿删除）
- 修复 Shell 工具输出截断尾部每个数据块都全量拼接的 O(n²) 拷贝：改为分块队列、翻倍窗口时才合并，消除长输出命令下的巨额瞬时内存分配与 CPU 空转

### 测试
- 新增上下文管理器回归测试：覆盖可见性日志条目/内容双维度限界、快照恢复限界、过期 Context update 清理与增量公告；启动器测试覆盖强制重启用带诊断报告参数的链路
- 新增 `npm run stress:context` 上下文内存压力测试：复现子代理可见性日志海量收录、历史臃肿会话快照恢复、逐轮动态来源抖动与 1MB 级上下文 fork 深拷贝等堆 OOM 场景，断言各项限界与增量推送修复持续生效
- 新增 `npm run evidence:crash-fix` 崩溃现场回放：将真实崩溃会话（775 条消息、末次 162,047 输入 tokens、全程零压缩）经真实生产代码路径回放，验证新阈值提前触发压缩且长时间混合负载内存有界
- 新增堆水位防护测试：水位判定纯函数、越限轮次以 `memory_pressure` 中止且零模型调用、未越限正常运行；重启协议测试覆盖标记预算累计/窗口重置、会话 id 校验、`--resume` 参数重建与预算耗尽拒绝

## [1.3.15] - 2026-08-29

### 严重修复
- 修复 Windows 11 build 26200 在 Node.js 24 及以上版本运行长会话时可能发生的 V8 Maglev 原生崩溃：典型表现为 Shell 工具启动前后直接打印 `node::OnFatalError` / libuv / V8 原生栈并返回 PowerShell，且不会经过 JavaScript 异常、退出事件或 Flavor 崩溃日志
- CLI 入口拆分为不加载业务模块的轻量兼容启动器与主程序；受影响环境会在任何 Ink、模型、插件或工具代码加载前自动使用 `--no-maglev` 启动主程序，从源头避开已知崩溃路径，用户无需修改命令或手动设置参数
- 启动器在规避进程运行期间保留终端并把 Ctrl+C 交给真实 CLI 处理，避免父进程提前退出、终端模式未恢复或子进程残留

### 新增
- superharness 插件升级至 1.1.0：新增 `onboarding`（深度分析工作区业务逻辑，生成 ONBOARDING.md 与可交互模块脑图，基于 astgraph 并支持增量缓存）、`converge`（审查后审计实现与规范/计划的一致性，并将已验证行为沉淀为跨会话的 living spec）与 `receiving-code-review`（实现前先验证审查发现，避免盲目应用反馈）技能；`/go` 流程加入第 4.5 阶段收敛审计，`writing-plans` 自审流程强化

### 改进
- README 中英文版补充官方插件管理器 `@flavor-code/plugin-manager` 的安装使用说明

### 测试
- 新增 Windows/Node 运行时矩阵与实际启动参数回归测试，覆盖 Node 24、未来 Node 主版本、已显式禁用 Maglev 及非受影响系统；未来升级 Node 不会静默绕过保护
- 安装 smoke test 改为执行 npm 实际生成的 `flavor`/`flavor.cmd` 命令入口，不再直接调用构建产物，确保发布包持续覆盖兼容启动器链路
- 新增插件更新链路的跨平台 npx 调用回归测试：覆盖 Windows 下 spawn EINVAL 修复与 `--force`/`--all`/`-y` 参数传递校验，macOS 参数透传用例同步更新

## [1.3.14] - 2026-08-28

### 修复
- 修复长程任务运行一段时间后可能因内存压力异常退出的问题：运行时转录不再为每个流式 token 重复复制完整回答，而是在模型、工具与持久化边界前合并相邻文本和思考增量，消除长输出下的二次方分配增长
- 修复输出较多时连续退格偶尔只能删除一个字符或看似无法删除的问题：CLI 输入草稿在同一批终端按键内同步推进，连续 Backspace、Delete、光标移动与普通输入不再重复操作 React 闭包中的旧值；粘贴块与图片附件删除保持一致
- 修复桌面端 mention 标签有效性判断恒为真的问题，输入内容变化后失效标签会正确解散，不再阻塞正常编辑和退格

### 改进
- CLI 转录区增加实时渲染窗口：限制同时挂载的历史轮次、输出块和超长文本/命令输出，避免 Ink/Yoga 节点树随长任务无限增长；被隐藏的旧内容仍完整保存在会话中
- Electron 桌面端按 50ms 合并相邻流式文本/思考事件，缓存已完成轮次，并限制实时 DOM 中的历史轮次、输出块与超长内容，降低 Markdown 重解析、布局和渲染进程内存占用
- `/explain` 讲解支持流式文本输出：模型文本块经回调增量渲染到终端，无需等待完整生成后再阅读；流式与缓冲双模式均有测试覆盖
- superharness 插件升级至 1.0.3：新增 SessionEnd 检查点钩子（不清除活动任务）、Before/AfterPlan 计划边界记录与 SubagentStart/Stop 子代理生命周期及完成状态记录；原子写改用进程 ID + 时间戳唯一命名，脑图服务器端口改由操作系统分配避免冲突

### 测试
- 新增流式事件顺序合并、CLI 长转录窗口、单轮超大输出裁剪与桌面端大活动轮次渲染回归测试；全量测试覆盖 198 个测试文件、1799 个通过用例

## [1.3.13] - 2026-08-28

### 新增
- 新增面向新人上手的 `/explain <符号 | file.ts#符号> [关注点]` 命令：结合 AST 代码图（调用者/被调用者关系）、符号真实源码切片与所在文件近期 Git 提交历史，用廉价子代理模型生成五段式讲解（它是做什么的 / 关键实现点 / 调用关系 / 为什么这样写 / 新人注意事项）
- 歧义处理：多个符号命中时弹出与 AskUserQuestion 同款的终端选择卡片（top 3 候选 + Cancel），候选以唯一 node-id 标注并附 kind 与 文件:行号；自由输入更精确名称可原地重解析（最多追问 2 轮，避免循环弹窗）
- 全链路优雅降级为提示文本（对齐 `/review` 语义，不抛错）：代码图未建立时提示 `/ast init`、查询无命中时提示 `/ast sync`、非 git 仓库时跳过历史证据继续解释、模型不可用时返回错误文本、含 `#` 的非法 node-id 查询自动回退为名称搜索
- 生成前通过 notice 输出进度提示（`Explaining <symbol> …`）；证据 prompt 中源码切片上限 20000 字符，超长自动截断标注

### 测试
- 新增 explain 服务 24 个单元测试：覆盖 node-id/名称目标解析、歧义选择卡片与重解析回路、prompt 构造与源码截断、全部降级路径、模型流式错误语义；`/explain` 命令解析新增 3 个用例

## [1.3.12] - 2026-08-27

### 新增
- 支持模型扩展思考（extended thinking）的流式展示：Anthropic 协议默认请求 8192 token 思考预算，OpenAI Responses 协议支持 `low`/`medium`/`high` 推理力度；模型输出思考内容时，CLI 状态行下方会出现独立的固定宽度“思考行”，以打字机方式滚动展示最新推理文本
- 提供商配置新增 `thinkingBudget`（Anthropic 协议，0 表示关闭请求参数）与 `thinkingEffort`（OpenAI Responses 协议，默认不下发该参数，避免不兼容网关收到未知字段）
- 思考块以带提供商签名（signature）的形式随助手消息保留在上下文中：与 tool_use 同轮时按 Anthropic 要求逐字回显签名块；上下文压缩过滤消息时同步保留 `thinkingBlocks`，不会丢失回显所需的签名

### 改进
- 网关不支持 `thinking` 参数时自动降级：识别到参数被拒绝（400 且错误信息指向 thinking 参数）后仅移除该参数重试一次，后续请求不再下发 `thinking`，并清理历史中已无签名要求的思考块，端点不支持时退化为普通非思考流式输出而非报错
- 思考增量在 UI 侧按动画节奏批量合并（与正文文本缓冲同样处理），逐 token 的思考流不会造成高频重渲染；思考文本本地累积上限 4000 字符，只保留最新尾部
- 思考内容仅用于实时状态行展示：附加在运行中的 model 活动块上，不进入正文文本，也不会混入最终回复（`assistantText` 仍只累积 `text` 事件）

### 测试
- 新增 Anthropic/OpenAI 适配器思考回归测试：覆盖 thinking 参数下发与预算钳制、不支持端点的自动降级重试、签名块回显、思考/文本增量事件流；新增思考行窗口滚动与文本裁剪、CLI 渲染测试

## [1.3.11] - 2026-08-27

### 新增
- `registerTool` 注册的托管工具支持通过 `/<工具名> [JSON 对象]` 直接调用，并提供不会受内置命令、插件或 Skill 名称冲突影响的 `/tool <工具名> [JSON 对象]` 稳定入口
- CLI 与 Electron 桌面端会在工具注册、删除后即时刷新斜杠命令补全；桌面端新增独立的“工具”补全类型标识

### 修复
- 修复工具参数修复流程可能把 `agents` 等数组字段错误地当作字符串约束，导致连续四次修复仍出现 “expected array, received string” 与字符串长度错误的问题
- 工具参数标准化统一下沉到 `ToolRuntime`：模型调用和斜杠调用现在共享数组包装、JSON 字符串解码、字符串数字/布尔值转换及可选 `null` 字段清理逻辑，新增调用入口无法绕过该防线
- 修复 OpenAI 严格工具 Schema 的递归规范化，补齐对象字段的 `required`、`additionalProperties: false` 以及组合 Schema 处理；保留不兼容沙箱工具的非严格模式，避免过度收紧造成回归
- 托管工具斜杠调用复用现有权限审批、Hook、审计日志、执行 journal 与输出限制，不再形成绕过安全边界的独立执行路径

### 测试
- 新增 registerTool 热注册后直接调用、CLI/桌面动态补全、命令冲突回退、运行时弱类型参数标准化及严格 Schema 的回归测试；全量测试覆盖 196 个测试文件

## [1.3.10] - 2026-08-27

### 新增
- Glob/Grep 搜索工具的 `includeIgnored` 参数支持字符串布尔值标准化：`"true"`/`"false"`（忽略大小写与首尾空白）会在工具边界被转换为布尔值，与 Shell/Terminal 的字符串布尔值输入约定保持一致；无法识别的值仍按参数校验失败处理

### 改进
- 模型错误分类将 HTTP 5xx 状态码统一归类为 `network` 错误，不再落入未分类或误判为其他错误类型；上游服务不可用（如 502/503）时可按网络错误路径处理与重试
- 配置提示逻辑改进：`network`（上游不可达）与 `rate_limit`（限流）错误不再附加 “请在 .flavor/flavor.json 或环境变量中配置 provider/API key” 的提示，避免把非配置类故障误导为配置问题；仅 adapter、provider、api key、model 相关错误保留该提示

### 测试
- 新增 5xx 状态码归类为 `network` 的回归用例；更新运行时测试验证 `network` 错误不再附加配置提示；新增 Glob/Grep `includeIgnored` 布尔字符串标准化边界测试

## [1.3.9] - 2026-08-27

### 新增
- Glob 与 Grep 搜索工具新增 `includeIgnored` 参数，可显式包含被 `.gitignore`/`.ignore` 排除的文件（如依赖目录、生成输出），默认行为不变
- 开启 `includeIgnored` 时 `.git` 元数据目录仍然始终排除，不会把仓库内部结构暴露给搜索工具；ripgrep 与 Node 两种后端行为保持一致
- 系统提示中的 Glob/Grep 工具规则补充 `includeIgnored` 使用说明，引导仅在用户明确要求时检查被忽略文件

### 测试
- 新增回归测试：覆盖 `includeIgnored` 下 ripgrep 与 Node 后端结果一致性，以及 `.git` 路径在两种后端下均返回空结果

## [1.3.8] - 2026-08-27

### 新增
- 自动长期记忆提取改为后台执行：任务结束后不再同步等待记忆模型调用，排队中的后续请求可以立即继续执行，不受慢速记忆分析拖累；提取完成后的高置信记忆写入与候选生成结果通过 notice 输出通知
- 记忆收尾按任务隔离：自动存储的内容按任务分别追踪，后台完成的旧任务不会复活已失效的 review 卡片，也不会覆盖新任务占据的生命周期槽；记忆评估失败时保留 `/finish` 手动重试路径，且不会被后续任务静默覆盖

### 测试
- 新增回归测试：自动记忆收尾不再阻塞排队中的后续请求

## [1.3.7] - 2026-08-26

### 新增
- 新增 Flavor Island 本地控制通道：加载 `flavor-island` 插件时自动启动经 token 认证的本机 IPC 服务（Windows named pipe / Unix socket），Flavor Island 可通过 `abort`、`steer`、`follow_up` 与 `focus` 命令控制运行中的会话；`focus` 由宿主提供（Electron 桌面端已接入窗口聚焦）
- Hook 事件上下文新增 `islandControlEndpoint`、`islandControlToken` 与 `islandControlCapabilities` 元数据，宿主侧插件可安全发现并连接控制通道，无需猜测端点
- 模型调用完成事件（`model-completed`）新增 `durationMs` 与 token 用量（`inputTokens`/`outputTokens`，可选 `cacheReadTokens`/`cacheCreationTokens`），便于统计成本与延迟
- `Stop` Hook 新增 `summary`（最近助手文本摘录）与 `deliverables`（最多 100 个交付文件），宿主可在任务结束时展示结果概览与产物清单

### 测试
- 新增 Flavor Island 控制服务器测试，覆盖 token 认证、非法命令、命令分派与能力声明

## [1.3.6] - 2026-08-26

### 新增
- Hook 处理器收到协议 v2 运行时元数据：稳定 `sessionId`、唯一 `eventId`、会话内 `sequence`、`timestamp` 与 `workspace`；元数据在 payload 校验后附加，不会泄漏进 hook 修改后的工具输入
- 工具生命周期 hook 新增稳定 `toolCallId`，覆盖 `PreToolUse`、`PermissionRequest`、`PostToolUse` 与 `PostToolUseFailure`，支持 Flavor Island 正确匹配并行、乱序完成的只读工具调用
- `PermissionRequest` 新增宿主判定的 `toolCategory` 与 `allowAlways`，使审批 UI 只对可缓存类别展示会话级授权，破坏性及不可缓存协作操作继续要求逐次确认

### 测试
- 增加 Hook 协议元数据稳定性、不可伪造更新输入及工具生命周期兼容回归覆盖

## [1.3.5] - 2026-08-26

### 新增
- `QuestionBridge` 的所有交互问题统一先通过 `PermissionRequest + AskUserQuestion` hook 中继；经代码路径核对，当前直接使用者 `/commit` 与 `/go` loop budget 现在可由 Flavor Island 回答，后续命令接入 `QuestionBridge` 时也自动获得该能力；中继不可用或未返回完整答案时仍回退到 TUI
- TaskPlan、Todo 与子 Agent 图的实时 `TaskSnapshot` 通过 `Notification` hook 推送，包含任务状态、activeForm、依赖、前台任务和子 Agent 计时
- `/go` 结束时发出 `LoopEnd` hook，携带 loop outcome、终止原因及最后一次宿主验证证据

### 测试
- 新增 QuestionBridge hook 中继成功、无答案回退 TUI 的回归覆盖

## [1.3.4] - 2026-08-25

### 修复
- 修复 Durable Harness journal 重复保存完整模型消息、turn prompt、工具输入与结果，导致长会话快速达到 32 MiB 上限并持续报错、`/compact` 也无法恢复的问题；这些大对象现仅记录 SHA-256 哈希和崩溃恢复所需元数据
- journal 达到容量边界时自动压缩已完成历史，仅保留待处理队列、未完成 turn、模型请求、工具调用与最后 savepoint，不再因可靠性旁路日志阻断正常会话
- 旧格式及已发生前缀轮转的 journal 在加载时自动校验、迁移和压缩，现有 session 无需删除聊天记录即可继续使用

### 测试
- 新增大对象去重、受限容量自动压缩、未完成非幂等工具恢复和 journal 前缀轮转兼容回归测试

## [1.3.3] - 2026-08-25

### 修复
- 修复 1.3.0 将插件沙箱设为默认值后，依赖 Node.js API 的 astgraph、superharness 等已有插件无法加载，进而导致 `/ast` 与插件 Skill `/go` 消失的问题；Worker/vm 沙箱保留为显式 opt-in，待文件系统等能力完成代理后再安全切换默认值
- 移除已由全局 `flavor-island` 取代的项目级 `codeisland` 内置插件及 `flavor init` 自动安装逻辑，避免同一 Hook 事件被重复转发

## [1.3.2] - 2026-08-25

### 新增
- Electron 新任务支持“当前检出”与应用托管的隔离 Git worktree；隔离任务使用 `flavor/desktop-*` 分支，可查看 dirty/merged 状态、显式合并交付、保留分支或安全移除，未确认时拒绝清理脏工作树
- 新增 Agent 工作台，将执行轨迹、持久 Goal 阶段与验证缺口、TaskPlan、子 Agent、后台 Job、Session Time Machine 和项目 PTY 终端集中可视化
- Session Time Machine 支持命名 checkpoint、回退、撤销回退和从指定节点 fork；终端支持打开、输入、增量读取、调整尺寸和关闭，并严格绑定当前任务目录与会话所有者
- Review Workbench 支持 working、staged、commit、base 与 last-turn 五种范围，提供文件与 hunk 导航、P0/P1/P2 审查提示，并可一键把选定文件交给 Agent 审查
- 新增 loopback-only 应用预览，支持从当前任务的终端及后台 Job 输出自动发现本地 URL、内嵌查看、刷新、复制和外部打开
- 新增 Context & Safety Inspector，展示 Context Epoch、visibility log、用量记录、项目指令、权限层、诊断与脱敏审计记录
- 新增代码图浏览器，可查看 AST 索引状态、搜索符号，在可点击关系图中漫游 callers/callees/多跳影响范围，并将精确文件行号插入输入框
- 新增 Pals / Co-work 可视化，可发现本地 Pal、发送 Chat/Task、启动共同目标、查看状态并取消协作；工作台采用在线实例轨道、Pal 身份头和并排操作卡，区分直接沟通、异步委托与共同执行，并提供明确的进行中和完成反馈
- 长期记忆卡片新增 distinct-task 调用次数和 enamel 风格 hot/normal/cold 标签，支持热度筛选与一次确认清理所有 cold 记忆

### 安全与兼容
- 所有桌面新增能力均通过严格 Zod IPC 契约和 typed preload 暴露；预览仅接受 loopback HTTP(S)，AST/审计读取有大小上限，敏感字段在进入 renderer 前脱敏
- Electron 工作树、界面与编排逻辑保持在 `src/desktop/`，共享运行时只增加历史、Pals Chat 和任务状态的加法式读取钩子；CLI 命令、默认值、输出与持久化行为不变
- 修复 Electron 恢复会话时错误地使用桌面主入口拉起 Pals broker、最终导致 `desktop:select-session` 超时的问题；桌面端改用独立 broker entry，broker 暂不可用时不阻断任务，并在后续 `list-pals`/协作操作时自动重连而非永久丢弃 Pals 客户端
- Agent 工作台终端改用按需加载的 xterm.js 连接现有 `node-pty`，支持逐键输入、方向键、Ctrl 组合键、粘贴、全屏 TUI 和自适应 resize，能够在桌面终端内正常运行交互式 `flavor` CLI；修复关闭后残留 `closed` 条目、ANSI/光标序列作为正文显示、长 shell 路径溢出及异常空白的问题，并统一工作台滚动条样式

### 文档与测试
- 新增 Electron Workbench 1.3.2 SDD，覆盖架构边界、视觉方向、安全不变量与发布门禁
- 增加工作树生命周期/交付、Git 审查范围、时间机/终端/Pals 控制、终端 VT 输出投影与文本边界、逐键/方向键 PTY 交互、嵌套 Flavor CLI 和关闭清理、AST 查询、上下文边界、记忆热度与 cold 清理的单元、契约及 Electron E2E 测试

## [1.3.1] - 2026-08-25

### 新增
- Electron 桌面端支持同时打开并切换多个项目；每个项目保留独立运行时、会话与对话缓存，切换项目不会中止后台执行
- 侧栏按项目展示会话：运行中的项目和任务显示活动动效，任务完成后在项目与对应任务上保留蓝色未读圆点，打开后自动清除
- 多项目列表和最后选中的项目持久化，应用重启后自动恢复；兼容旧版单项目状态文件
- 同一项目支持最多 4 个独立任务并行执行，可在任务之间切换、单独中止和继续；后台输出按项目与会话缓存
- 新增持久活动中心和原生系统通知，区分完成、失败、等待确认与意外中断；点击通知可定位到对应项目和任务
- 新增项目置顶、显示名称、关闭、资源管理器定位和复制路径，以及任务搜索、重命名、置顶和归档
- 新增前进/后退导航、`Ctrl+P` 项目切换器、`Ctrl+K` 命令面板，并补齐 `Ctrl+N` 新建任务
- 新增异常退出恢复条，可恢复/查看或忽略上次被中断的任务
- 新增 Git 变更中心，支持逐文件 Diff、暂存、取消暂存、还原、提交，以及一键交给 `/review`

### 改进
- 统一侧栏与输入区的 SVG 线性图标、尺寸和基线；长期记忆、MCP、E2E、图片与文件引用使用明确语义，移除无实际交互的品牌下拉符号
- 重做 Electron Git Diff 工作台：新增双行号、增删整行红绿色块、hunk 分隔、文件状态徽标、增删统计和工作区/已暂存层切换

### 文档与测试
- 更新中英文 README 的 Electron 多项目与任务状态说明
- 扩展 Electron E2E 测试，覆盖双项目打开、切换与可选视觉快照；新增状态迁移和持久化兼容测试

## [1.3.0] - 2026-08-24

### 新增
- 新增 Durable Harness：使用 fsync、顺序号和 SHA-256 哈希链持久化队列、turn、模型请求、工具调用与 savepoint；崩溃后恢复未确认 steering/follow-up，非幂等工具只中断不重放
- 新增 Context Epoch：稳定 system/FLAVOR/工作区/用户记忆前缀在 epoch 内逐字节不变，动态上下文在 Prompt Cache 断点后按时间加入，压缩显式开启新 epoch
- 新增五层权限策略（托管、用户、项目、本机项目、session），支持 token 前缀、自测样例、遮蔽诊断与最严格决策合并，内置硬拒绝不可降级
- Goal Verification 新增不可变 contract hash、Git diff hash、宿主验证结果与持久 evidence rounds

### 安全与可靠性
- 产品插件默认启用 Worker + VM 沙箱；加载元数据携带内容指纹与能力声明，进程内兼容模式支持 capability + 指纹信任双门槛
- 动态上下文刷新采用 stale-while-revalidate；本轮 Hook/Skill 内容进入持久 visibility log，保证模型可见输入可审计且不污染后续轮次
- Session schema 升级至 v4；v1/v2/v3 迁移前保留独占原始备份，事件日志随会话删除与保留策略同步管理
- Goal 验收改为 fail closed：宿主测试失败、缺少验证命令、分类器故障或无效 skeptic 输出都不能误报完成

### 工程化
- CI 扩展至 Windows、macOS、Ubuntu 与 Node.js 20/24，增加 durable journal、Prompt Cache、迁移、权限和验收的独立可靠性门禁
- 新增 [1.3 可靠性契约](./docs/specs/2026-08-24-v1.3-reliability-contract.md)，明确恢复、缓存、安全和发布不变量

## [1.2.20] - 2026-08-24

### 新增
- 新增只读 `Skill` 工具：运行中的组合 Skill 可以按名称继续加载依赖 Skill；同时接受 `superharness:test-driven-development` 这类插件限定别名，恢复跨宿主工作流的 Skill 组合语义
- 新增 Claude 风格 Skill 参数展开：支持 `$ARGUMENTS`、`$ARGUMENTS[N]` 和 `$N`，含引号与转义参数解析；未声明占位符时以 `ARGUMENTS:` 兜底追加

### 修复
- `SessionStart` Hook 返回的 `additionalContext` 现在会在首轮模型调用前写入持久会话上下文，并在恢复会话时按内容去重；插件注入的工程规则不再被静默丢弃

### 测试
- 新增 Skill 参数、组合 Skill、限定别名和 SessionStart 上下文持久化测试；同步扩展系统提示词的可用工具契约

## [1.2.19] - 2026-08-24

### 改进
- 插件沙箱升级为 Worker + VM capability 隔离：`PluginHost` 新增 `sandbox` 选项，为 `true` 时插件在独立 V8 isolate 的受限 module realm 中激活，仅允许加载插件根目录内的相对模块，并通过校验后的 RPC 调用宿主贡献
- 影子验证干跑（`/evolve verify`）复用完整 manifest、路径和贡献声明校验，并在受限 realm 中阻止 Node.js 内置模块、包依赖、宿主文件系统及网络 API
- Worker 沙箱内置资源限制（128MB 老年代内存上限、10s 激活超时），超出时限或异常崩溃均安全降级为失败报告

## [1.2.18] - 2026-08-24

### 修复
- 修复终端 Markdown 渲染中单行代码块内容在滚动/重绘时偶发丢失的问题：代码块渲染区域标记为 opaque（不透明），防止 ScrollBox 增量渲染器用缓存的空白单元格覆盖已渲染的单行代码内容
- 新增回归测试：验证多行围栏代码块旁边的单行代码内容保持可见
- 修复 Windows 环境下 Ctrl+C 偶发无法退出的问题：原退出链路为「优雅关闭 → 退出」，任一清理步骤挂起（MCP stdio 服务关闭、pals 命名管道、IDE 会话、持久化等）都会使后续按键全部失效且进程永不退出。具体修复：
  - 二次 Ctrl+C 强制退出：首次中断触发的优雅关闭仍在进行时，再次按 Ctrl+C 立即强制退出进程，不再被清理守卫吞掉
  - 关闭看门狗：优雅关闭整体限时 8 秒，超时后先恢复终端模式再强制退出，挂起的清理不会阻塞退出
  - 清理步骤逐步超时：dispose 各异步步骤（协作事件泵、睡眠调度、记忆刷新、持久化、IDE 会话、执行环境、后台任务、协作连接关闭、插件卸载、MCP 关闭）各自限时 3 秒，超时即放弃该步并记录诊断，其余步骤与退出流程继续；构造失败的清理路径同样受保护
  - 新增信号处理、超时工具、看门狗与挂起清理的回归测试

## [1.2.17] - 2026-08-20

### 新增
- 新增 `/logout` 命令：清除本地存储的 OAuth 凭据（`auth.json`），注销所有 PKCE 托管的认证提供者与模型注册，回退到 apiKey/env 配置的模型并同步更新 main/subagent 模型、幻觉防护与目标编排器；未登录时给出明确提示而非报错
- `/login` 切换为“单凭据”语义：登录成功后仅保留当前服务的令牌，避免重启后欢迎卡片显示上一次登录的服务名

### 改进
- 模型选择持久化改为保存解析后的决策而非 harness 快照：登出后从旧会话恢复时，不再把已注销服务的模型当作当前模型
- 会话状态恢复使用当前解析的模型：`/login` 后即生效，且令牌泄露面更小（旧服务的刷新令牌随登出一并清除）

## [1.2.16] - 2026-08-20

### 新增
- 桌面端新增 E2E 交付运行状态查看：工作台按七节点流水线（需求 → PRD → 交互设计 → D2C → API 联调 → 自主验收 → 成果交付）实时展示每个节点的状态（done / active / waiting / stale / failed），并通过新增的 `getE2eDeliveryRun` IPC 通道以只读快照方式读取交付状态机
- 优化 API 联调完成记录：生成文件产物改为记录真实文件内容指纹（artifactRef），而非仅记录文件名

### 改进
- Shell 工具优化 Windows 平台命令执行：按能力自动选择 shell（PowerShell 7 → Windows PowerShell → cmd.exe 回退），通过 `-EncodedCommand`（UTF-16LE base64）原样传递含空格、引号与 `&` 的参数，`exit $LASTEXITCODE` 保留子进程真实退出码，`chcp 65001` 统一 UTF-8 输出解码

### 配置
- OAuth 配置中的授权与令牌 URL 从局域网地址（192.168.x.x）改为回环地址（127.0.0.1）

## [1.2.15] - 2026-08-18

### 新增
- 新增原生 Git 工作流命令：`/commit [hint]` 为暂存变更生成 Conventional Commits 风格提交信息，确认后执行提交；`/review [focus]` 对未提交变更做结构化审查，输出 verdict（ship / ship-with-fixes / needs-work）、严重级别 finding（critical / warning / nit）与修复建议
  - 两者都使用廉价子代理模型，模型不可用时优雅降级：`/commit` 回退为确定性消息（`chore: update <scope>`），`/review` 明确报错而非静默通过
  - `/commit` 在无暂存内容时先询问是否 `git add -A`；`/review` 会额外提示 diff 之外的未跟踪文件，支持 `focus` 聚焦关注点
  - 新增只读 GitHistory 工具：查看仓库或单文件提交历史（跟随重命名，默认 20 条、上限 50），无需拼写裸 git 命令
  - 会话检查点自动附带 git 状态标记（`branch@sha`，工作区脏时加 `-dirty`），`/tree` 各节点显示对应的工作区 git 快照
- 新增 evolve 学习型护栏规则（guardrail rules）：`/evolve rule list|add <text>|remove <id>` 管理规则，持久化到 `.flavor/evolve/rules.json`，按文本指纹去重（上限 20 条），以 `# learned guardrails (evolve)` 章节注入未来系统提示词
  - `evolve_improve` 工具新增 `kind=prompt_rule`：把重复失败建议直接沉淀为护栏规则并标记完成，无需编写修复插件
  - 新增 `/evolve trends [n]` 跨运行仪表盘：展示最近 n 次运行的模型/工具调用数、失败数与 signalDelta，以及按工具拆分的移动明细（默认 5 次、最多 50 次）
- 新增子代理写入冲突防护：Task 节点可声明 `files`（拥有的文件，路径分隔符归一化比较），声明文件重叠的任务绝不并行执行，防止并发写坏同一文件
- 新增全局崩溃防护：CLI 与桌面端安装 crash guard，未处理 rejection/异常时写入脱敏崩溃日志 `.flavor/crash-*.log`（仅当前用户可读），尽力恢复终端（恢复光标与主屏）并以诊断信息退出

### 改进
- 安全：将 `.npmrc` 加入 `.gitignore`，避免项目级 npm 认证令牌被误提交到版本库

## [1.2.14] - 2026-08-18

### 新增
- 新增内置自进化闭环（evolve）：捕获 → 评估 → 修改 → 验证 → 重复五步循环，有界且人机共同把关
  - `/evolve <signals|suggest|improve <id>|verify <name>|reload <name>|test|revert <name>|done <id>|clear>` 命令族
  - `evolve_improve` 工具：模型侧按建议脚手架 `fix-<工具>/` 插件目录并写入 PLAN.md，实现走普通工具循环与权限系统
  - 失败信号按（工具、错误码、规范化错误）去重聚合，上限 400 条；只记录参数键名不记值，引号内容脱敏，敏感信息不落盘
  - 重复 ≥2 次（minRepeats）的失败以建议形式注入系统提示词（最多 promptTop=3 条），由模型自行判断是否值得修
  - `/evolve verify` 在影子 PluginHost 沙箱中干跑插件（复制到临时目录加载，不触碰真实宿主）；`/evolve test` 运行测试套件（默认 120s 超时）；`/evolve revert` 回滚到 `.versions/` 中最后一份良好快照
  - `PluginHost.reload` 公开方法：支持修复插件热重载，每次激活带新鲜查询参数绕过 Node ESM 模块缓存
  - 每次 loop 运行结束追加 reflection（iterations / toolCalls / toolErrors / steers / totalFailures / signalDelta / perTool），signalDelta 为负表示修复生效，正数表示恶化
  - 按工具维度评估（perTool）：记录每个工具当次运行的失败数与相对上次运行的 delta，工具失败减少（delta<0）时其建议自动标记 verified 不再提议；工具再次恶化（delta>0）时已验证的建议重新开放并标注 worsening
  - `/evolve suggest` 与提示词注入按趋势排序：恶化优先于稳定、稳定优先于改善；新增 `/evolve verified` 查看已自动验证的建议
  - 用户可见反馈：某信号首次达到重复阈值时弹出一次提示（指向 `/evolve suggest`）；每次 loop 运行结束输出一行摘要（toolErrors、失败总数变化 delta、按工具 improved/worsening 与建议自动验证/重开状态）；无错误时仅一行静默摘要
  - `/evolve`（无参数）显示当前状态概览：信号数、开放建议数、已验证数、总失败数、最近信号
  - 新增 `LoopEnd` hook 事件与 `evolve` 配置段（promptTop / minRepeats / testCommand / testTimeoutMs）

### 修复

- Shell 工具兼容弱类型模型的命令调用：当 `command` 字段被塞入整条命令行（如 `dir /b`、`git log --oneline`、`npm view node --json`）时，自动按引号感知分词拆成 `command + args`，避免 Windows 下被整体加引号导致 `'"dir' is not recognized` 或 `File Not Found`；显式含空格的可执行文件路径（`C:\Program Files\node.exe`）保持原样不被误拆；`permissions` 与 `execute` 使用归一化后的命令，后台任务与执行环境分支同样生效
- evolve 捕获 Shell 命令失败：Shell 工具对命令失败（exit ≠ 0）刻意返回结果而非抛异常，从不触发 PostToolUseFailure。evolve 现在从 PostToolUse 的输出旁路捕获非零退出与超时（cancelled 除外），错误码记为 `shell_exit_<code>` / `shell_exit_timeout`，与工具失败信号一起参与去重、建议与趋势统计

## [1.2.13] - 2026-08-15

### 新增
- 新增 astgraph 代码图索引：项目初始化时安装基于 tree-sitter 的代码图插件，生成 `.flavor/astgraph/index.db`，提供 `ast_search` / `ast_callers` / `ast_callees` / `ast_impact` / `ast_context` 查询定位符号与追踪可达性；`FLAVOR.md` 自动生成 Search 章节
- 新增结构化输出强健化：模型以纯文本（含 ```json 代码块）返回 JSON 时自动提取；按 JSON Schema 对字符串形式的数字/布尔字段做类型强制转换后再校验，减少无效的修复模型调用
- 新增只读工具声明：工具可声明 `readOnly`，只读工具在默认模式与 plan 模式下自动放行，与 Read/Glob/Grep 同等对待

## [1.2.12] - 2026-08-15

### 改进
- Shell 工具 `background` 与 Terminal 工具 `enter` 参数接受字符串形式的布尔值（`"true"` / `"false"`），弱类型模型输出可被标准化为布尔类型

## [1.2.11] - 2026-08-15

### 新增
- 新增 CLI Pals 与跨项目协作：同一用户下的多个 CLI 实例通过本地 IPC（Windows named pipe / Unix socket）发现与通信，支持 `/pals`、`/chat`、`/co-work` 命令，内置身份认证、消息路由、协作权限控制与内容共享保护

## [1.2.10] - 2026-08-14

### 新增
- 新增认证前置失败快速阻断：D2C 交互验收中登录/认证场景失败后，后续受保护场景直接标记为被该前置场景阻断，不再逐一执行
- 新增跨导航请求记录：交互回放请求经 `sessionStorage` 在页面导航之间持久化（上限 500 条），点击跳转后的请求也能被捕获并用于断言
- 新增交互修复补充要求：修复失败场景前可填写“补充修复要求”，与失败详情一起作为“用户补充要求”注入修复提示词
- 新增验收与交付独立阶段：工作台拆分“接口联调”与“验收与交付”，自动修复完成后自动进入验收页签
- 新增后端源码指纹检测：为 mock/server 后端源码计算指纹，源码变更时自动重启后端，确保验收针对最新代码

## [1.2.9] - 2026-08-14

### 新增
- 新增分层项目指令：支持根目录或子目录的 `AGENTS.md` / `CLAUDE.md` 自动加载，同目录可用 `AGENTS.local.md` / `CLAUDE.local.md` 做本地补充
- 新增每轮成果物汇总：`Write`、`Edit`、`ApplyPatch` 成功后展示带语义色的 CHANGESET 收据（CREATE / UPDATE / DELETE、各文件行数与总计）
- 新增文件版本保护：文件在 Agent 读取后被 IDE、格式化器或其他进程修改时，再次写入会报 `Stale file` 并提示重新读取
- 新增标准工具展示协议：工具可声明 `outputSchema`、`renderForModel`、`presentCall`、`presentResult`
- 新增后台任务管理：Shell 支持 `background: true`，通过 `JobList` / `JobRead` / `JobWait` / `JobKill` 管理后台任务
- 新增持久终端（PTY）：支持 `TerminalOpen` / `TerminalWrite` / `TerminalRead` / `TerminalClose`，引入 node-pty 依赖
- 新增原生 WebSearch 工具：无需 MCP 与密钥，默认使用 DuckDuckGo Lite，连接失败或无可解析结果时自动降级到 Bing，单次最多返回 20 条
- 新增原生 WebFetch 工具：支持 HTTP(S)、重定向、HTML 转文本、超时与响应大小限制，并兼容 Clash/TUN Fake-IP DNS
- 桌面端（Electron）会话标题栏实时显示运行中的后台任务数量

### 改进
- 统一 D2C/E2E 预览与后端服务进程生命周期：输出限制、进程树终止与幂等清理
- CLI 输出展示升级：区分 JOB、COMMAND、TERMINAL 与 WEB SEARCH 收据，长输出折叠中间部分
- Windows 终端输出编码优先使用 UTF-8，遇到 GBK/GB18030 系统诊断时自动回退
- 增强安全边界：WebFetch 拦截 Fake-IP、内网与云元数据地址访问（SSRF 防护）

## [1.2.8] - 2026-08-13

### 新增
- 新增 D2C（设计稿到代码）模块：设计稿导入、框架选择与自动对比的端到端流程
- 实现 D2C diff engine 核心：元素对齐、差异识别、评分与报告生成（TDD 覆盖）
- 新增设计稿像素对比功能，支持生成项目经 vite dev server 运行后对比
- 新增桌面端截图服务、工具扩展接入点与报告 IPC
- 新增差异检查器 UI：叠加层、标注、报告列表，并改进问题筛选与评分展示
- 新增 D2C 人工审阅与接口联调功能
- 新增 D2C 模拟服务器健康检查与运行时同步功能
- 新增交互契约验证与自主规划功能，以及端到端测试重置与交互修复提示
- 新增 Python FastAPI 集成与质量评估功能
- 新增端到端交付功能：从粗需求到可验收成果物的全流程支持
- 为 Anthropic 模型适配器添加 Claude 客户端支持及请求指纹
- 新增 PRD 治理与桌面端 E2E 测试支持

### 改进
- 优化 D2C 评测体系与用户体验，新增内嵌质量评估能力
- 改进测试失败处理并新增诊断功能
- 交互过程中展示编码中状态并校验任务名

### 修复
- 修复差异检查器空状态卡片在画布区域的居中问题

## [1.2.7] - 2026-08-11

### 发布
- 更新版本号并优化启动流程

## [1.2.6] - 2026-08-11

### 新增
- 记忆系统新增「清除冷记忆」功能，可清理长期记忆中不常用的条目

## [1.2.5] - 2026-08-10

### 修复
- 修复权限请求钩子重复调用的问题

## [1.2.4] - 2026-08-10

### 新增
- 欢迎界面显示当前版本号

### 改进
- README 添加简体中文版本并国际化英文内容

### 修复
- 修复工作区路径解析中的符号链接问题
- 修复路径别名导致的文件编辑问题
- 修复桌面端测试中的硬编码路径，支持跨平台运行

## [1.2.3] - 2026-08-09

### 修复
- 修复 OpenAI 兼容端点工具调用解析问题
- 修复文件读取工具行范围请求的字节限制问题

### 配置
- 使用 OAuth PKCE 认证提供商替换 OpenAI 配置
- 更新 README 并配置 package.json 发布选项

## [1.2.2] - 2026-08-08

### 发布
- 更新项目版本号至 1.2.2

## [1.2.1] - 2026-08-07

### 新增
- 增强 Read 工具：支持行范围读取和重复读取检测
- 新增 Hook UI 界面支持，用于向用户提问
- 在 usage 事件和 CLI transcript 中展示缓存命中率
- 会话缓存使用情况统计功能
- 图标构建脚本更新，新增透明背景图标版本

### 改进
- 实现主会话滚动缓存断点，提升提示词缓存命中率
- 默认启用缓存命中率日志并按会话绑定

### 修复
- 修复 ApplyPatch 工具的块计数验证逻辑

## [1.2.0] - 2026-08-06

### 改进
- 重构缓存布局并添加缓存能力识别

## [1.1.9] - 2026-08-03

### 新增
- 优化提示词缓存布局与命中率量化
- 记忆系统支持高置信候选直接写入与自动忽略

### 改进
- superharness 插件迁移：Ralph 状态根目录迁移到 `.flavor` 目录
- 添加轻量级任务模式并更新脑图技能英文内容
- 新增 session hooks 和自动 go 任务跟踪

### 调整
- 将审核自动关闭时间从 10 秒调整为 5 秒

## [1.1.8] - 2026-08-03

### 新增
- 支持 OAuth PKCE 管理的运行时 LLM 配置
- 任务完成时自动评估长期记忆
- 支持中断查询后重新规划任务计划

### 改进
- 限制单任务记忆候选数为 1，支持多语言摘要
- 使用动态包版本替代硬编码版本号

## [1.1.7] - 2026-08-03

### 新增
- 实现 Agent 自注册工具与热加载功能

### 修复
- 修复压缩进度报告状态及回调调用问题
- 修正用户记忆注入和更新逻辑

## [1.1.6] - 2026-08-02

### 发布
- 同步 CLI 与 MCP SDK 版本号为 1.1.6，发布稳定版本

## [1.1.5] - 2026-08-01

### 新增
- 支持 RPC 客户端处理交互式工具审批
- 增加 RPC 写入流机制

### 配置
- 切换默认模型为 deepseek-v4-flash

### 修复
- 修复 UTF-8 截断边界与二进制检测稳定性问题

## [1.1.4] - 2026-07-31

### 新增
- 集成 Flavor Code VS Code 扩展及原生工作台功能

### 改进
- 使用 z.coerce 替换数字验证器，提高类型转换灵活性
- 更新并添加多个开发依赖项版本

## [1.1.2] - 2026-07-31

### 新增
- 在 VS Code 扩展中添加仅本地环回的 IDE 桥接服务

## [1.1.1] - 2026-07-30

### 新增
- 支持多模态图片上传与处理

## [1.1.0] - 2026-07-30

### 发布
- 发布 1.1.0 版本，新增控制面及多项功能

## [1.0.2] - 2026-07-23

### 新增
- 新增睡眠整理系统，实现自动日报功能
- 增加会话工具调用和质量统计功能

### 改进
- 提升运行时可靠性，优化任务计划与休眠审查

## [1.0.1] - 2026-07-22

### 新增
- 实现任务级长期记忆 V2 系统
- 增加自然语言显式「记住」意图的主动保存机制
- 持久化用户偏好注入并优化记忆召回逻辑

## [1.0.0] - 2026-07-22

### 首个稳定版本发布

Flavor Code 1.0.0 正式发布。以下能力为 1.0.0 发布时已包含的功能（含开发期 0.x 版本累积）：

- **多入口支持**：CLI 与 Electron 桌面端共享模型配置、会话和工具能力
- **模型接入**：支持 OpenAI、Anthropic 及兼容服务
- **文件与搜索工具**：受控工作区内的文件读写、跨平台搜索与 Shell 执行
- **权限与安全**：hooks 权限策略、分级权限审批、破坏性操作保护
- **任务编排**：主任务计划、子 Agent DAG 调度、成本分层调度、任务进度面板
- **会话能力**：JSONL 会话存储、会话恢复与时间线回放、上下文压缩（长上下文管理）
- **长期记忆**：跨会话长期记忆系统
- **技能与插件**：渐进式技能加载、插件发现与注册、斜杠命令技能调用、`@` 文件补全
- **MCP**：提供 Electron 和 CLI 的项目 MCP 服务管理工作台
- **认证**：OAuth PKCE 认证流程与企业级支持
- **终端 UI**：Claude 风格 transcript、Markdown 渲染、双向文本支持、多语言检测
- **可靠性**：模型调用重试、结构化输出与工具 JSON 修复、三层幻觉检测、工具失败自动上报与根因分析
- **扩展命令**：`/loop`（具备验证和分段预算的外循环）、`/goal`（对抗性审查流水线）
- **桌面端**：Electron 打包、图标重设计、斜杠命令补全、代码差异预览、「始终允许」审批选项

## 版本时间线

| 版本 | 发布日期 | 摘要 |
| --- | --- | --- |
| 1.3.16 | 2026-08-29 | 上下文内存修复：压缩提前到有效窗口 85% 触发、可见性审计日志双重限界、Context update 过期清理与增量推送、启动器崩溃诊断报告 |
| 1.3.15 | 2026-08-29 | 严重稳定性修复：Windows 11 build 26200 + Node 24 及以上版本自动禁用 Maglev，轻量启动器在业务代码加载前规避 V8 原生闪退，并由真实 npm 命令链路回归验证；superharness 升级 1.1.0 新增 onboarding/converge/receiving-code-review 技能 |
| 1.3.14 | 2026-08-28 | 长程任务稳定性修复：流式转录批量合并、CLI/桌面实时渲染窗口、连续退格同步输入草稿、桌面 mention 标签编辑修复；/explain 流式输出、superharness 生命周期钩子增强 |
| 1.3.13 | 2026-08-28 | 新人上手命令 /explain：代码图 + 真实源码 + Git 历史生成五段式讲解，歧义时选择卡片选符号，无索引/非 git/模型失败均优雅降级 |
| 1.3.12 | 2026-08-27 | 扩展思考流式展示：Anthropic 默认 8192 思考预算与 OpenAI reasoning effort 配置、CLI 打字机思考行、签名思考块回显、不支持端点自动降级 |
| 1.3.11 | 2026-08-27 | registerTool 工具支持斜杠调用与动态补全；统一工具参数标准化和严格 Schema，修复 agents 数组修复循环 |
| 1.3.10 | 2026-08-27 | HTTP 5xx 错误归类为 network、配置提示不再附加到 network/rate_limit 错误、Glob/Grep includeIgnored 支持字符串布尔值标准化 |
| 1.3.9 | 2026-08-27 | Glob/Grep 新增 includeIgnored 参数可显式包含被忽略文件，.git 元数据始终排除，ripgrep 与 Node 后端行为一致 |
| 1.3.8 | 2026-08-27 | 自动长期记忆提取后台化（不再阻塞后续请求）、记忆收尾按任务隔离、失败可 /finish 手动重试 |
| 1.3.7 | 2026-08-26 | Flavor Island 本地控制通道（token 认证 IPC：abort/steer/follow_up/focus）、模型调用耗时与 token 用量上报、Stop hook 摘要与交付物 |
| 1.3.6 | 2026-08-26 | Hook 协议 v2 运行时元数据、稳定 toolCallId、PermissionRequest toolCategory/allowAlways 审批能力声明 |
| 1.3.5 | 2026-08-26 | QuestionBridge 交互经 PermissionRequest/AskUserQuestion hook 中继、TaskSnapshot 实时推送、LoopEnd hook |
| 1.3.4 | 2026-08-25 | Durable Harness journal 大对象去重、容量自动压缩与旧格式迁移恢复 |
| 1.3.3 | 2026-08-25 | 修复插件沙箱默认值导致内置插件无法加载；移除 codeisland 插件 |
| 1.3.2 | 2026-08-25 | Electron Agent 工作台、Git worktree、Session Time Machine、Review Workbench、代码图浏览器、Pals 可视化和记忆热度标签 |
| 1.3.1 | 2026-08-25 | Electron 多项目切换、后台任务保活、运行/完成状态提醒与项目列表持久化 |
| 1.3.0 | 2026-08-24 | Durable Harness、Context Epoch/Prompt Cache、分层权限、插件默认隔离与 fail-closed Goal Verification |
| 1.2.20 | 2026-08-24 | 组合 Skill 工具、Claude 风格 Skill 参数展开、SessionStart additionalContext 持久注入 |
| 1.2.19 | 2026-08-24 | 插件沙箱升级 Worker 线程隔离；影子验证干跑改用 Worker 沙箱杜绝宿主副作用 |
| 1.2.18 | 2026-08-24 | 修复单行代码块渲染丢失；修复 Windows 下 Ctrl+C 偶发无法退出（二次强制退出 + 关闭看门狗 + 清理步骤逐步超时） |
| 1.2.17 | 2026-08-20 | /logout 登出命令、OAuth 单凭据登录语义、模型决策持久化改进 |
| 1.2.16 | 2026-08-20 | 桌面端 E2E 交付运行状态查看、Windows Shell 命令执行优化、OAuth 回环地址配置 |
| 1.2.15 | 2026-08-18 | 原生 Git 工作流（/commit、/review、GitHistory）、evolve 护栏规则与 trends 仪表盘、子代理写冲突防护、崩溃防护 |
| 1.2.14 | 2026-08-18 | 内置自进化闭环（evolve）：信号捕获去重、建议排序、修复插件生命周期、自动验证；Shell 命令失败旁路捕获 |
| 1.2.13 | 2026-08-15 | astgraph 代码图索引、结构化输出类型强转与纯文本 JSON 提取、只读工具声明 |
| 1.2.12 | 2026-08-15 | Shell/Terminal 字符串布尔值输入标准化 |
| 1.2.11 | 2026-08-15 | CLI Pals 跨项目协作、本地 IPC 与 /co-work |
| 1.2.10 | 2026-08-14 | D2C 验收与交付：认证前置快速阻断、跨导航请求记录、修复补充要求、后端源码指纹重启 |
| 1.2.9 | 2026-08-14 | 运行时生产力与原生 Web：分层项目指令、安全写入、后台任务、持久终端、WebSearch/WebFetch |
| 1.2.8 | 2026-08-13 | D2C 设计稿到代码、E2E 端到端交付、Claude 客户端支持 |
| 1.2.7 | 2026-08-11 | 启动流程优化 |
| 1.2.6 | 2026-08-11 | 清除冷记忆功能 |
| 1.2.5 | 2026-08-10 | 权限请求钩子重复调用修复 |
| 1.2.4 | 2026-08-10 | 欢迎界面版本号、中文文档、路径与符号链接修复 |
| 1.2.3 | 2026-08-09 | OpenAI 兼容端点修复、OAuth PKCE 配置 |
| 1.2.2 | 2026-08-08 | 版本号更新 |
| 1.2.1 | 2026-08-07 | Read 行范围、Hook UI、缓存命中率统计 |
| 1.2.0 | 2026-08-06 | 缓存布局重构与能力识别 |
| 1.1.9 | 2026-08-03 | 缓存布局与命中率量化、superharness 迁移 |
| 1.1.8 | 2026-08-03 | PKCE 运行时配置、记忆自动评估 |
| 1.1.7 | 2026-08-03 | Agent 自注册工具与热加载 |
| 1.1.6 | 2026-08-02 | 稳定版本发布，版本号同步 |
| 1.1.5 | 2026-08-01 | RPC 交互审批与写入流、默认模型切换 |
| 1.1.4 | 2026-07-31 | VS Code 扩展集成与原生工作台 |
| 1.1.2 | 2026-07-31 | 本地环回 IDE 桥接服务 |
| 1.1.1 | 2026-07-30 | 多模态图片上传与处理 |
| 1.1.0 | 2026-07-30 | 控制面及多项新功能 |
| 1.0.2 | 2026-07-23 | 睡眠整理系统与自动日报 |
| 1.0.1 | 2026-07-22 | 长期记忆 V2、显式记住意图 |
| 1.0.0 | 2026-07-22 | 首个稳定版本发布 |

> [!NOTE]
> 1.0.0 之前的历史版本（0.1.0 – 0.9.0）为开发期版本，未单独记录。仓库当前仅存在 `v1.1.6` 标签，其余版本建议在发布时按需创建对应 Git 标签，便于在 Releases 页面快速定位。
