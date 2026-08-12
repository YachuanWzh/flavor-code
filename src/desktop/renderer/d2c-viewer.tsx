import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { D2cElementDiff, D2cRect, D2cUnmatchedElement } from "../../d2c/types.js";
import type { D2cReviewDecision } from "../../d2c/workflow.js";
import { buildD2cRepairPrompt, reviewProgress } from "../../d2c/workflow-shared.js";
import type { D2cApiMapping } from "../../d2c/openapi.js";
import type { D2cInteractionRun } from "../../d2c/interaction.js";
import type { D2cJudgeConfig, D2cJudgeConfigView } from "../../d2c/judge.js";
import type { D2cImportResult, D2cIntegrationView, D2cMockStatus, D2cPreviewStatus, D2cReportListItem, D2cReportView } from "../contracts.js";
import { buildD2cAxisMeasurements, fitCanvas, focusCanvasRect, zoomCanvasAt, type CanvasTransform } from "./d2c-canvas.js";
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
    "必须按页面语义拆分可独立修改的子模块；每个模块根节点添加 data-d2c-module 和 data-d2c-source（逗号分隔源码文件），并在项目根目录写 d2c.modules.json，记录 schema:1 以及各模块 id、label、sourceFiles、keywords、dataNeeds、actions。",
    "不要用 Shell 手动执行 npm run dev、npm start、vite、start /b 或其他常驻预览命令；直接把项目目录传给 D2cCompare，由它负责安装依赖、启动、探活和关闭服务器。",
    "完成后调用一次 D2cCompare 对比设计稿与运行中的实现。首次有效报告生成后立即停止，不要自动修复任何视觉差异，等待用户在 D2C 审阅面板逐条通过或退回。",
    "只有评测本身 invalid 或构建失败时才修复环境并重试；不得把视觉差异当作环境错误自动修改。",
    "如果 D2cCompare 失败，优先使用错误中附带的 npm/Vite 进程输出修复项目；不要读取工作区外的 npm 源码或缓存日志。",
    "同一个 D2cCompare 错误连续出现时禁止原样重试；必须先根据错误阶段、Renderer diagnostics 或 Process output 修改相关代码。无法修复时停止评测并汇报具体错误，不要继续启动预览进程。",
    "以报告的验收结论为准，最后只汇报总分、可信度和待用户审阅的问题，不要进入接口联调。",
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

const SCORE_ITEMS = [
  { key: "layout", label: "布局" },
  { key: "color", label: "色彩" },
  { key: "typography", label: "字体" },
  { key: "content", label: "内容" },
  { key: "pixel", label: "像素" },
] as const;

const ISSUE_FILTER_LABELS: Record<IssueFilter, string> = {
  all: "全部",
  blocking: "阻断",
  content: "内容",
  geometry: "几何",
};

export function d2cReportViewPolicy(status: "valid" | "warning" | "invalid" | undefined): {
  defaultMode: D2cViewMode;
  modes: readonly D2cViewMode[];
  showComparison: boolean;
} {
  return status === "invalid"
    ? { defaultMode: "implementation", modes: ["implementation", "design"], showComparison: false }
    : { defaultMode: "overlay", modes: Object.keys(MODE_LABELS) as D2cViewMode[], showComparison: true };
}

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

function issueMatchesFilter(issue: WorkbenchIssue, filter: IssueFilter): boolean {
  if (filter === "blocking") return issue.severity === "major" || issue.impact >= 8;
  if (filter === "content") return issue.kind === "missing" || issue.diff?.textIssue !== undefined || issue.diff?.imageIssue !== undefined;
  if (filter === "geometry") {
    return issue.diff !== undefined
      && Math.max(Math.abs(issue.diff.dx), Math.abs(issue.diff.dy), Math.abs(issue.diff.dw), Math.abs(issue.diff.dh)) > 0;
  }
  return true;
}

