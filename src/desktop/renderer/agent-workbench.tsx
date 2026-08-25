import React, { useEffect, useMemo, useRef, useState } from "react";

import type { DesktopAstNode, DesktopAstRelations, DesktopAstStatus } from "../astgraph-service.js";
import type { DesktopHistorySnapshot, DesktopPalPresence, DesktopSnapshot } from "../contracts.js";
import type { DesktopWorkbenchInspection } from "../workbench-service.js";
import type { DesktopWorktree } from "../worktree-manager.js";
import type { TerminalSnapshot } from "../../terminal/service.js";
import {
  buildAstGraphModel,
  parseReviewDiff,
  projectAstGraphPoint,
  reconcileTerminalSelection,
  sessionTreeRows,
  terminalShellName,
  zoomAstGraphViewport,
  type AstGraphCanvasSize,
  type AstGraphViewport,
  type AstGraphModel,
  type ReviewFile,
} from "./agent-workbench-models.js";

export { buildAstGraphModel, parseReviewDiff, projectAstGraphPoint, reconcileTerminalSelection, renderTerminalBuffer, sessionTreeRows, terminalGridSize, terminalShellName, zoomAstGraphViewport } from "./agent-workbench-models.js";

type Tab = "cockpit" | "timeline" | "terminal" | "review" | "preview" | "context" | "ast" | "pals" | "worktrees";
const TABS: readonly { id: Tab; label: string }[] = [
  { id: "cockpit", label: "执行" }, { id: "timeline", label: "时间机" }, { id: "terminal", label: "终端" },
  { id: "review", label: "审查" }, { id: "preview", label: "预览" }, { id: "context", label: "上下文" },
  { id: "ast", label: "代码图" }, { id: "pals", label: "Pals" }, { id: "worktrees", label: "工作树" },
];
const InteractiveTerminal = React.lazy(() => import("./interactive-terminal.js"));

