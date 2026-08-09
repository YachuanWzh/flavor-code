import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { D2cElementDiff, D2cRect, D2cUnmatchedElement } from "../../d2c/types.js";
import type { D2cImportResult, D2cReportListItem, D2cReportView } from "../contracts.js";
import { fitCanvas, focusCanvasRect, zoomCanvasAt, type CanvasTransform } from "./d2c-canvas.js";
import type { D2cExecutionPhase, D2cFramework, D2cPendingTask, D2cProgressActivity } from "./d2c-progress.js";

interface D2cViewerProps {
  onClose(): void;
  onInterrupt(): void;
  onError(message: string): void;
  refreshKey: number;
  onStartTask(prompt: string): Promise<boolean>;
  pending?: D2cPendingTask | undefined;
  onLaunch(task: string, framework: D2cFramework): void;
  disabled?: boolean;
}

const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ANNOTATION_LIMIT = 240;
const INITIAL_ISSUE_LIMIT = 120;

function buildTaskPrompt(
  task: string,
  entryHtml: string,
  fileCount: number,
  pages: D2cImportResult["pages"],
  framework: D2cFramework,
): string {
  const frameworkLabel = framework === "vue" ? "Vue 3" : "React";
  const pagePlan = pages.map((page, index) => `${index + 1}. ${page.label} → ${page.html}`).join("；");
  return [
    `执行 D2C 任务“${task}”：Pixso 设计稿已导入 .flavor/d2c/${task}/design/（入口 ${entryHtml}，共 ${fileCount} 个文件）。`,
    `设计稿包含 ${pages.length} 个页面：${pagePlan}。请为每个页面生成同名 HTML 入口，保证 D2cCompare 可逐页访问。`,
    `请用 ${frameworkLabel} 像素级实现该设计稿，在 src/d2c-output/${task}/ 生成可运行的 Vite 项目。`,
    "完成后调用 D2cCompare 对比设计稿与运行中的实现。根据报告修复实现代码，不要修改设计稿；评测无效时先修复环境问题。",
    "为控制耗时，最多调用 3 次 D2cCompare（首次评测 + 两轮集中修复）；每轮批量处理高影响内容与布局问题，达到 90 分后立即结束。",
    "如果 D2cCompare 失败，优先使用错误中附带的 npm/Vite 进程输出修复项目；不要读取工作区外的 npm 源码或缓存日志。",
    "以报告的验收结论为准，文本、图片等内容错误不得用高像素分绕过，最后汇报总分、可信度和未解决问题。",
  ].join("\n");
}

export async function dispatchD2cTask(
  prompt: string,
  task: string,
  framework: D2cFramework,
  submit: (prompt: string) => Promise<boolean>,
  onLaunch: (task: string, framework: D2cFramework) => void,
): Promise<boolean> {
  const submitted = await submit(prompt);
  if (submitted) onLaunch(task, framework);
  return submitted;
}

export async function importAndDispatchD2cTask(
  task: string,
  framework: D2cFramework,
  importDesign: () => Promise<D2cImportResult | undefined>,
  submit: (prompt: string) => Promise<boolean>,
  onLaunch: (task: string, framework: D2cFramework) => void,
): Promise<boolean> {
  const imported = await importDesign();
  if (imported === undefined) return false;
  return dispatchD2cTask(
    buildTaskPrompt(imported.task, imported.entryHtml, imported.files.length, imported.pages, framework),
    task,
    framework,
    submit,
    onLaunch,
  );
}

type D2cViewMode = "overlay" | "wipe" | "blink" | "design" | "implementation" | "heatmap";
type IssueFilter = "all" | "blocking" | "content" | "geometry";

const MODE_LABELS: Record<D2cViewMode, string> = {
  overlay: "叠加",
  wipe: "拉帘",
  blink: "闪烁",
  design: "设计稿",
  implementation: "实现",
  heatmap: "热力图",
};

const VERDICT_LABELS = { pass: "通过", conditional: "有条件通过", fail: "未通过", invalid: "评测未完成" } as const;
const CONFIDENCE_LABELS = { high: "高可信", medium: "中可信", low: "低可信" } as const;

export function resultPresentation(input: {
  total: number;
  status: "valid" | "warning" | "invalid";
  confidence?: "high" | "medium" | "low";
}): { primary: string; label: string; diagnostic?: string; showConfidence: boolean } {
  if (input.status === "invalid") {
    return {
      primary: "—",
      label: "评测未完成",
      diagnostic: `已采集区域相似度 ${input.total.toFixed(1)}`,
      showConfidence: false,
    };
  }
  return { primary: input.total.toFixed(1), label: "有效评分", showConfidence: true };
}