function scoreLevel(score: number): "excellent" | "good" | "warning" | "critical" {
  if (score >= 0.95) return "excellent";
  if (score >= 0.9) return "good";
  if (score >= 0.75) return "warning";
  return "critical";
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

function D2cPixelMeasurements({ design, implementation, canvas, scale }: {
  design: D2cRect;
  implementation: D2cRect;
  canvas: { width: number; height: number };
  scale: number;
}): React.JSX.Element | null {
  const measurements = buildD2cAxisMeasurements(design, implementation, canvas, scale);
  if (measurements.length === 0) return null;

  const safeScale = Math.max(0.01, scale);
  const tick = 5 / safeScale;
  const labelHeight = 18 / safeScale;
  const labelPadding = 12 / safeScale;
  const fontSize = 10 / safeScale;

  return <svg className="d2c-measurement" viewBox={`0 0 ${canvas.width} ${canvas.height}`}
    role="img" aria-label={measurements.map((item) => `${item.axis === "x" ? "横向" : "纵向"}偏移 ${item.label}`).join("，")}>
    {measurements.map((measurement) => {
      const horizontal = measurement.axis === "x";
      const centerX = (measurement.start.x + measurement.end.x) / 2;
      const centerY = (measurement.start.y + measurement.end.y) / 2;
      const labelWidth = (measurement.label.length * 6.2) / safeScale + labelPadding;
      const direction = measurement.delta > 0
        ? horizontal ? "向右" : "向下"
        : horizontal ? "向左" : "向上";
      return <g key={measurement.axis} className="d2c-measurement-axis" data-axis={measurement.axis}>
        <title>{`${horizontal ? "横向" : "纵向"}${direction}偏移 ${measurement.label}`}</title>
        <line className="d2c-measurement-guide" x1={measurement.designGuide.start.x} y1={measurement.designGuide.start.y}
          x2={measurement.designGuide.end.x} y2={measurement.designGuide.end.y} />
        <line className="d2c-measurement-guide" x1={measurement.implementationGuide.start.x} y1={measurement.implementationGuide.start.y}
          x2={measurement.implementationGuide.end.x} y2={measurement.implementationGuide.end.y} />
        <line className="d2c-measurement-rule" x1={measurement.start.x} y1={measurement.start.y}
          x2={measurement.end.x} y2={measurement.end.y} />
        <line className="d2c-measurement-cap"
          x1={measurement.start.x - (horizontal ? 0 : tick)} y1={measurement.start.y - (horizontal ? tick : 0)}
          x2={measurement.start.x + (horizontal ? 0 : tick)} y2={measurement.start.y + (horizontal ? tick : 0)} />
        <line className="d2c-measurement-cap"
          x1={measurement.end.x - (horizontal ? 0 : tick)} y1={measurement.end.y - (horizontal ? tick : 0)}
          x2={measurement.end.x + (horizontal ? 0 : tick)} y2={measurement.end.y + (horizontal ? tick : 0)} />
        <g className="d2c-measurement-label" transform={`translate(${centerX} ${centerY})${horizontal ? "" : " rotate(-90)"}`}>
          <rect x={-labelWidth / 2} y={-labelHeight / 2} width={labelWidth} height={labelHeight} rx={3 / safeScale} />
          <text x={0} y={0} fontSize={fontSize}>{measurement.label}</text>
        </g>
      </g>;
    })}
  </svg>;
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
  const [inspectorTab, setInspectorTab] = useState<"review" | "integration">("review");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [integration, setIntegration] = useState<D2cIntegrationView>();
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [mockStatus, setMockStatus] = useState<D2cMockStatus>({ running: false });
  const [previewStatus, setPreviewStatus] = useState<D2cPreviewStatus>({ running: false });
  const [interactionRun, setInteractionRun] = useState<D2cInteractionRun>();
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [judgeConfig, setJudgeConfig] = useState<D2cJudgeConfigView>({ configured: false });
  const [judgeBusy, setJudgeBusy] = useState(false);
  const [judgeEditing, setJudgeEditing] = useState(false);
  const [judgeDraft, setJudgeDraft] = useState<D2cJudgeConfig>({
    protocol: "openai-compatible", baseURL: "", apiKey: "", model: "", passThreshold: 80,
  });
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const automatedAfterAgentRef = useRef<string | undefined>(undefined);
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
      setMode(d2cReportViewPolicy(next.report.evaluation.status).defaultMode);
      setCreating(false);
      setSelectedIssue(undefined);
      setReviewInstruction("");
      setIssueLimit(INITIAL_ISSUE_LIMIT);
      if (next.workflow.stage === "visual-review") setInspectorTab("review");
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
    if (bundle === undefined || bundle.report.evaluation.status === "invalid") return [];
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

  const issueCounts = useMemo<Record<IssueFilter, number>>(() => ({
    all: allIssues.length,
    blocking: allIssues.filter((issue) => issueMatchesFilter(issue, "blocking")).length,
    content: allIssues.filter((issue) => issueMatchesFilter(issue, "content")).length,
    geometry: allIssues.filter((issue) => issueMatchesFilter(issue, "geometry")).length,
  }), [allIssues]);
  const filteredIssues = useMemo(
    () => allIssues.filter((issue) => issueMatchesFilter(issue, issueFilter)),
    [allIssues, issueFilter],
  );
  const activeIssue = allIssues.find((issue) => issue.fingerprint === selectedIssue);
  const annotations = allIssues.slice(0, ANNOTATION_LIMIT);

  const focusIssue = (issue: WorkbenchIssue): void => {
    setSelectedIssue(issue.fingerprint);
    setReviewInstruction(bundle?.workflow.reviews.find((item) => item.fingerprint === issue.fingerprint
      && item.pageId === (bundle.report.page?.id ?? "index"))?.instruction ?? "");
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

  const mutateReview = async (fingerprints: readonly string[], decision: D2cReviewDecision, instruction?: string): Promise<void> => {
    if (bundle === undefined || fingerprints.length === 0 || reviewBusy || disabled) return;
    setReviewBusy(true);
    try {
      const workflow = await window.flavorDesktop.updateD2cReview(
        bundle.report.task, bundle.report.reportId, fingerprints, decision, instruction,
      );
      setBundle((current) => current === undefined ? current : { ...current, workflow });
      if (decision === "accepted" && reviewProgress(workflow).complete) setInspectorTab("integration");
      if (decision === "needs-fix") {
        const prompt = buildD2cRepairPrompt(bundle.report, fingerprints, instruction);
        const submitted = await onStartTask(prompt);
        if (submitted) onLaunch(bundle.report.task, workflow.framework);
      }
    } catch (cause) { reportError(cause); }
    finally { setReviewBusy(false); }
  };

  const loadIntegration = async (): Promise<void> => {
    if (bundle === undefined || integrationBusy) return;
    setIntegrationBusy(true);
    try {
      const [view, status, preview, judge] = await Promise.all([
        window.flavorDesktop.getD2cIntegration(bundle.report.task),
        window.flavorDesktop.getD2cMockStatus(bundle.report.task),
        window.flavorDesktop.getD2cPreviewStatus(bundle.report.task),
        window.flavorDesktop.getD2cJudgeConfig(),
      ]);
      setIntegration(view);
      setMockStatus(status);
      setPreviewStatus(preview);
      setInteractionRun(view?.workflow.interaction?.automated);
      setJudgeConfig(judge);
      if (judge.configured) {
        setJudgeDraft((current) => ({ ...current, protocol: judge.protocol ?? "openai-compatible",
          baseURL: judge.baseURL ?? "", model: judge.model ?? "", passThreshold: judge.passThreshold ?? 80, apiKey: "" }));
      }
    } catch (cause) { reportError(cause); }
    finally { setIntegrationBusy(false); }
  };

  const openIntegration = (): void => {
    if (bundle === undefined || !reviewProgress(bundle.workflow).complete || bundle.report.evaluation.status === "invalid") return;
    setInspectorTab("integration");
    void loadIntegration();
  };

  const importOpenApi = async (): Promise<void> => {
    if (bundle === undefined || integrationBusy) return;
    setIntegrationBusy(true);
    try {
      const next = await window.flavorDesktop.importD2cOpenApi(bundle.report.task);
      if (next !== undefined) { setIntegration(next); setBundle((current) => current === undefined ? current : { ...current, workflow: next.workflow }); }
    } catch (cause) { reportError(cause); }
    finally { setIntegrationBusy(false); }
  };

  const confirmMapping = async (mapping: D2cApiMapping, operationKey: string): Promise<void> => {
    if (bundle === undefined || integrationBusy) return;
    setIntegrationBusy(true);
    try {
      const next = await window.flavorDesktop.confirmD2cMapping(bundle.report.task, mapping.moduleId, operationKey);
      setIntegration(next);
      setBundle((current) => current === undefined ? current : { ...current, workflow: next.workflow });
    } catch (cause) { reportError(cause); }
    finally { setIntegrationBusy(false); }
  };

  const generateIntegration = async (): Promise<void> => {
    if (bundle === undefined || integrationBusy || integration?.mappings.some((item) => item.status === "needs-confirmation")) return;
    setIntegrationBusy(true);
    try {
      const generated = await window.flavorDesktop.generateD2cIntegration(bundle.report.task);
      setIntegration(generated);
      setBundle((current) => current === undefined ? current : { ...current, workflow: generated.workflow });
      const status = await window.flavorDesktop.startD2cPreview(bundle.report.task);
      setPreviewStatus(status);
      setMockStatus({ running: status.mockUrl !== undefined, ...(status.mockUrl === undefined ? {} : { url: status.mockUrl }) });
      const submitted = await onStartTask(`${generated.prompt}\nFlavor Code 已保持交互预览 ${status.url ?? "本地动态端口"} 与 Express Mock ${status.mockUrl ?? "本地动态端口"} 运行，.env.local 已配置 VITE_API_BASE_URL。`);
      if (submitted) onLaunch(bundle.report.task, generated.workflow.framework);
    } catch (cause) { reportError(cause); }
    finally { setIntegrationBusy(false); }
  };

  const toggleMock = async (): Promise<void> => {
    if (bundle === undefined || integrationBusy) return;
    setIntegrationBusy(true);
    try {
      setMockStatus(mockStatus.running
        ? await window.flavorDesktop.stopD2cMock(bundle.report.task)
        : await window.flavorDesktop.startD2cMock(bundle.report.task));
    } catch (cause) { reportError(cause); }
    finally { setIntegrationBusy(false); }
  };

  const startPreview = async (): Promise<void> => {
    if (bundle === undefined || interactionBusy) return;
    setInteractionBusy(true);
    try {
      const status = await window.flavorDesktop.startD2cPreview(bundle.report.task);
      setPreviewStatus(status);
      setMockStatus({ running: status.mockUrl !== undefined, ...(status.mockUrl === undefined ? {} : { url: status.mockUrl }) });
    } catch (cause) { reportError(cause); }
    finally { setInteractionBusy(false); }
  };

  const stopPreview = async (): Promise<void> => {
    if (bundle === undefined || interactionBusy) return;
    setInteractionBusy(true);
    try { setPreviewStatus(await window.flavorDesktop.stopD2cPreview(bundle.report.task)); }
    catch (cause) { reportError(cause); }
    finally { setInteractionBusy(false); }
  };

  const runInteractionTests = async (): Promise<void> => {
    if (bundle === undefined || !previewStatus.running || interactionBusy) return;
    setInteractionBusy(true);
    try {
      const status = await window.flavorDesktop.runD2cInteractionTests(bundle.report.task);
      setInteractionRun(status.result);
      setBundle((current) => current === undefined ? current : { ...current, workflow: status.workflow });
      setIntegration((current) => current === undefined ? current : { ...current, workflow: status.workflow });
    } catch (cause) { reportError(cause); }
    finally { setInteractionBusy(false); }
  };

  const setManualAcceptance = async (accepted: boolean): Promise<void> => {
    if (bundle === undefined || interactionBusy) return;
    setInteractionBusy(true);
    try {
      const workflow = await window.flavorDesktop.setD2cManualAcceptance(bundle.report.task, accepted);
      setBundle((current) => current === undefined ? current : { ...current, workflow });
      setIntegration((current) => current === undefined ? current : { ...current, workflow });
    } catch (cause) { reportError(cause); }
    finally { setInteractionBusy(false); }
  };

  const saveJudgeConfig = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (judgeBusy) return;
    setJudgeBusy(true);
    try {
      const config = await window.flavorDesktop.saveD2cJudgeConfig(judgeDraft);
      setJudgeConfig(config);
      setJudgeDraft((current) => ({ ...current, apiKey: "" }));
      setJudgeEditing(false);
    } catch (cause) { reportError(cause); }
    finally { setJudgeBusy(false); }
  };

  const runQualityJudge = async (): Promise<void> => {
    if (bundle === undefined || judgeBusy) return;
    setJudgeBusy(true);
    try {
      const result = await window.flavorDesktop.runD2cQualityJudge(bundle.report.task);
      setBundle((current) => current === undefined ? current : { ...current, workflow: result.workflow });
      setIntegration((current) => current === undefined ? current : { ...current, workflow: result.workflow });
    } catch (cause) { reportError(cause); }
    finally { setJudgeBusy(false); }
  };

  useEffect(() => {
    const task = bundle?.report.task;
    if (pending !== undefined && previewStatus.running && task === pending.task) {
      automatedAfterAgentRef.current = task;
      return;
    }
    if (pending === undefined && task !== undefined && automatedAfterAgentRef.current === task) {
      automatedAfterAgentRef.current = undefined;
      void runInteractionTests();
    }
  }, [pending, previewStatus.running, bundle?.report.task]);

  const scores = bundle?.report.scores;
  const evaluation = bundle?.report.evaluation;
  const availableModes = d2cReportViewPolicy(evaluation?.status).modes;
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
  const reviewState = bundle === undefined ? undefined : reviewProgress(bundle.workflow);
  const reviewFor = (fingerprint: string) => bundle?.workflow.reviews.find((item) => item.fingerprint === fingerprint
    && item.pageId === (bundle.report.page?.id ?? "index"));
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
        : inspectorTab === "integration" && previewStatus.running && previewStatus.url !== undefined
          ? <main className="d2c-live-preview" aria-label="Interactive integration preview">
            <header className="d2c-live-toolbar">
              <span className="d2c-live-state"><i /> LIVE</span>
              <code title={previewStatus.url}>{previewStatus.url}</code>
              <button type="button" onClick={() => setPreviewReloadKey((value) => value + 1)}>Refresh</button>
              <button type="button" onClick={() => void window.flavorDesktop.openD2cPreview(bundle!.report.task)}>Open in browser</button>
            </header>
            <iframe key={previewReloadKey} src={previewStatus.url} title="D2C interactive preview"
              sandbox="allow-scripts allow-forms allow-modals allow-same-origin" referrerPolicy="no-referrer" />
          </main>
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
              {availableModes.map((value) => <button key={value} role="tab" aria-selected={mode === value}
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
              else if (/^[1-6]$/.test(event.key)) {
                const nextMode = availableModes[Number(event.key) - 1];
                if (nextMode !== undefined) setMode(nextMode);
              }
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
              {evaluation.status === "invalid" && <div className="d2c-invalid-capture-badge">错误现场 · 不参与评分</div>}
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
              {activeIssue?.designRect !== undefined && activeIssue.implementationRect !== undefined
                && <D2cPixelMeasurements design={activeIssue.designRect} implementation={activeIssue.implementationRect}
                  canvas={canvas} scale={transform.scale} />}
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
          <section className="d2c-inspector-verdict" data-verdict={bundle.report.evaluation.verdict}>
            <span className="d2c-verdict-mark" aria-hidden="true">{bundle.report.evaluation.verdict === "pass" ? "✓" : bundle.report.evaluation.verdict === "conditional" ? "!" : "×"}</span>
            <div><p>{bundle.report.evaluation.status === "invalid" ? "EVALUATION INTERRUPTED" : "PAGE VERDICT"}</p>
              <h2>{bundle.report.evaluation.verdict === "pass"
                ? allIssues.length === 0 ? "本页已通过验收" : "已通过，仍可继续优化"
                : bundle.report.evaluation.verdict === "conditional" ? "有差异需要确认"
                  : bundle.report.evaluation.verdict === "invalid" ? "评测需要重新运行" : "本页尚未通过验收"}</h2>
              <span>{bundle.report.evaluation.summary}</span></div>
          </section>
          <nav className="d2c-stage-tabs" aria-label="D2C 阶段">
            <button type="button" data-active={inspectorTab === "review"} aria-pressed={inspectorTab === "review"}
              onClick={() => setInspectorTab("review")}><span>01</span>视觉审阅</button>
            <button type="button" data-active={inspectorTab === "integration"} aria-pressed={inspectorTab === "integration"}
              disabled={reviewState === undefined || !reviewState.complete || bundle.report.evaluation.status === "invalid"}
              title={reviewState?.complete ? "进入接口联调" : "全部差异通过后解锁"} onClick={openIntegration}><span>02</span>接口联调</button>
          </nav>
          {inspectorTab === "review" ? <>
          <section className="d2c-score-card" aria-label="分项得分" data-status={bundle.report.evaluation.status}>
            <header><div><p>QUALITY PROFILE</p><h2>五项质量</h2></div>
              {bundle.report.evaluation.status !== "invalid" && <span>{SCORE_ITEMS.filter(({ key }) => (scores[key] ?? 0) >= 0.9).length} / 5 达标</span>}
            </header>
            {bundle.report.evaluation.status === "invalid" && <p className="d2c-score-invalid">实现页面渲染失败，当前截图仅用于诊断，不生成正式分数。</p>}
            {bundle.report.evaluation.status !== "invalid" && <div className="d2c-score-list">{SCORE_ITEMS.map(({ key, label }) => scores[key] === undefined ? null : <div key={key} data-level={scoreLevel(scores[key]!)}>
              <span>{label}</span><i><b style={{ "--score": scores[key] } as React.CSSProperties} /></i><strong>{Math.round(scores[key]! * 100)}</strong>
            </div>)}</div>}
          </section>
          {bundle.report.evaluation.status !== "invalid" && reviewState !== undefined && <section className="d2c-review-console" data-complete={reviewState.complete}>
            <header><div><p>REVIEW QUEUE</p><h2>{reviewState.complete ? "视觉审阅已完成" : "等待你的验收"}</h2></div>
              <strong>{reviewState.accepted}<span> / {reviewState.total}</span></strong></header>
            <div className="d2c-review-meter" aria-label={`已通过 ${reviewState.accepted}，待审 ${reviewState.pending}，退回 ${reviewState.needsFix}`}>
              <i style={{ "--accepted": reviewState.total === 0 ? 1 : reviewState.accepted / reviewState.total } as React.CSSProperties} />
              <span>待审 <b>{reviewState.pending}</b></span><span>通过 <b>{reviewState.accepted}</b></span><span>退回 <b>{reviewState.needsFix}</b></span>
            </div>
            <div className="d2c-review-bulk">
              {!reviewState.complete && <button type="button" disabled={reviewBusy || disabled || allIssues.length === 0}
                onClick={() => void mutateReview(allIssues.map((item) => item.fingerprint), "accepted")}>全部通过</button>}
              {!reviewState.complete && <button type="button" className="d2c-review-reject" disabled={reviewBusy || disabled || allIssues.length === 0}
                onClick={() => void mutateReview(allIssues.map((item) => item.fingerprint), "needs-fix", "集中修复所有退回差异，仍需严格限制在各自模块文件内。")}>全部退回并修复</button>}
              {reviewState.complete && <button type="button" className="d2c-review-next" onClick={openIntegration}>进入接口联调 <span>→</span></button>}
            </div>
          </section>}
          <div className="d2c-issue-heading"><div><h2>{bundle.report.evaluation.status === "invalid" ? "错误诊断" : "差异问题"}</h2>
            {bundle.report.evaluation.status !== "invalid" && <span>{filteredIssues.length} / {allIssues.length}</span>}</div>
            {bundle.report.evaluation.status !== "invalid" && <div className="d2c-issue-filters">{(["all", "blocking", "content", "geometry"] as const).map((value) => <button key={value}
              type="button" aria-pressed={issueFilter === value} data-active={issueFilter === value}
              onClick={() => { setIssueFilter(value); setIssueLimit(INITIAL_ISSUE_LIMIT); }}>
              <span>{ISSUE_FILTER_LABELS[value]}</span><small>{issueCounts[value]}</small></button>)}</div>}
          </div>
          {filteredIssues.length === 0 ? <div className="d2c-issue-empty" data-kind={bundle.report.evaluation.status === "invalid" ? "invalid" : allIssues.length === 0 ? "clear" : "filtered"}>
            <span className="d2c-empty-mark" aria-hidden="true">{bundle.report.evaluation.status === "invalid" ? "!" : allIssues.length === 0 ? "✓" : "⌁"}</span>
            <strong>{bundle.report.evaluation.status === "invalid" ? "等待有效评测"
              : allIssues.length === 0 ? "未发现可定位的差异" : "这个筛选下没有问题"}</strong>
            <p>{bundle.report.evaluation.status === "invalid"
              ? "修复项目并重新运行 D2C 后，这里会生成可定位的差异清单。"
              : allIssues.length === 0 ? "布局、色彩、字体、内容与像素结果均已通过检查。" : "切换分类或显示全部问题，继续检查其他差异。"}</p>
            {bundle.report.evaluation.status !== "invalid" && <div className="d2c-empty-stats"><span>阻断 <b>{issueCounts.blocking}</b></span><span>内容 <b>{issueCounts.content}</b></span><span>几何 <b>{issueCounts.geometry}</b></span></div>}
            {bundle.report.evaluation.status !== "invalid" && (allIssues.length === 0
              ? <button type="button" onClick={() => { setMode("overlay"); fit(); }}>查看叠加结果</button>
              : <button type="button" onClick={() => { setIssueFilter("all"); setIssueLimit(INITIAL_ISSUE_LIMIT); }}>显示全部问题</button>)}
          </div> : <ol className="d2c-issue-list">
            {filteredIssues.slice(0, issueLimit).map((issue) => { const review = reviewFor(issue.fingerprint); return <li key={issue.fingerprint} data-severity={issue.severity} data-selected={selectedIssue === issue.fingerprint} data-review={review?.decision ?? "pending"}>
              <button className="d2c-issue-main" onClick={() => focusIssue(issue)} aria-pressed={selectedIssue === issue.fingerprint}>
                <span className="d2c-impact">{review?.decision === "accepted" ? "✓" : review?.decision === "needs-fix" ? "↻" : issue.impact.toFixed(1)}</span><span><strong>{issue.label}</strong>{issueDetails(issue).map((line) => <small key={line}>{line}</small>)}</span>
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
                <label className="d2c-review-instruction"><span>补充修改要求</span><textarea rows={2} value={reviewInstruction}
                  placeholder="例如：保持卡片高度，只调整内部间距" onChange={(event) => setReviewInstruction(event.target.value)} /></label>
                <div className="d2c-review-actions">
                  <button type="button" className="d2c-accept" disabled={reviewBusy || disabled || review?.decision === "accepted"}
                    onClick={() => void mutateReview([issue.fingerprint], "accepted")}>✓ 通过</button>
                  <button type="button" className="d2c-fix" disabled={reviewBusy || disabled}
                    onClick={() => void mutateReview([issue.fingerprint], "needs-fix", reviewInstruction || undefined)}>↻ 退回并让 AI 修复</button>
                </div>
              </div>}
            </li>; })}
          </ol>}
          {filteredIssues.length > issueLimit && <button className="d2c-show-more" onClick={() => setIssueLimit((value) => value + INITIAL_ISSUE_LIMIT)}>再显示 {Math.min(INITIAL_ISSUE_LIMIT, filteredIssues.length - issueLimit)} 条</button>}
          </> : <section className="d2c-integration-panel" aria-label="接口联调">
            <header><p>API INTEGRATION</p><h2>{integration === undefined ? "导入接口描述" : integration.document.title}</h2>
              <span>{integration === undefined ? "上传 Swagger / OpenAPI JSON，自动匹配页面模块和接口出入参。" : `${integration.document.version}${integration.document.baseUrl ? ` · ${integration.document.baseUrl}` : ""}`}</span></header>
            {integration === undefined ? <div className="d2c-api-import">
              <span aria-hidden="true">{"{}"}</span><strong>Swagger JSON</strong><p>支持 Swagger 2.0、OpenAPI 3.0/3.1 和文档内引用。</p>
              <button type="button" disabled={integrationBusy} onClick={() => void importOpenApi()}>{integrationBusy ? "正在解析…" : "选择 swagger.json"}</button>
            </div> : <>
              <div className="d2c-api-summary"><span>模块 <b>{integration.mappings.length}</b></span><span>自动匹配 <b>{integration.mappings.filter((item) => item.status === "auto").length}</b></span>
                <span>待确认 <b>{integration.mappings.filter((item) => item.status === "needs-confirmation").length}</b></span></div>
              <ol className="d2c-mapping-list">{integration.mappings.map((mapping) => <li key={mapping.moduleId} data-status={mapping.status}>
                <header><span>{mapping.moduleLabel}</span><small>{mapping.status === "auto" ? "自动匹配" : mapping.status === "confirmed" ? "已确认" : "需要确认"}</small></header>
                 <select aria-label={`${mapping.moduleLabel} 接口`} value={mapping.operationKey} disabled={integrationBusy}
                   onChange={(event) => void confirmMapping(mapping, event.target.value)}>
                   {integration.document.operations.map((operation) => <option key={operation.id} value={operation.id}>{operation.operationId} · {operation.id}</option>)}
                 </select>
                 {mapping.status === "needs-confirmation" && <button type="button" className="d2c-confirm-mapping" disabled={integrationBusy}
                   onClick={() => void confirmMapping(mapping, mapping.operationKey)}>确认此映射</button>}
                 <div><span>请求 {mapping.parameters.length + mapping.requestFields.length} 字段</span><span>响应 {mapping.responseFields.length} 字段</span><b>{Math.round(mapping.confidence * 100)}%</b></div>
              </li>)}</ol>
              <section className="d2c-mock-control" data-running={mockStatus.running}>
                <div><i /><span><strong>{mockStatus.running ? "Express Mock 运行中" : "Express Mock 未启动"}</strong><small>{mockStatus.url ?? "生成联调代码后可启动"}</small></span></div>
                {bundle.workflow.integrationFiles !== undefined && <button type="button" disabled={integrationBusy || previewStatus.running}
                  title={previewStatus.running ? "请先停止交互页面" : undefined} onClick={() => void toggleMock()}>{mockStatus.running ? "停止" : "启动"}</button>}
              </section>
              <section className="d2c-preview-control" data-running={previewStatus.running}>
                <header><div><p>INTERACTIVE ACCEPTANCE</p><h3>{previewStatus.running ? "可交互页面运行中" : "等待启动可交互页面"}</h3></div><i /></header>
                <code>{previewStatus.url ?? "Vite preview not started"}</code>
                <div className="d2c-preview-actions">
                  <button type="button" disabled={interactionBusy || bundle.workflow.integrationFiles === undefined}
                    onClick={() => void (previewStatus.running ? stopPreview() : startPreview())}>{previewStatus.running ? "停止页面" : "启动页面"}</button>
                  <button type="button" disabled={interactionBusy || !previewStatus.running}
                    onClick={() => void runInteractionTests()}>{interactionBusy ? "执行中…" : "运行自动验收"}</button>
                  {previewStatus.running && <button type="button" onClick={() => void window.flavorDesktop.openD2cPreview(bundle.report.task)}>浏览器打开</button>}
                </div>
                {interactionRun !== undefined && <div className="d2c-test-results" data-passed={interactionRun.passed}>
                  <strong>{interactionRun.passed ? "自动验收通过" : `${interactionRun.failures} 条自动验收失败`}</strong>
                  <span>{interactionRun.total} scenarios · {interactionRun.apiRequestCount} API requests</span>
                  <ol>{interactionRun.scenarios.map((scenario) => <li key={scenario.id} data-passed={scenario.passed}>
                    <span>{scenario.passed ? "✓" : "×"} {scenario.id}</span><small>{scenario.apiRequestCount} API · {scenario.durationMs}ms</small>
                    {scenario.failure !== undefined && <p>{scenario.failure}</p>}
                  </li>)}</ol>
                </div>}
                <div className="d2c-manual-acceptance">
                  <span><strong>人工验收</strong><small>请直接在左侧页面完成点击、输入和提交流程</small></span>
                  <button type="button" disabled={interactionBusy || !previewStatus.running}
                    data-accepted={bundle.workflow.interaction?.manualDecision === "accepted"}
                    onClick={() => void setManualAcceptance(bundle.workflow.interaction?.manualDecision !== "accepted")}>
                    {bundle.workflow.interaction?.manualDecision === "accepted" ? "已通过（撤回）" : "确认人工验收通过"}
                  </button>
                </div>
                <section className="d2c-quality-gate" data-verdict={bundle.workflow.quality?.verdict ?? "pending"}>
                  <header><div><p>LLM-AS-A-JUDGE</p><h3>最终质量门</h3></div>
                    {bundle.workflow.quality !== undefined && <strong>{bundle.workflow.quality.overallScore.toFixed(1)}</strong>}</header>
                  {!judgeConfig.configured || judgeEditing ? <form className="d2c-judge-config" onSubmit={(event) => void saveJudgeConfig(event)}>
                    <label><span>协议</span><select value={judgeDraft.protocol} onChange={(event) => setJudgeDraft((current) => ({ ...current, protocol: event.target.value as D2cJudgeConfig["protocol"] }))}>
                      <option value="openai-compatible">OpenAI 兼容</option><option value="anthropic">Anthropic</option>
                    </select></label>
                    <label><span>Base URL</span><input required type="url" placeholder="https://api.example.com/v1" value={judgeDraft.baseURL}
                      onChange={(event) => setJudgeDraft((current) => ({ ...current, baseURL: event.target.value }))} /></label>
                    <label><span>模型</span><input required placeholder="支持视觉的模型名称" value={judgeDraft.model}
                      onChange={(event) => setJudgeDraft((current) => ({ ...current, model: event.target.value }))} /></label>
                    <label><span>API Key</span><input required type="password" autoComplete="off" value={judgeDraft.apiKey}
                      onChange={(event) => setJudgeDraft((current) => ({ ...current, apiKey: event.target.value }))} /></label>
                    <label><span>通过阈值</span><input required type="number" min={0} max={100} value={judgeDraft.passThreshold}
                      onChange={(event) => setJudgeDraft((current) => ({ ...current, passThreshold: Number(event.target.value) }))} /></label>
                    <div><button type="submit" disabled={judgeBusy}>{judgeBusy ? "保存中…" : "保存多模态模型"}</button>
                      {judgeConfig.configured && <button type="button" onClick={() => setJudgeEditing(false)}>取消</button>}</div>
                  </form> : <>
                    <div className="d2c-judge-model"><span>{judgeConfig.model}</span><small>{judgeConfig.baseURL} · 阈值 {judgeConfig.passThreshold}</small>
                      <button type="button" onClick={() => setJudgeEditing(true)}>修改配置</button></div>
                    {bundle.workflow.quality === undefined ? <p>{bundle.workflow.interaction?.automated?.passed === true && bundle.workflow.interaction.manualDecision === "accepted"
                      ? "将综合设计稿、当前联调页面、静态评分与交互证据进行最终评审。"
                      : "先完成自动交互测试和人工验收，再运行最终评审。"}</p> : <div className="d2c-quality-result">
                      <div><span>视觉质量 <b>{bundle.workflow.quality.visualScore}</b></span><span>交互质量 <b>{bundle.workflow.quality.interactionScore}</b></span>
                        <span>综合得分 <b>{bundle.workflow.quality.overallScore}</b></span></div>
                      <strong>{bundle.workflow.quality.verdict === "pass" ? "质量门通过" : "质量门未通过"}</strong>
                      <p>{bundle.workflow.quality.summary}</p>
                      {bundle.workflow.quality.issues.length > 0 && <ol>{bundle.workflow.quality.issues.map((issue, index) => <li key={`${issue.category}-${index}`} data-severity={issue.severity}>
                        <span>{issue.description}</span><small>{issue.recommendation}</small></li>)}</ol>}
                    </div>}
                    <button type="button" className="d2c-run-judge" disabled={judgeBusy || !previewStatus.running
                      || bundle.workflow.interaction?.automated?.passed !== true || bundle.workflow.interaction.manualDecision !== "accepted"}
                      onClick={() => void runQualityJudge()}>{judgeBusy ? "AI 评审中…" : bundle.workflow.quality === undefined ? "运行 AI 质量评审" : "重新运行 AI 质量评审"}</button>
                  </>}
                </section>
                {bundle.workflow.stage === "completed" && <p className="d2c-acceptance-complete">✓ 自动、人工与多模态质量验收均已完成</p>}
              </section>
              <button type="button" className="d2c-generate-integration" disabled={integrationBusy || integration.mappings.some((item) => item.status === "needs-confirmation")}
                onClick={() => void generateIntegration()}>{integrationBusy ? "正在准备联调…" : bundle.workflow.integrationFiles === undefined ? "生成代码并开始联调" : "重新生成并开始联调"}<span>→</span></button>
              {integration.mappings.some((item) => item.status === "needs-confirmation") && <p className="d2c-api-hint">确认所有标记为“需要确认”的接口后即可生成。</p>}
            </>}
          </section>}
        </> : <div className="d2c-inspector-empty"><strong>问题检查器</strong><span>选择报告后，可按影响度逐项定位和取证。</span></div>}
      </aside>}
    </div>
  </section>;
}