export function AgentWorkbench({ snapshot, onClose, onError, onCompose }: {
  snapshot: DesktopSnapshot; onClose(): void; onError(message: string): void; onCompose(value: string): void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>("cockpit");
  const [discoveredUrls, setDiscoveredUrls] = useState<string[]>(() => loopbackUrls(snapshot.jobs.map((job) => job.label).join("\n")));
  const jobCursors = useRef(new Map<string, number>());
  const discover = (text: string) => setDiscoveredUrls((current) => [...new Set([...current, ...loopbackUrls(text)])].slice(-20));
  useEffect(() => {
    let cancelled = false;
    void Promise.all(snapshot.jobs.map(async (job) => {
      const next = await window.flavorDesktop.readJob(job.id, jobCursors.current.get(job.id) ?? 0).catch(() => undefined);
      if (next === undefined || cancelled) return;
      jobCursors.current.set(job.id, next.cursor);
      discover(next.output);
    }));
    return () => { cancelled = true; };
  }, [snapshot.jobs]);
  return <section className="agent-workbench manager-view">
    <header className="manager-header workbench-header"><div><button onClick={onClose}>‹</button><div><small>FLAVOR DESKTOP 1.3.3</small><h2>Agent 工作台</h2></div></div><span>{snapshot.activeSession?.environment === "worktree" ? "隔离工作树" : "本地检出"}</span></header>
    <nav className="workbench-tabs" aria-label="工作台功能">{TABS.map((item) => <button key={item.id} data-active={tab === item.id} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    <div className="workbench-stage">
      {tab === "cockpit" && <Cockpit snapshot={snapshot} onCompose={onCompose} />}
      {tab === "timeline" && <Timeline onError={onError} />}
      {tab === "terminal" && <TerminalPane onError={onError} onDiscover={discover} />}
      {tab === "review" && <ReviewPane onError={onError} onCompose={onCompose} />}
      {tab === "preview" && <PreviewPane onError={onError} suggestions={discoveredUrls} />}
      {tab === "context" && <ContextPane snapshot={snapshot} onError={onError} />}
      {tab === "ast" && <AstPane onError={onError} onCompose={onCompose} />}
      {tab === "pals" && <PalsPane onError={onError} />}
      {tab === "worktrees" && <WorktreePane snapshot={snapshot} onError={onError} />}
    </div>
  </section>;
}

function Cockpit({ snapshot, onCompose }: { snapshot: DesktopSnapshot; onCompose(value: string): void }): React.JSX.Element {
  const [inspection, setInspection] = useState<DesktopWorkbenchInspection>();
  const [goalDraft, setGoalDraft] = useState("");
  useEffect(() => { void window.flavorDesktop.inspectWorkbench().then(setInspection).catch(() => undefined); }, [snapshot.activeSession?.sessionId]);
  const goal = inspection?.goals[0];
  useEffect(() => { if (goal !== undefined) setGoalDraft(goal.objective); }, [goal?.id]);
  const plan = snapshot.tasks?.plan?.tasks ?? [];
  const agents = Object.entries(snapshot.tasks?.subagents.states ?? {});
  return <div className="cockpit-grid">
    <section className="cockpit-trace"><header><small>EXECUTION TRACE</small><h3>{goal?.objective ?? "当前会话尚未启动持久目标"}</h3></header>
      <ol>{plan.length === 0 ? <li data-state="pending"><i /><div><strong>等待执行计划</strong><small>TaskPlan 出现后会自动同步</small></div></li> : plan.map((task) => <li key={task.id} data-state={task.status}><i /><div><strong>{task.subject}</strong><small>{task.status}{task.result ? ` · ${task.result}` : ""}</small></div></li>)}</ol>
    </section>
    <aside className="cockpit-evidence"><section><small>目标状态</small><b data-phase={goal?.phase}>{goal?.phase ?? "idle"}</b><p>{goal ? `${goal.status} · worker ${goal.workerRounds} · verify ${goal.verifyRounds}` : "使用 /goal 启动带验证的长期任务"}</p>{goal && <><textarea className="cockpit-goal-editor" value={goalDraft} onChange={(event) => setGoalDraft(event.target.value)} aria-label="继续目标"/><div className="cockpit-goal-actions">{snapshot.activeSession?.busy && <button onClick={() => void window.flavorDesktop.interrupt()}>安全暂停</button>}<button disabled={!goalDraft.trim()} onClick={() => onCompose(`/goal ${goalDraft.trim()}`)}>以编辑目标继续</button></div></>}</section>
      <section><small>协作 Agent</small>{agents.length === 0 ? <p>没有活跃子 Agent</p> : agents.map(([id, state]) => <div className="cockpit-row" key={id}><code>{id}</code><span data-state={state}>{state}</span></div>)}</section>
      <section><small>后台作业</small>{snapshot.jobs.length === 0 ? <p>没有后台作业</p> : snapshot.jobs.map((job) => <div className="cockpit-row" key={job.id}><code>{job.label}</code><span data-state={job.state}>{job.state}</span></div>)}</section>
      {goal && goal.evidenceRounds.length > 0 && <section><small>验证证据</small>{goal.evidenceRounds.slice(-3).reverse().map((evidence) => <div className="cockpit-evidence-round" key={evidence.round}><b>ROUND {evidence.round}</b><p>{evidence.hostVerification?.summary ?? `workspace ${evidence.workspaceDiffHash.slice(0, 10)}`}</p><span data-passed={evidence.hostVerification?.passed}>{evidence.hostVerification === undefined ? "workspace evidence" : evidence.hostVerification.passed ? "passed" : "failed"}</span></div>)}</section>}
      {goal && goal.lastGaps.length > 0 && <section><small>验证缺口</small>{goal.lastGaps.map((gap, i) => <p className="cockpit-gap" key={i}>{gap.description}</p>)}</section>}
    </aside>
  </div>;
}

function Timeline({ onError }: { onError(message: string): void }): React.JSX.Element {
  const [value, setValue] = useState<DesktopHistorySnapshot>({ leafId: null, nodes: [] }); const [label, setLabel] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => window.flavorDesktop.historySnapshot().then(setValue).catch((e) => onError(errorText(e)));
  useEffect(() => { void load(); }, []);
  const act = async (run: () => Promise<unknown>) => { setBusy(true); try { await run(); await load(); } catch (e) { onError(errorText(e)); } finally { setBusy(false); } };
  const rows = sessionTreeRows(value.nodes);
  return <div className="timeline-layout"><section className="timeline-canvas"><header><small>SESSION TREE</small><h3>{value.nodes.length} 个可恢复节点</h3></header><ol>{rows.map(({ node, depth }) => <li className="timeline-node" style={{ paddingLeft: depth * 26 }} key={node.id} data-depth={depth} data-current={node.id === value.leafId}><i /><div><strong>{node.prompt || node.id}</strong><small>{new Date(node.createdAt).toLocaleString()} · {node.checkpointId}</small></div><div><button disabled={busy} onClick={() => void act(() => window.flavorDesktop.rewindHistory(node.id))}>回到这里</button><button disabled={busy} onClick={() => { if (window.confirm("从这个节点建立新分支？当前上下文将切换。")) void act(() => window.flavorDesktop.forkHistory(node.id)); }}>Fork</button></div></li>)}</ol></section><aside className="timeline-actions"><h3>建立安全点</h3><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：重构前" /><button disabled={busy} onClick={() => void act(() => window.flavorDesktop.createCheckpoint(label || undefined))}>创建 checkpoint</button><button disabled={busy} onClick={() => void act(() => window.flavorDesktop.unrevertHistory())}>撤销上次回退</button></aside></div>;
}

function TerminalPane({ onError, onDiscover }: { onError(message: string): void; onDiscover(text: string): void }): React.JSX.Element {
  const [terms, setTerms] = useState<readonly TerminalSnapshot[]>([]);
  const [active, setActive] = useState<string>();
  const activeTerminal = terms.find((item) => item.id === active);
  const applyItems = (items: readonly TerminalSnapshot[], preferred?: string) => {
    const visible = items.filter((item) => item.state !== "closed");
    setTerms(visible);
    setActive((current) => reconcileTerminalSelection(preferred ?? current, visible));
  };
  const load = async (preferred?: string) => applyItems(await window.flavorDesktop.listTerminals(), preferred);
  useEffect(() => { void load().catch((error) => onError(errorText(error))); }, []);
  const open = async () => {
    try {
      const terminal = await window.flavorDesktop.openTerminal();
      await load(terminal.id);
    } catch (error) { onError(errorText(error)); }
  };
  const close = async () => {
    if (active === undefined) return;
    try {
      await window.flavorDesktop.closeTerminal(active);
      await load();
    } catch (error) { onError(errorText(error)); }
  };
  return <div className="terminal-layout"><aside><button className="primary" onClick={() => void open()}>＋ 新终端</button>{terms.map((term) => <button key={term.id} data-active={term.id === active} onClick={() => setActive(term.id)} title={term.shell}><strong>{terminalShellName(term.shell)}</strong><small>{term.state} · {term.id}</small></button>)}</aside><main><header><span title={activeTerminal?.cwd}>{activeTerminal?.cwd ?? "尚未打开终端"}</span>{activeTerminal && <button onClick={() => void close()}>关闭终端</button>}</header>{activeTerminal === undefined ? <div className="terminal-empty"><b>没有打开终端</b><span>新建终端后，直接在终端区域输入和操作。</span></div> : <React.Suspense fallback={<div className="terminal-empty"><b>正在连接终端</b><span>正在加载交互渲染器…</span></div>}><InteractiveTerminal key={activeTerminal.id} terminal={activeTerminal} onError={onError} onDiscover={onDiscover} /></React.Suspense>}</main></div>;
}

function ReviewPane({ onError, onCompose }: { onError(message: string): void; onCompose(value: string): void }): React.JSX.Element {
  const [scope, setScope] = useState<"working" | "staged" | "commit" | "base" | "last-turn">("working"); const [target, setTarget] = useState(""); const [diff, setDiff] = useState(""); const [loading, setLoading] = useState(false); const [selectedPath, setSelectedPath] = useState<string>(); const [selectedHunk, setSelectedHunk] = useState<string>();
  const files = useMemo(() => parseReviewDiff(diff), [diff]);
  const selectedFile = files.find((file) => file.path === selectedPath) ?? files[0];
  const load = async () => { setLoading(true); try { const next = await window.flavorDesktop.gitReview(scope, target || undefined); setDiff(next); const parsed = parseReviewDiff(next); setSelectedPath(parsed[0]?.path); setSelectedHunk(parsed[0]?.hunks[0]?.id); } catch (e) { onError(errorText(e)); } finally { setLoading(false); } };
  useEffect(() => {
    if (scope === "commit" || scope === "base") { setDiff(""); setSelectedPath(undefined); setSelectedHunk(undefined); return; }
    void load();
  }, [scope]);
  const handoff = () => onCompose(`/review 请审查 ${scope}${target ? ` ${target}` : ""}${selectedFile ? ` 中的 ${selectedFile.path}` : ""}，按 P0/P1/P2 分级输出发现，必须给出文件行号和触发场景。`);
  return <div className="review-layout">
    <aside className="review-scope"><small>DIFF SCOPE</small>{(["working", "staged", "last-turn", "commit", "base"] as const).map((item) => <button data-active={scope === item} key={item} onClick={() => setScope(item)}>{item}</button>)}{(scope === "commit" || scope === "base") && <><input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={scope === "base" ? "main / origin/main" : "commit SHA"}/><button onClick={() => void load()}>载入范围</button></>}</aside>
    <section className="review-files" aria-label="变更文件"><header><strong>文件</strong><span>{files.length}</span></header>{files.map((file) => <button data-active={file.path === selectedFile?.path} key={file.path} onClick={() => { setSelectedPath(file.path); setSelectedHunk(file.hunks[0]?.id); }}><strong>{file.path.split("/").at(-1)}</strong><small>{file.path}</small><span><b>+{file.additions}</b><em>-{file.deletions}</em></span></button>)}</section>
    <main><header><div><strong>{selectedFile?.path ?? scope}</strong><span>{selectedFile?.hunks.length ?? 0} hunks</span></div><button onClick={handoff}>交给 Agent 审查</button></header>
      {selectedFile && selectedFile.hunks.length > 0 && <nav className="review-hunks" aria-label="Hunk 导航">{selectedFile.hunks.map((hunk, index) => <button data-active={selectedHunk === hunk.id} key={hunk.id} onClick={() => setSelectedHunk(hunk.id)}>H{index + 1}<span>{hunk.header}</span></button>)}</nav>}
      <ReviewCode file={selectedFile} activeHunk={selectedHunk} loading={loading} empty={diff} />
      <footer className="review-priority-legend"><span data-priority="0">P0 阻断</span><span data-priority="1">P1 高风险</span><span data-priority="2">P2 一般</span><small>审查结果将在对话中返回，并携带文件行号。</small></footer>
    </main>
  </div>;
}

function ReviewCode({ file, activeHunk, loading, empty }: { file: ReviewFile | undefined; activeHunk: string | undefined; loading: boolean; empty: string }): React.JSX.Element {
  if (loading) return <div className="review-empty">正在生成 diff…</div>;
  if (file === undefined) return <div className="review-empty">{empty || "此范围没有差异"}</div>;
  return <div className="review-code" role="region" aria-label={`${file.path} 差异`}><pre>{file.lines.map((line, index) => {
    const hunk = file.hunks.find((item) => index >= item.start && index < item.end);
    const kind = line.startsWith("+++") || line.startsWith("---") ? "meta" : line.startsWith("+") ? "addition" : line.startsWith("-") ? "deletion" : line.startsWith("@@") ? "hunk" : "context";
    return <code key={index} data-kind={kind} data-active={hunk?.id === activeHunk}>{line || " "}</code>;
  })}</pre></div>;
}

function PreviewPane({ onError, suggestions }: { onError(message: string): void; suggestions: readonly string[] }): React.JSX.Element {
  const [input, setInput] = useState("http://localhost:3000"); const [url, setUrl] = useState<string>(); const [key, setKey] = useState(0);
  const go = async () => { try { setUrl(await window.flavorDesktop.validatePreviewUrl(input)); } catch (e) { onError(errorText(e)); } };
  return <div className="preview-layout"><header><input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void go(); }} /><button onClick={() => void go()}>打开</button><button disabled={!url} onClick={() => setKey((v) => v + 1)}>刷新</button><button disabled={!url} onClick={() => { if (url) void window.flavorDesktop.openPreviewUrl(url); }}>外部打开</button><button disabled={!url} onClick={() => { if (url) void navigator.clipboard.writeText(url); }}>复制</button></header>{suggestions.length > 0 && <div className="preview-suggestions">检测到：{suggestions.map((item) => <button key={item} onClick={() => { setInput(item); void window.flavorDesktop.validatePreviewUrl(item).then(setUrl).catch((e) => onError(errorText(e))); }}>{item}</button>)}</div>}{url ? <iframe key={key} src={url} title="本地应用预览" sandbox="allow-forms allow-modals allow-popups allow-scripts allow-same-origin" /> : <div className="preview-empty"><strong>安全的本地预览</strong><p>仅允许 localhost、127.0.0.1 和 ::1 的 HTTP(S) 地址。</p></div>}</div>;
}

function ContextPane({ snapshot, onError }: { snapshot: DesktopSnapshot; onError(message: string): void }): React.JSX.Element {
  const [value, setValue] = useState<DesktopWorkbenchInspection>(); useEffect(() => { void window.flavorDesktop.inspectWorkbench().then(setValue).catch((e) => onError(errorText(e))); }, []);
  return <div className="context-grid"><section><header><small>RUNTIME</small><h3>上下文 Epoch</h3></header><dl><dt>Permission</dt><dd>{snapshot.activeSession?.permissionMode ?? "—"}</dd><dt>Model</dt><dd>{snapshot.activeSession?.mainModel ?? "—"}</dd><dt>Checkout</dt><dd>{snapshot.activeSession?.workingDirectory ?? snapshot.workspace ?? "—"}</dd></dl>{value?.context?.epoch !== undefined && <pre className="context-record">{JSON.stringify(value.context.epoch, null, 2)}</pre>}{value?.context?.visibility.map((item, i) => <pre className="context-record" key={i}>{JSON.stringify(item, null, 2)}</pre>)}{value?.context?.usage.map((item, i) => <pre className="context-record" key={`usage-${i}`}>{JSON.stringify(item, null, 2)}</pre>)}{snapshot.diagnostics.map((item, i) => <p key={`diag-${i}`} className="context-record">{item}</p>)}</section><section><header><small>INSTRUCTIONS</small><h3>生效的项目指令</h3></header>{value?.instructions.map((file) => <details key={file.path}><summary>{file.name}</summary><pre>{file.content}</pre></details>)}</section><section><header><small>SAFETY</small><h3>权限规则与审计</h3></header>{value?.permissionFiles.map((file) => <details key={file.path}><summary>{file.tier} · {file.path}</summary><pre>{file.content}</pre></details>)}{value?.audit.slice(0, 30).map((record, i) => <pre className="context-record" key={i}>{JSON.stringify(record, null, 2)}</pre>)}</section></div>;
}

function AstPane({ onError, onCompose }: { onError(message: string): void; onCompose(value: string): void }): React.JSX.Element {
  const [status, setStatus] = useState<DesktopAstStatus>(); const [query, setQuery] = useState(""); const [nodes, setNodes] = useState<readonly DesktopAstNode[]>([]); const [selected, setSelected] = useState<DesktopAstNode>(); const [relations, setRelations] = useState<DesktopAstRelations>(); const [hops, setHops] = useState(2); const [loading, setLoading] = useState(false);
  useEffect(() => { void window.flavorDesktop.astStatus().then(setStatus).catch((e) => onError(errorText(e))); }, []);
  const search = async () => { try { setNodes(await window.flavorDesktop.astSearch(query)); } catch (e) { onError(errorText(e)); } };
  const choose = async (node: DesktopAstNode, depth = hops) => { setSelected(node); setLoading(true); try { setRelations(await window.flavorDesktop.astRelations(node.id, depth)); } catch (e) { onError(errorText(e)); } finally { setLoading(false); } };
  const graph = selected === undefined || relations === undefined ? undefined : buildAstGraphModel(selected, relations);
  return <div className="ast-layout">
    <aside className="ast-symbols"><header><div><small>SYMBOL INDEX</small><strong>代码索引</strong></div><span data-ready={status?.available}>{status?.available ? <><b>{status.nodes}</b> symbols<br/><b>{status.edges}</b> edges</> : "尚未建立索引"}</span></header><form onSubmit={(e) => { e.preventDefault(); void search(); }}><span aria-hidden="true">⌕</span><input aria-label="搜索代码符号" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="函数、类型或模块"/><button>搜索</button></form><div className="ast-symbol-list">{nodes.length === 0 ? <p>{status?.available === false ? "项目尚未建立代码索引" : "输入名称，定位代码中的关键符号"}</p> : nodes.map((node) => <button data-active={node.id === selected?.id} key={node.id} onClick={() => void choose(node)}><span><strong>{node.name}</strong><em>{node.kind}</em></span><small>{node.filePath}:{node.startLine}</small></button>)}</div></aside>
    <main className="ast-graph-stage"><header><div><small>RELATION MAP</small><h3>{selected?.qualifiedName ?? "代码关系浏览器"}</h3><code>{selected ? `${selected.filePath}:${selected.startLine}-${selected.endLine}` : "搜索并选择一个符号作为图中心"}</code></div><div className="ast-depth" aria-label="影响深度"><span>影响深度</span>{[1, 2, 3, 4].map((depth) => <button aria-label={`${depth} 层影响深度`} data-active={hops === depth} key={depth} onClick={() => { setHops(depth); if (selected) void choose(selected, depth); }}>{depth}</button>)}</div></header>
      {loading ? <div className="ast-graph-empty">正在展开关系图…</div> : graph ? <AstGraphCanvas graph={graph} selected={selected!} onSelect={(node) => void choose(node)} /> : <div className="ast-graph-empty"><strong>从一个符号开始</strong><p>搜索函数、类或模块，在同一张图上查看调用者、被调用项和多跳影响范围。</p></div>}
    </main>
    <aside className="ast-inspector"><header><div><small>SYMBOL INSPECTOR</small><h3>{selected?.name ?? "未选择符号"}</h3></div>{selected && <span>{selected.kind}</span>}</header>{selected ? <><dl><dt>语言</dt><dd>{selected.language}</dd><dt>位置</dt><dd>{selected.filePath}:{selected.startLine}</dd>{selected.signature && <><dt>签名</dt><dd>{selected.signature}</dd></>}</dl><button className="ast-compose" onClick={() => onCompose(`请查看 @${selected.filePath}#L${selected.startLine}-L${selected.endLine} 中的 ${selected.qualifiedName}`)}><span>加入输入框</span><b aria-hidden="true">↗</b></button><Relation title="Callers" nodes={relations?.callers ?? []} onSelect={(node) => void choose(node)}/><Relation title="Callees" nodes={relations?.callees ?? []} onSelect={(node) => void choose(node)}/><Relation title="Impact" nodes={relations?.impact ?? []} onSelect={(node) => void choose(node)}/></> : <p className="ast-inspector-empty">选择一个符号后，这里会显示源码位置和完整关系。</p>}</aside>
  </div>;
}

function AstGraphCanvas({ graph, selected, onSelect }: { graph: AstGraphModel; selected: DesktopAstNode; onSelect(node: DesktopAstNode): void }): React.JSX.Element {
  const initialViewport: AstGraphViewport = { x: 0, y: 0, scale: 1 };
  const [viewport, setViewport] = useState<AstGraphViewport>(initialViewport);
  const [canvasSize, setCanvasSize] = useState<AstGraphCanvasSize>({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  useEffect(() => { setViewport(initialViewport); }, [selected.id]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const measure = () => { const bounds = canvas.getBoundingClientRect(); setCanvasSize({ width: bounds.width, height: bounds.height }); };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  const zoom = (requestedScale: number, point?: { x: number; y: number }) => {
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center = point ?? { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 };
    setViewport((current) => zoomAstGraphViewport(current, center, requestedScale));
  };
  const finishDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = undefined; setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div ref={canvasRef} className="ast-graph" data-dragging={dragging} role="region" aria-label={`${selected.name} 代码关系图，可拖动和滚轮缩放`}
    onWheel={(event) => { event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); zoom(viewport.scale * Math.exp(-event.deltaY * 0.0014), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }); }}
    onPointerDown={(event) => { if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY }; setDragging(true); }}
    onPointerMove={(event) => { const drag = dragRef.current; if (drag?.pointerId !== event.pointerId) return; const dx = event.clientX - drag.x; const dy = event.clientY - drag.y; dragRef.current = { ...drag, x: event.clientX, y: event.clientY }; setViewport((current) => ({ ...current, x: current.x + dx, y: current.y + dy })); }}
    onPointerUp={finishDrag} onPointerCancel={finishDrag}>
    <div className="ast-graph-viewport" style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">{graph.edges.map((edge, index) => { const from = byId.get(edge.from); const to = byId.get(edge.to); if (!from || !to) return null; const middle = (from.x + to.x) / 2; return <path data-kind={edge.kind} key={`${edge.from}-${edge.to}-${index}`} d={`M ${from.x} ${from.y} C ${middle} ${from.y}, ${middle} ${to.y}, ${to.x} ${to.y}`}/>; })}</svg>
    </div>
    {graph.nodes.map((node) => { const point = projectAstGraphPoint(node, viewport, canvasSize); return <button className="ast-graph-node" data-role={node.role} key={node.id} style={{ left: point.x, top: point.y, visibility: canvasSize.width > 0 ? "visible" : "hidden" }} onClick={() => onSelect(node)} title={`${node.qualifiedName}\n${node.filePath}:${node.startLine}`}><i/><span><strong>{node.name}</strong><small>{node.role === "impact" ? `hop ${node.hop}` : node.kind}</small></span></button>; })}
    <div className="ast-graph-hint"><span aria-hidden="true">↔</span> 拖动平移 <i/> 滚轮缩放</div>
    <div className="ast-graph-controls" aria-label="画布缩放"><button aria-label="放大" onClick={() => zoom(viewport.scale * 1.2)}>＋</button><span>{Math.round(viewport.scale * 100)}%</span><button aria-label="缩小" onClick={() => zoom(viewport.scale / 1.2)}>−</button><button className="ast-graph-reset" aria-label="复位画布" onClick={() => setViewport(initialViewport)}>复位</button></div>
    <div className="ast-graph-legend"><span data-kind="caller">调用者</span><span data-kind="origin">中心符号</span><span data-kind="callee">被调用</span><span data-kind="impact">影响范围</span></div>
  </div>;
}

function Relation({ title, nodes, onSelect }: { title: string; nodes: readonly DesktopAstNode[]; onSelect(node: DesktopAstNode): void }): React.JSX.Element { return <section className="ast-relation"><h4>{title}<span>{nodes.length}</span></h4>{nodes.length === 0 ? <p>没有关系记录</p> : nodes.slice(0, 20).map((node) => <button key={node.id} onClick={() => onSelect(node)}><strong>{node.name}</strong><code>{node.filePath}:{node.startLine}</code></button>)}</section>; }

export function PalsPane({ onError }: { onError(message: string): void }): React.JSX.Element {
  type Action = "chat" | "task" | "cowork" | "refresh" | "cancel";
  const [pals, setPals] = useState<readonly DesktopPalPresence[]>([]);
  const [selected, setSelected] = useState<string>();
  const [message, setMessage] = useState("");
  const [goal, setGoal] = useState("");
  const [coWork, setCoWork] = useState<unknown>();
  const [unavailable, setUnavailable] = useState<string>();
  const [busy, setBusy] = useState<Action>();
  const [notice, setNotice] = useState<string>();
  const load = () => window.flavorDesktop.listPals().then((items) => {
    setUnavailable(undefined);
    setPals(items);
    setSelected((old) => items.some((item) => item.alias === old) ? old : items[0]?.alias);
  }).catch((error) => { setPals([]); setUnavailable(errorText(error)); });
  useEffect(() => { void load(); const timer = window.setInterval(load, 4000); return () => window.clearInterval(timer); }, []);
  const run = async (action: Action, operation: () => Promise<unknown>, success: (result: unknown) => void) => {
    setBusy(action); setNotice(undefined);
    try { success(await operation()); } catch (error) { onError(errorText(error)); }
    finally { setBusy(undefined); }
  };
  const selectedPal = pals.find((pal) => pal.alias === selected);
  const selectedAlias = selectedPal?.alias;
  const coWorkRecord = typeof coWork === "object" && coWork !== null ? coWork as Record<string, unknown> : undefined;
  const coWorkId = typeof coWorkRecord?.coWorkId === "string" ? coWorkRecord.coWorkId : undefined;
  const coWorkStatus = typeof coWorkRecord?.status === "string" ? coWorkRecord.status : "created";
  const send = (kind: "chat" | "task") => {
    if (selectedAlias === undefined || !message.trim()) return;
    void run(kind, () => window.flavorDesktop.sendPalMessage(selectedAlias, message.trim(), kind), () => {
      setMessage(""); setNotice(kind === "chat" ? `消息已发送给 ${selectedAlias}` : `任务已委托给 ${selectedAlias}`);
    });
  };
  const start = () => {
    if (selectedAlias === undefined || !goal.trim()) return;
    void run("cowork", () => window.flavorDesktop.startCoWork(selectedAlias, goal.trim()), (result) => {
      setCoWork(result); setGoal(""); setNotice(`已与 ${selectedAlias} 建立共同目标`);
    });
  };
  return <div className="pals-layout">
    <aside>
      <header><div><small>LOCAL BROKER</small><h3>在线 Pals</h3></div><span>{pals.length}</span></header>
      {unavailable !== undefined ? <div className="pals-unavailable"><strong>正在恢复本地协作</strong><p>broker 暂时不可用，工作台会自动重试。</p><button onClick={() => void load()}>立即重试</button></div> : pals.length === 0 && <div className="pals-list-empty"><b>等待其他实例</b><p>同一台设备上的 Flavor 实例上线后会出现在这里。</p></div>}
      <div className="pals-list">{pals.map((pal) => <button key={pal.id} data-active={selected === pal.alias} onClick={() => { setSelected(pal.alias); setNotice(undefined); }}><span className="pal-presence"><i/></span><div><strong>{pal.alias}</strong><small title={pal.projectPath ?? pal.id}>{pal.projectPath ?? pal.id}</small></div><em>在线</em></button>)}</div>
    </aside>
    <main>
      <header className="pals-channel-header"><div><small>CO-WORK CHANNEL</small><h3>{selectedAlias ?? "没有选中 Pal"}</h3><p title={selectedPal?.projectPath}>{selectedPal?.projectPath ?? "从左侧选择一个在线实例后即可发送消息、委托任务或共同执行目标。"}</p></div><span data-online={selectedPal !== undefined}><i/>{selectedPal === undefined ? "等待选择" : "连接正常"}</span></header>
      <div className="pals-compose-grid">
        <section className="pal-compose-card" data-kind="message"><header><span>MESSAGE</span><div><h4>发消息或委托任务</h4><p>同一段内容，可以即时沟通，也可以交给对方独立执行。</p></div></header><label><span>内容</span><textarea aria-label="消息或任务内容" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="写下背景、期望结果和必要约束…"/></label><footer><small>{message.length === 0 ? "建议说明交付结果" : `${message.length} 字符`}</small><div><button disabled={busy !== undefined || selectedAlias === undefined || !message.trim()} onClick={() => send("chat")}><b>{busy === "chat" ? "发送中…" : "发送 Chat"}</b><span>直接沟通</span></button><button disabled={busy !== undefined || selectedAlias === undefined || !message.trim()} onClick={() => send("task")}><b>{busy === "task" ? "委托中…" : "委托 Task"}</b><span>异步执行</span></button></div></footer></section>
        <section className="pal-compose-card" data-kind="cowork"><header><span>CO-WORK</span><div><h4>共同完成一个目标</h4><p>双方先共同规划，再持续同步执行状态与结果。</p></div></header><label><span>共同目标</span><textarea aria-label="共同目标" value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="描述目标、完成标准和双方需要协作的部分…"/></label><footer><small>{goal.length === 0 ? "适合跨实例并行工作" : `${goal.length} 字符`}</small><button className="primary" disabled={busy !== undefined || selectedAlias === undefined || !goal.trim()} onClick={start}><b>{busy === "cowork" ? "建立中…" : "开始 Co-work"}</b><span>共同规划并执行</span></button></footer></section>
      </div>
      {notice !== undefined && <div className="pals-notice"><i/> {notice}</div>}
      {coWork !== undefined && <section className="cowork-state"><header><div><small>LIVE CO-WORK</small><strong>最新协作状态</strong></div><span data-status={coWorkStatus}>{coWorkStatus}</span><nav><button disabled={busy !== undefined} onClick={() => void run("refresh", () => window.flavorDesktop.coWorkStatus(coWorkId), setCoWork)}>刷新状态</button>{coWorkId && <button className="danger" disabled={busy !== undefined} onClick={() => { if (window.confirm("取消这个 Co-work？")) void run("cancel", () => window.flavorDesktop.cancelCoWork(coWorkId, "cancelled from desktop workbench"), (result) => { setCoWork(result); setNotice("协作已取消"); }); }}>取消协作</button>}</nav></header><details><summary>查看原始协作数据</summary><pre>{JSON.stringify(coWork, null, 2)}</pre></details></section>}
    </main>
  </div>;
}

function WorktreePane({ snapshot, onError }: { snapshot: DesktopSnapshot; onError(message: string): void }): React.JSX.Element {
  const [items, setItems] = useState<readonly DesktopWorktree[]>([]); const load = () => window.flavorDesktop.listWorktrees().then(setItems).catch((e) => onError(errorText(e))); useEffect(() => { void load(); }, []);
  return <div className="worktree-pane"><header><div><small>TASK ISOLATION</small><h3>工作树</h3><p>新任务可在独立分支中运行，不改动当前检出。</p></div><span>{items.length} active</span></header>{items.length === 0 ? <div className="manager-empty">还没有隔离工作树。新建任务时选择“隔离工作树”。</div> : <div className="worktree-list">{items.map((item) => <article key={item.id} data-current={snapshot.activeSession?.worktreeId === item.id}><div><i/><strong>{item.branch}</strong><small>{item.path}</small></div><span data-dirty={item.dirty}>{item.merged ? "merged" : item.dirty ? "dirty" : "clean"}</span><div className="worktree-actions"><button disabled={item.dirty || item.merged} onClick={() => { if (window.confirm(`将 ${item.branch} 合并回当前项目分支？`)) void window.flavorDesktop.mergeWorktree(item.id).then(load).catch((e) => onError(errorText(e))); }}>合并交付</button><button onClick={() => { if (window.confirm(`移除工作树 ${item.branch}？${item.dirty ? "存在未提交变更，将强制移除。" : "分支会保留。"}`)) void window.flavorDesktop.removeWorktree(item.id, item.dirty).then(load).catch((e) => onError(errorText(e))); }}>移除并保留分支</button></div></article>)}</div>}</div>;
}

function errorText(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function loopbackUrls(value: string): string[] { return value.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?)(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi) ?? []; }