interface WorkbenchIssue {
  kind: "changed" | "missing" | "extra";
  fingerprint: string;
  label: string;
  severity: "minor" | "major";
  impact: number;
  designRect?: D2cRect;
  implementationRect?: D2cRect;
  selector?: string;
  diff?: D2cElementDiff;
  unmatched?: D2cUnmatchedElement;
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function issueDetails(issue: WorkbenchIssue): string[] {
  if (issue.kind === "missing") return ["设计稿中存在，实现中未找到"];
  if (issue.kind === "extra") return ["实现中存在，设计稿中没有"];
  const diff = issue.diff!;
  const lines: string[] = [];
  if (Math.max(Math.abs(diff.dx), Math.abs(diff.dy), Math.abs(diff.dw), Math.abs(diff.dh)) > 0) {
    lines.push(`位置 Δx ${formatSigned(diff.dx)}px · Δy ${formatSigned(diff.dy)}px · 尺寸 Δw ${formatSigned(diff.dw)}px · Δh ${formatSigned(diff.dh)}px`);
  }
  for (const item of diff.colorIssues) lines.push(`${item.property === "color" ? "文字色" : "背景色"} ${item.expected} → ${item.actual} · ΔE ${item.deltaE}`);
  for (const item of diff.fontIssues) lines.push(`${item.property} ${item.expected} → ${item.actual}`);
  if (diff.textIssue !== undefined) lines.push(`文本 “${diff.textIssue.expected}” → “${diff.textIssue.actual}”`);
  if (diff.imageIssue !== undefined) lines.push(`图片 ${diff.imageIssue.expected ? "应存在" : "应为空"} → ${diff.imageIssue.actual ? "实际存在" : "实际缺失"}`);
  return lines;
}

function EvidenceCrop({ src, rect, canvas, label }: { src: string; rect: D2cRect; canvas: { width: number; height: number }; label: string }): React.JSX.Element {
  const cropWidth = 148;
  const cropHeight = 92;
  const scale = Math.min(2, Math.max(cropWidth / Math.max(1, rect.width * 1.8), cropHeight / Math.max(1, rect.height * 1.8)));
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  return <figure className="d2c-evidence-crop">
    <div><img src={src} alt={label} draggable={false} style={{
      width: canvas.width * scale,
      height: canvas.height * scale,
      left: cropWidth / 2 - centerX * scale,
      top: cropHeight / 2 - centerY * scale,
    }} /></div>
    <figcaption>{label}</figcaption>
  </figure>;
}

function rectStyle(rect: D2cRect): React.CSSProperties {
  return { left: rect.x, top: rect.y, width: rect.width, height: rect.height };
}

const EXECUTION_PHASES: Array<{ id: D2cExecutionPhase; label: string; detail: string }> = [
  { id: "analyzing", label: "分析设计", detail: "读取结构与样式" },
  { id: "building", label: "生成代码", detail: "创建并集中修复" },
  { id: "evaluating", label: "视觉评测", detail: "渲染与像素对比" },
];

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes.toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

function phaseState(
  phase: D2cExecutionPhase,
  current: D2cExecutionPhase,
  comparisonCycle: number,
): "done" | "active" | "upcoming" {
  if (phase === current) return "active";
  const phaseIndex = EXECUTION_PHASES.findIndex((item) => item.id === phase);
  const currentIndex = EXECUTION_PHASES.findIndex((item) => item.id === current);
  if (phaseIndex < currentIndex) return "done";
  if (phase === "evaluating" && comparisonCycle > 0) return "done";
  return "upcoming";
}

function activityMeta(activity: D2cProgressActivity, now: number): string {
  const end = activity.completedAt ?? now;
  const elapsed = Math.max(0, end - activity.startedAt);
  if (activity.state === "running") return `${formatElapsed(elapsed)} · 进行中`;
  if (elapsed >= 1_000) return `耗时 ${formatElapsed(elapsed)}`;
  return new Date(activity.completedAt ?? activity.startedAt).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function D2cProgressView({ pending, onOpenLog, onInterrupt }: {
  pending: D2cPendingTask;
  onOpenLog(): void;
  onInterrupt(): void;
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const current = [...pending.activity].reverse().find((item) => item.state === "running") ?? pending.activity.at(-1);
  const recent = pending.activity.slice(-9);
  return <main className="d2c-progress-screen">
    <div className="d2c-progress-shell">
      <section className="d2c-progress-hero">
        <div className="d2c-progress-live"><i /><span>任务执行中</span><time>{formatElapsed(now - pending.startedAt)}</time></div>
        <div className="d2c-progress-heading">
          <div><p className="d2c-start-kicker">D2C BUILD TRACE</p><h2>正在生成“{pending.task}”</h2>
            <p>目标技术栈：{pending.framework === "vue" ? "Vue 3" : "React"}。完成后自动打开评测结果。</p></div>
          <button className="d2c-progress-stop" onClick={onInterrupt}>停止任务</button>
        </div>
        <div className="d2c-progress-current" aria-live="polite" aria-atomic="true">
          <span className="d2c-progress-pulse" aria-hidden="true" /><div><small>当前动作</small>
            <strong>{current?.label ?? "等待 Agent 返回执行计划"}</strong>{current?.detail && <code>{current.detail}</code>}</div>
        </div>
        <ol className="d2c-progress-track" aria-label="D2C 执行阶段">
          {EXECUTION_PHASES.map((item) => {
            const state = phaseState(item.id, pending.phase, pending.comparisonCycle);
            return <li key={item.id} data-state={state}>
              <span>{state === "done" ? "✓" : state === "active" ? "●" : "○"}</span>
              <div><strong>{item.label}</strong><small>{item.detail}</small></div>
            </li>;
          })}
        </ol>
        <div className="d2c-progress-context">
          <span>开始于 {new Date(pending.startedAt).toLocaleTimeString()}</span>
          <span>最近更新 {formatElapsed(now - pending.updatedAt)} 前</span>
          {pending.comparisonCycle > 0 && <span>第 {pending.comparisonCycle} 次评测</span>}
        </div>
      </section>

      <section className="d2c-activity-panel" aria-label="实时执行轨迹">
        <header><div><p>LIVE ACTIVITY</p><h3>实时执行轨迹</h3></div><button onClick={onOpenLog}>查看完整日志 ↗</button></header>
        <ol>
          {recent.map((activity) => <li key={activity.id} data-state={activity.state}>
            <span className="d2c-activity-node" aria-hidden="true" />
            <div><strong>{activity.label}</strong>{activity.detail && <small>{activity.detail}</small>}</div>
            <time>{activityMeta(activity, now)}</time>
          </li>)}
        </ol>
        <footer><span>日志会随真实工具调用更新</span><span>无虚拟百分比</span></footer>
      </section>
    </div>
  </main>;
}

export function D2cViewer({ onClose, onInterrupt, onError, refreshKey, onStartTask, pending, onLaunch, disabled = false }: D2cViewerProps): React.JSX.Element {
  const [reports, setReports] = useState<readonly D2cReportListItem[]>([]);
  const [bundle, setBundle] = useState<D2cReportView>();
  const [loading, setLoading] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [mode, setMode] = useState<D2cViewMode>("overlay");
  const [implOpacity, setImplOpacity] = useState(0.55);
  const [wipePosition, setWipePosition] = useState(50);
  const [selectedIssue, setSelectedIssue] = useState<string>();
  const [issueFilter, setIssueFilter] = useState<IssueFilter>("all");
  const [issueLimit, setIssueLimit] = useState(INITIAL_ISSUE_LIMIT);
  const [creating, setCreating] = useState(false);
  const [taskName, setTaskName] = useState("");
  const [framework, setFramework] = useState<D2cFramework>("vue");
  const [launching, setLaunching] = useState(false);
  const [transform, setTransform] = useState<CanvasTransform>({ scale: 1, x: 0, y: 0 });

  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const transformRef = useRef(transform);
  const frameRef = useRef<number | undefined>(undefined);
  const wheelCommitRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; originX: number; originY: number } | undefined>(undefined);
  const heldModeRef = useRef<D2cViewMode | undefined>(undefined);
  const reportRequestRef = useRef(0);
  const reportError = (cause: unknown): void => onError(cause instanceof Error ? cause.message : String(cause));

  const taskValid = TASK_PATTERN.test(taskName);
  const canvas = bundle === undefined ? undefined : {
    width: Math.max(bundle.report.design.width, bundle.report.implementation.width, 1),
    height: Math.max(bundle.report.design.height, bundle.report.implementation.height, 1),
  };

  const paintTransform = useCallback((next: CanvasTransform, commit: boolean) => {
    transformRef.current = next;
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    frameRef.current = requestAnimationFrame(() => {
      stageRef.current?.style.setProperty("--d2c-scale", String(next.scale));
      stageRef.current?.style.setProperty("--d2c-x", `${next.x}px`);
      stageRef.current?.style.setProperty("--d2c-y", `${next.y}px`);
      frameRef.current = undefined;
    });
    if (commit) setTransform(next);
  }, []);

  const fit = useCallback(() => {
    if (canvas === undefined || viewportRef.current === null) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    paintTransform(fitCanvas({ width: bounds.width, height: bounds.height }, canvas, 34), true);
  }, [canvas?.height, canvas?.width, paintTransform]);

  useEffect(() => {
    if (canvas === undefined || viewportRef.current === null) return;
    const observer = new ResizeObserver(fit);
    observer.observe(viewportRef.current);
    fit();
    return () => observer.disconnect();
  }, [canvas?.height, canvas?.width, fit]);

  useEffect(() => () => {
    if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    if (wheelCommitRef.current !== undefined) clearTimeout(wheelCommitRef.current);
  }, []);

  const loadBundle = useCallback(async (item: { task: string; reportId: string }) => {
    const request = ++reportRequestRef.current;
    setLoadingReport(true);
    try {
      const next = await window.flavorDesktop.getD2cReport(item.task, item.reportId);
      if (request !== reportRequestRef.current) return;
      setBundle(next);
      setCreating(false);
      setSelectedIssue(undefined);
      setIssueLimit(INITIAL_ISSUE_LIMIT);
    } finally {
      if (request === reportRequestRef.current) setLoadingReport(false);
    }
  }, []);

  const loadReports = useCallback(async (autoSelect?: { task: string; reportId: string }) => {
    const entries = await window.flavorDesktop.listD2cReports();
    setReports(entries);
    const first = autoSelect ?? entries[0];
    if (first !== undefined) await loadBundle(first);
    else { setBundle(undefined); setCreating(true); }
  }, [loadBundle]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadReports().catch((cause) => { if (active) reportError(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; reportRequestRef.current += 1; };
  }, [refreshKey, loadReports]);

  const startD2c = async (): Promise<void> => {
    if (!taskValid || launching || disabled) return;
    setLaunching(true);
    try {
      await importAndDispatchD2cTask(
        taskName,
        framework,
        () => window.flavorDesktop.importD2cDesign(taskName),
        onStartTask,
        onLaunch,
      );
    } catch (cause) { reportError(cause); }
    finally { setLaunching(false); }
  };

  const allIssues = useMemo<WorkbenchIssue[]>(() => {
    if (bundle === undefined) return [];
    const changed = bundle.report.diffs.map((diff): WorkbenchIssue => ({
      kind: "changed", fingerprint: diff.fingerprint, label: diff.label, severity: diff.severity,
      impact: diff.impact, designRect: diff.designRect, implementationRect: diff.implRect,
      ...((diff.implementationSelector ?? diff.designSelector) === undefined ? {} : { selector: diff.implementationSelector ?? diff.designSelector }), diff,
    }));
    const missing = bundle.report.missing.map((item): WorkbenchIssue => ({
      kind: "missing", fingerprint: item.fingerprint, label: item.label, severity: item.severity,
      impact: item.impact, designRect: item.rect, ...(item.selector === undefined ? {} : { selector: item.selector }), unmatched: item,
    }));
    const extra = bundle.report.extra.map((item): WorkbenchIssue => ({
      kind: "extra", fingerprint: item.fingerprint, label: item.label, severity: item.severity,
      impact: item.impact, implementationRect: item.rect, ...(item.selector === undefined ? {} : { selector: item.selector }), unmatched: item,
    }));
    return [...changed, ...missing, ...extra].sort((left, right) => right.impact - left.impact || left.fingerprint.localeCompare(right.fingerprint));
  }, [bundle]);

  const filteredIssues = useMemo(() => allIssues.filter((issue) => {
    if (issueFilter === "blocking") return issue.severity === "major" || issue.impact >= 8;
    if (issueFilter === "content") return issue.kind === "missing" || issue.diff?.textIssue !== undefined || issue.diff?.imageIssue !== undefined;
    if (issueFilter === "geometry") return issue.diff !== undefined && Math.max(Math.abs(issue.diff.dx), Math.abs(issue.diff.dy), Math.abs(issue.diff.dw), Math.abs(issue.diff.dh)) > 0;
    return true;
  }), [allIssues, issueFilter]);
  const activeIssue = allIssues.find((issue) => issue.fingerprint === selectedIssue);
  const annotations = allIssues.slice(0, ANNOTATION_LIMIT);

  const focusIssue = (issue: WorkbenchIssue): void => {
    setSelectedIssue(issue.fingerprint);
    const rect = issue.designRect ?? issue.implementationRect;
    if (rect === undefined || canvas === undefined || viewportRef.current === null) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    paintTransform(focusCanvasRect(rect, { width: bounds.width, height: bounds.height }, canvas), true);
  };

  const zoom = (factor: number, anchor?: { x: number; y: number }, commit = true): void => {
    if (viewportRef.current === null) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    paintTransform(zoomCanvasAt(transformRef.current, transformRef.current.scale * factor, anchor ?? { x: bounds.width / 2, y: bounds.height / 2 }), commit);
  };

  const updateWipeFromPointer = (clientX: number, commit: boolean): void => {
    if (canvas === undefined || viewportRef.current === null) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    const value = Math.max(0, Math.min(100,
      ((clientX - bounds.left - transformRef.current.x) / (canvas.width * transformRef.current.scale)) * 100));
    stageRef.current?.style.setProperty("--d2c-wipe", `${value}%`);
    if (commit) setWipePosition(value);
  };

  const actualSize = (): void => {
    if (canvas === undefined || viewportRef.current === null) return;
    const bounds = viewportRef.current.getBoundingClientRect();
    paintTransform({ scale: 1, x: (bounds.width - canvas.width) / 2, y: (bounds.height - canvas.height) / 2 }, true);
  };

  const copyText = (value: string): void => {
    void navigator.clipboard.writeText(value).catch(reportError);
  };

  const scores = bundle?.report.scores;
  const evaluation = bundle?.report.evaluation;
  const presentation = scores === undefined || evaluation === undefined ? undefined : resultPresentation({
    total: scores.total,
    status: evaluation.status,
    confidence: evaluation.confidence,
  });
  const catalogReports = useMemo(
    () => reports.filter((item) => item.page === undefined || item.page.index === 0),
    [reports],
  );
  const pageReports = bundle?.relatedPages ?? [];
  const selectedRect = activeIssue?.designRect ?? activeIssue?.implementationRect;
  const viewState = pending !== undefined ? "pending" : creating || bundle === undefined ? "create" : "report";

  return <section className="d2c-workbench d2c-v2" aria-label="D2C" data-state={viewState}>
    <header className="d2c-workbench-header">
      <div className="d2c-title-group">
        <button className="d2c-back" onClick={onClose} aria-label="返回对话">←</button>
        <div><p>DESIGN TO CODE</p><h1>D2C</h1></div>
      </div>
      {viewState === "report" && scores !== undefined && evaluation !== undefined && presentation !== undefined && <div className="d2c-result-summary" data-verdict={evaluation.verdict}>
        <div><strong>{presentation.primary}</strong>{evaluation.status !== "invalid" && <span>/ 100</span>}</div>
        <span>{evaluation.status === "invalid" ? presentation.label : VERDICT_LABELS[evaluation.verdict]}</span>
        {presentation.showConfidence && <small>{CONFIDENCE_LABELS[evaluation.confidence]}</small>}
        {presentation.diagnostic !== undefined && <small className="d2c-result-diagnostic">{presentation.diagnostic}</small>}
      </div>}
      {viewState === "report" && bundle?.designOutdated === true && <span className="d2c-report-stale">设计稿已重新导入 · 当前报告对应旧版本</span>}
    </header>

    <div className="d2c-workbench-body">
      {viewState === "report" && <aside className="d2c-catalog" aria-label="报告列表">
        <button className="d2c-new-task" onClick={() => setCreating(true)}><span>＋</span> 新建 D2C</button>
        <div className="d2c-catalog-tools"><strong>评测批次</strong><span>{catalogReports.length}</span><button onClick={() => void loadReports()} aria-label="刷新报告列表">↻</button></div>
        <div className="d2c-list" aria-busy={loading}>
          {loading && <p className="d2c-list-empty">正在读取报告…</p>}
          {!loading && catalogReports.length === 0 && <div className="d2c-list-empty"><strong>还没有评测结果</strong><span>新建任务后，结果会自动出现在这里。</span></div>}
          {catalogReports.map((item) => <button className="d2c-list-item" key={`${item.task}/${item.reportId}`}
            data-selected={bundle?.report.task === item.task && (bundle.report.reportId === item.reportId || (item.batchId !== undefined && bundle.report.batchId === item.batchId))}
            onClick={() => void loadBundle(item)}>
            <span><strong>{item.task}</strong><em data-status={item.evaluationStatus}>{item.evaluationStatus === "invalid" ? "未完成" : item.total.toFixed(1)}</em></span>
            <small>{item.page === undefined ? item.reportId : `${item.page.count} 个页面 · ${item.reportId}`}</small><time>{new Date(item.createdAt).toLocaleString()}</time>
          </button>)}
        </div>
      </aside>}

      {viewState === "create" ? <main className="d2c-start-screen">
        <section className="d2c-start-intro">
          <p className="d2c-start-kicker">PIXSO HTML → RUNNABLE UI</p>
          <h2>把设计稿直接变成<br />可运行的前端代码</h2>
          <p>导入 Pixso 导出的 HTML，D2C 会生成所选技术栈的项目，并自动运行像素与内容评测。</p>
          <div className="d2c-pipeline" aria-label="D2C 流程">
            <span><b>HTML</b><small>设计输入</small></span><i>→</i>
            <span><b>{framework === "vue" ? "Vue 3" : "React"}</b><small>代码生成</small></span><i>→</i>
            <span><b>REPORT</b><small>自动评测</small></span>
          </div>
          {catalogReports.length > 0 && <div className="d2c-start-reports">
            <header><strong>最近结果</strong><span>{catalogReports.length} 个批次</span></header>
            {catalogReports.slice(0, 3).map((item) => <button key={`${item.task}/${item.reportId}`} onClick={() => void loadBundle(item)}>
              <span><strong>{item.task}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></span><em>{item.evaluationStatus === "invalid" ? "未完成" : item.total.toFixed(1)}</em>
            </button>)}
          </div>}
        </section>
        <section className="d2c-start-card" aria-label="创建 D2C 任务">
          <header><span>NEW D2C</span><h2>创建任务</h2><p>只需设置任务名和代码技术栈。</p></header>
          <label className="d2c-start-field"><span>任务名</span>
            <input value={taskName} placeholder="例如 homepage" aria-label="D2C 任务名" autoFocus
              onChange={(event) => setTaskName(event.target.value.trim().toLowerCase())} />
            <small data-error={taskName !== "" && !taskValid}>{taskName !== "" && !taskValid ? "仅支持小写字母、数字和连字符" : "将用于输出目录和评测报告标识"}</small>
          </label>
          <fieldset className="d2c-stack-picker"><legend>技术栈</legend>
            {(["vue", "react"] as const).map((value) => <button type="button" key={value} role="radio" aria-checked={framework === value}
              data-active={framework === value} onClick={() => setFramework(value)}>
              <span className="d2c-stack-mark">{value === "vue" ? "V" : "R"}</span>
              <span><strong>{value === "vue" ? "Vue 3" : "React"}</strong><small>{value === "vue" ? "Composition API · Vite" : "Hooks · Vite"}</small></span>
              <i>{framework === value ? "✓" : ""}</i>
            </button>)}
          </fieldset>
          <button className="d2c-start-primary" disabled={!taskValid || launching || disabled} onClick={() => void startD2c()}>
            <span>{launching ? "正在选择并导入…" : "导入 HTML 并开始 D2C"}</span><b aria-hidden="true">→</b>
          </button>
          <p className="d2c-start-note"><span>⌁</span> 选择 Pixso HTML 文件夹后会立即开始生成，无需再次确认。</p>
          {disabled && <p className="d2c-start-warning">当前会话正在执行其他任务，完成或中断后可开始 D2C。</p>}
        </section>
      </main> : viewState === "pending" && pending !== undefined
        ? <D2cProgressView pending={pending} onOpenLog={onClose} onInterrupt={onInterrupt} />
        : <main className="d2c-canvas-area" data-pages={pageReports.length > 1 ? "multiple" : "single"}>
        {bundle !== undefined && canvas !== undefined && scores !== undefined && evaluation !== undefined && <>
          {pageReports.length > 1 && <nav className="d2c-page-rail" aria-label="页面评测结果">
            <div><strong>页面</strong><span>{bundle.report.page === undefined ? "" : `${bundle.report.page.index + 1} / ${bundle.report.page.count}`}</span></div>
            <div>{pageReports.map((item) => <button key={item.reportId} type="button"
              aria-pressed={item.reportId === bundle.report.reportId} data-selected={item.reportId === bundle.report.reportId}
              data-status={item.evaluationStatus} onClick={() => void loadBundle(item)}>
              <span>{item.page?.label ?? item.reportId}</span>
              <small>{item.evaluationStatus === "invalid" ? "待重测" : `${item.total.toFixed(1)} · ${item.issueCount} 项`}</small>
            </button>)}</div>
          </nav>}
          <div className="d2c-trust-bar" data-status={evaluation.status}>
            <strong>{VERDICT_LABELS[evaluation.verdict]}</strong><span>{evaluation.summary}</span>
            <div>{evaluation.checks.map((item) => <span key={item.key} data-status={item.status} title={item.message}>{item.status === "pass" ? "✓" : item.status === "warn" ? "!" : "×"} {item.label}</span>)}</div>
          </div>
          <div className="d2c-canvas-toolbar">
            <div className="d2c-mode-switch" role="tablist" aria-label="画布显示模式">
              {(Object.keys(MODE_LABELS) as D2cViewMode[]).map((value) => <button key={value} role="tab" aria-selected={mode === value}
                data-active={mode === value} onClick={() => setMode(value)}>{MODE_LABELS[value]}</button>)}
            </div>
            {mode === "overlay" && <label className="d2c-opacity d2c-opacity-overlay"><span>实现 {Math.round(implOpacity * 100)}%</span><input type="range" min={0} max={100}
              value={Math.round(implOpacity * 100)} onChange={(event) => setImplOpacity(Number(event.target.value) / 100)} /></label>}
            {mode === "wipe" && <label className="d2c-opacity d2c-opacity-wipe"><span>分界 {wipePosition}%</span><input type="range" min={0} max={100}
              value={wipePosition} onChange={(event) => setWipePosition(Number(event.target.value))} /></label>}
            <div className="d2c-zoom-tools" aria-label="缩放控制">
              <button onClick={() => zoom(1 / 1.2)} aria-label="缩小">−</button><button onClick={actualSize}>100%</button>
              <button onClick={fit}>适应</button><button onClick={() => zoom(1.2)} aria-label="放大">＋</button><output>{Math.round(transform.scale * 100)}%</output>
            </div>
          </div>

          <div className="d2c-canvas-viewport" ref={viewportRef} tabIndex={0} aria-label="差异画布。滚轮缩放，拖动平移，F 适应，0 显示 100%。"
            onWheel={(event) => {
              event.preventDefault();
              const bounds = event.currentTarget.getBoundingClientRect();
              zoom(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }, false);
              if (wheelCommitRef.current !== undefined) clearTimeout(wheelCommitRef.current);
              wheelCommitRef.current = setTimeout(() => { setTransform({ ...transformRef.current }); wheelCommitRef.current = undefined; }, 120);
            }}
            onPointerDown={(event) => { if (event.button !== 0) return; event.currentTarget.setPointerCapture(event.pointerId); dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, originX: transformRef.current.x, originY: transformRef.current.y }; event.currentTarget.dataset.dragging = "true"; }}
            onPointerMove={(event) => { const drag = dragRef.current; if (drag === undefined || drag.pointerId !== event.pointerId) return; paintTransform({ ...transformRef.current, x: drag.originX + event.clientX - drag.x, y: drag.originY + event.clientY - drag.y }, false); }}
            onPointerUp={(event) => { if (dragRef.current?.pointerId !== event.pointerId) return; dragRef.current = undefined; event.currentTarget.dataset.dragging = "false"; setTransform({ ...transformRef.current }); }}
            onKeyDown={(event) => {
              if (event.key === "+" || event.key === "=") zoom(1.2);
              else if (event.key === "-") zoom(1 / 1.2);
              else if (event.key === "0") actualSize();
              else if (event.key.toLowerCase() === "f") fit();
              else if (event.key.toLowerCase() === "b" && heldModeRef.current === undefined) { heldModeRef.current = mode; setMode("blink"); }
              else if (/^[1-6]$/.test(event.key)) setMode((Object.keys(MODE_LABELS) as D2cViewMode[])[Number(event.key) - 1]!);
            }}
            onKeyUp={(event) => { if (event.key.toLowerCase() === "b" && heldModeRef.current !== undefined) { setMode(heldModeRef.current); heldModeRef.current = undefined; } }}>
            <div className={`d2c-canvas-stage d2c-mode-${mode}`} ref={stageRef} style={{
              width: canvas.width, height: canvas.height,
              "--d2c-scale": transform.scale, "--d2c-x": `${transform.x}px`, "--d2c-y": `${transform.y}px`,
              "--d2c-impl-opacity": implOpacity, "--d2c-wipe": `${wipePosition}%`,
            } as React.CSSProperties}>
              <img className="d2c-layer d2c-layer-design" src={bundle.designPng} alt="设计稿截图" draggable={false} />
              <img className="d2c-layer d2c-layer-impl" src={bundle.implementationPng} alt="实现截图" draggable={false} />
              <img className="d2c-layer d2c-layer-heatmap" src={bundle.heatmapPng} alt="像素差异热力图" draggable={false} />
              {mode === "wipe" && <button className="d2c-wipe-handle" aria-label={`拖动拉帘分界，当前 ${Math.round(wipePosition)}%`}
                onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); }}
                onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) updateWipeFromPointer(event.clientX, false); }}
                onPointerUp={(event) => { updateWipeFromPointer(event.clientX, true); event.currentTarget.releasePointerCapture(event.pointerId); }}><span /></button>}
              <div className="d2c-annotations" aria-hidden="true">
                {annotations.map((issue) => {
                  const rect = issue.designRect ?? issue.implementationRect;
                  return rect === undefined ? null : <div key={issue.fingerprint} className="d2c-annotation" data-kind={issue.kind}
                    data-severity={issue.severity} data-selected={issue.fingerprint === selectedIssue} style={rectStyle(rect)} />;
                })}
              </div>
              {activeIssue?.designRect !== undefined && <div className="d2c-focus-box d2c-focus-design" style={rectStyle(activeIssue.designRect)}><span>设计</span></div>}
              {activeIssue?.implementationRect !== undefined && <div className="d2c-focus-box d2c-focus-implementation" style={rectStyle(activeIssue.implementationRect)}><span>实现</span></div>}
              {activeIssue?.designRect !== undefined && activeIssue.implementationRect !== undefined && <svg className="d2c-measurement" viewBox={`0 0 ${canvas.width} ${canvas.height}`}>
                <line x1={activeIssue.designRect.x + activeIssue.designRect.width / 2} y1={activeIssue.designRect.y + activeIssue.designRect.height / 2}
                  x2={activeIssue.implementationRect.x + activeIssue.implementationRect.width / 2} y2={activeIssue.implementationRect.y + activeIssue.implementationRect.height / 2} />
              </svg>}
            </div>
            <aside className="d2c-difference-ruler" aria-label="垂直差异分布">
              {allIssues.slice(0, 500).map((issue) => {
                const rect = issue.designRect ?? issue.implementationRect;
                return rect === undefined ? null : <button key={issue.fingerprint} style={{ top: `${((rect.y + rect.height / 2) / canvas.height) * 100}%` }}
                  data-severity={issue.severity} aria-label={`定位 ${issue.label}`} title={issue.label} onClick={() => focusIssue(issue)} />;
              })}
            </aside>
            <div className="d2c-canvas-hint">滚轮缩放 · 拖动平移 · F 适应 · 0 原始尺寸 · 按住 B 闪烁</div>
          </div>
        </>}
        {loadingReport && <div className="d2c-loading" aria-busy="true">正在加载报告…</div>}
      </main>}

      {viewState === "report" && <aside className="d2c-inspector" aria-label="差异检查器">
        {bundle !== undefined && canvas !== undefined && scores !== undefined ? <>
          <section className="d2c-score-grid" aria-label="分项得分" data-status={bundle.report.evaluation.status}>
            {bundle.report.evaluation.status === "invalid" && <p>诊断指标 · 仅代表已采集区域，不构成正式评分</p>}
            {(["layout", "color", "typography", "content", "pixel"] as const).map((key) => scores[key] === undefined ? null : <div key={key}>
              <span>{{ layout: "布局", color: "色彩", typography: "字体", content: "内容", pixel: "像素" }[key]}</span><strong>{Math.round(scores[key]! * 100)}</strong>
              <i style={{ "--score": scores[key] } as React.CSSProperties} />
            </div>)}
          </section>
          <div className="d2c-issue-heading"><div><h2>差异问题</h2><span>{filteredIssues.length} / {allIssues.length}</span></div>
            <div className="d2c-issue-filters">{(["all", "blocking", "content", "geometry"] as const).map((value) => <button key={value}
              data-active={issueFilter === value} onClick={() => { setIssueFilter(value); setIssueLimit(INITIAL_ISSUE_LIMIT); }}>
              {{ all: "全部", blocking: "阻断", content: "内容", geometry: "几何" }[value]}</button>)}</div>
          </div>
          {filteredIssues.length === 0 ? <p className="d2c-issue-empty">{bundle.report.evaluation.status === "invalid"
            ? "已采集区域未发现差异；修复采集问题后才能形成正式结论。"
            : "当前筛选下没有差异。"}</p> : <ol className="d2c-issue-list">
            {filteredIssues.slice(0, issueLimit).map((issue) => <li key={issue.fingerprint} data-severity={issue.severity} data-selected={selectedIssue === issue.fingerprint}>
              <button className="d2c-issue-main" onClick={() => focusIssue(issue)} aria-pressed={selectedIssue === issue.fingerprint}>
                <span className="d2c-impact">{issue.impact.toFixed(1)}</span><span><strong>{issue.label}</strong>{issueDetails(issue).map((line) => <small key={line}>{line}</small>)}</span>
              </button>
              {selectedIssue === issue.fingerprint && <div className="d2c-evidence">
                <div className="d2c-evidence-pair">
                  {issue.designRect !== undefined && <EvidenceCrop src={bundle.designPng} rect={issue.designRect} canvas={canvas} label="设计" />}
                  {issue.implementationRect !== undefined && <EvidenceCrop src={bundle.implementationPng} rect={issue.implementationRect} canvas={canvas} label="实现" />}
                </div>
                <div className="d2c-copy-actions">
                  {issue.selector !== undefined && <button onClick={() => copyText(issue.selector!)}>复制选择器</button>}
                  <button onClick={() => copyText(`${issue.label}\n${issueDetails(issue).join("\n")}\n位置：${JSON.stringify(selectedRect)}`)}>复制修复线索</button>
                </div>
              </div>}
            </li>)}
          </ol>}
          {filteredIssues.length > issueLimit && <button className="d2c-show-more" onClick={() => setIssueLimit((value) => value + INITIAL_ISSUE_LIMIT)}>再显示 {Math.min(INITIAL_ISSUE_LIMIT, filteredIssues.length - issueLimit)} 条</button>}
        </> : <div className="d2c-inspector-empty"><strong>问题检查器</strong><span>选择报告后，可按影响度逐项定位和取证。</span></div>}
      </aside>}
    </div>
  </section>;
}
