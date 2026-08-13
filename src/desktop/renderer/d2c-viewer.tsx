import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { D2cElementDiff, D2cRect, D2cUnmatchedElement } from "../../d2c/types.js";
import type { D2cReviewDecision } from "../../d2c/workflow.js";
import { buildD2cRepairPrompt, reviewProgress } from "../../d2c/workflow-shared.js";
import type { D2cApiMapping } from "../../d2c/openapi.js";
import type { D2cInteractionRun } from "../../d2c/interaction.js";
import type { D2cProductPhase, D2cProductPlanView } from "../../d2c/product.js";
import type { D2cJudgeConfig, D2cJudgeConfigView, D2cQualityIssue } from "../../d2c/judge.js";
import type { D2cImportResult, D2cIntegrationView, D2cMockStatus, D2cPreviewStatus, D2cProductPreviewStatus, D2cReportListItem, D2cReportView } from "../contracts.js";
import type { D2cInteractionStatus } from "../contracts.js";
import { buildD2cAxisMeasurements, fitCanvas, focusCanvasRect, zoomCanvasAt, type CanvasTransform } from "./d2c-canvas.js";
import type { D2cExecutionPhase, D2cFramework, D2cPendingTask, D2cProgressActivity } from "./d2c-progress.js";
import { MarkdownContent } from "./markdown.js";

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
const PRODUCT_PREVIEW_VIEWPORT = { width: 1280, height: 800 } as const;

export function shouldDeferD2cProductReview(
  currentPhase: D2cProductPhase | undefined,
  nextPhase: D2cProductPhase,
  sessionBusy: boolean,
): boolean {
  if (!sessionBusy || currentPhase === nextPhase) return false;
  return nextPhase === "prd-review" || nextPhase === "design-review";
}

export function shouldStartD2cProductPreview(
  phase: D2cProductPhase | undefined,
  sessionBusy: boolean,
  previewRunning: boolean,
): boolean {
  return phase === "design-review" && !sessionBusy && !previewRunning;
}

function buildTaskPrompt(
  task: string,
  entryHtml: string,
  fileCount: number,
  pages: D2cImportResult["pages"],
  framework: D2cFramework,
  frontendTechnology?: string,
): string {
  const frameworkLabel = frontendTechnology ?? (framework === "vue" ? "Vue 3" : "React");
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

function ProductPrototypePreview({ url, onStart }: { url: string | undefined; onStart(): void }): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const updateScale = (width: number): void => {
      setScale(Math.min(1, Math.max(0.1, width / PRODUCT_PREVIEW_VIEWPORT.width)));
    };
    updateScale(canvas.clientWidth);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) updateScale(width);
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  const scaledHeight = Math.round(PRODUCT_PREVIEW_VIEWPORT.height * scale);
  return <figure className="d2c-product-preview" data-running={url !== undefined}>
    <figcaption>
      <span><i aria-hidden="true" />DESKTOP PREVIEW</span>
      <code>1280 × 800</code>
      <em>适应宽度 · {Math.round(scale * 100)}%</em>
    </figcaption>
    <div className="d2c-product-preview-canvas" ref={canvasRef} style={url === undefined ? undefined : { height: scaledHeight }}>
      {url !== undefined ? <iframe src={url} title="D2C product prototype"
        width={PRODUCT_PREVIEW_VIEWPORT.width} height={PRODUCT_PREVIEW_VIEWPORT.height}
        style={{ transform: `scale(${scale})` }} sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
        referrerPolicy="no-referrer" />
        : <button type="button" onClick={onStart}>启动原型预览</button>}
    </div>
  </figure>;
}

function InteractiveDesktopPreview({ url, reloadKey, task }: { url: string; reloadKey: number; task: string }): React.JSX.Element {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const update = (): void => setScale(Math.min(1, Math.max(0.1,
      Math.min(canvas.clientWidth / PRODUCT_PREVIEW_VIEWPORT.width, canvas.clientHeight / PRODUCT_PREVIEW_VIEWPORT.height))));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  return <div className="d2c-live-canvas" ref={canvasRef}>
    <div className="d2c-live-desktop" style={{
      width: PRODUCT_PREVIEW_VIEWPORT.width * scale,
      height: PRODUCT_PREVIEW_VIEWPORT.height * scale,
    }}>
      <iframe key={reloadKey} src={url} title="D2C interactive preview"
        width={PRODUCT_PREVIEW_VIEWPORT.width} height={PRODUCT_PREVIEW_VIEWPORT.height}
        style={{ transform: `scale(${scale})` }} sandbox="allow-scripts allow-forms allow-modals allow-same-origin"
        referrerPolicy="no-referrer" data-task={task} />
    </div>
    <span className="d2c-live-viewport">1280 × 800 · {Math.round(scale * 100)}%</span>
  </div>;
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

export function E2eViewer({ onClose, onInterrupt, onError, refreshKey, onStartTask, pending, onLaunch, disabled = false }: D2cViewerProps): React.JSX.Element {
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
  const [entryMode, setEntryMode] = useState<"requirement" | "design">("requirement");
  const [requirement, setRequirement] = useState("");
  const [productView, setProductView] = useState<D2cProductPlanView>();
  const [productPreview, setProductPreview] = useState<D2cProductPreviewStatus>({ running: false });
  const [productFeedback, setProductFeedback] = useState("");
  const [productBusy, setProductBusy] = useState(false);
  const disabledRef = useRef(disabled);
  const productPhaseRef = useRef<D2cProductPhase | undefined>(productView?.plan.phase);
  disabledRef.current = disabled;
  productPhaseRef.current = productView?.plan.phase;
  const [inspectorTab, setInspectorTab] = useState<"review" | "integration">("review");
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewInstruction, setReviewInstruction] = useState("");
  const [integration, setIntegration] = useState<D2cIntegrationView>();
  const [integrationBusy, setIntegrationBusy] = useState(false);
  const [mockStatus, setMockStatus] = useState<D2cMockStatus>({ running: false });
  const [previewStatus, setPreviewStatus] = useState<D2cPreviewStatus>({ running: false });
  const [interactionRun, setInteractionRun] = useState<D2cInteractionRun>();
  const [interactionReview, setInteractionReview] = useState<D2cInteractionStatus["review"]>();
  const [interactionBusy, setInteractionBusy] = useState(false);
  const [interactionPlayback, setInteractionPlayback] = useState(false);
  const [judgeConfig, setJudgeConfig] = useState<D2cJudgeConfigView>({ configured: false });
  const [judgeBusy, setJudgeBusy] = useState(false);
  const [qualityIssueBusy, setQualityIssueBusy] = useState<string>();
  const [judgeEditing, setJudgeEditing] = useState(false);
  const [judgeDraft, setJudgeDraft] = useState<D2cJudgeConfig>({
    protocol: "openai-compatible", baseURL: "", apiKey: "", model: "", passThreshold: 80,
  });
  const [previewReloadKey, setPreviewReloadKey] = useState(0);
  const automatedAfterAgentRef = useRef<string | undefined>(undefined);
  const qualityRepairAfterAgentRef = useRef<{ task: string; category: D2cQualityIssue["category"]; armed: boolean } | undefined>(undefined);
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

  const repairProductManifest = async (): Promise<void> => {
    if (productView?.validationError?.stage !== "design" || productBusy || disabled) return;
    setProductBusy(true);
    try {
      const task = productView.plan.task;
      const submitted = await onStartTask([
        `修复 E2E 任务“${task}”的交互清单。`,
        `只允许修改 .flavor/d2c/${task}/product/prototype/interaction-manifest.json，不要重新生成 PRD、原型 HTML、资源或 OpenAPI。`,
        `当前预检错误：${productView.validationError.message}`,
        "先读取现有原型与清单，保留全部页面、场景和业务意图，将每个步骤转换为 Flavor Code 支持的严格 action/expect 协议。",
        "完成后必须自行重新读取 JSON，确认可解析且没有额外字段，再汇报修复数量。",
      ].join("\n"));
      if (submitted) await refreshProduct(task);
    } catch (cause) { reportError(cause); }
    finally { setProductBusy(false); }
  };

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
      const serviceLabel = bundle.deliveryOrigin === "requirement" ? "真实后端服务" : "本地契约服务";
      const submitted = await onStartTask(`${generated.prompt}\nFlavor Code 已保持交互预览 ${status.url ?? "本地动态端口"} 与${serviceLabel} ${status.mockUrl ?? "本地动态端口"} 运行，.env.local 已配置 VITE_API_BASE_URL。`);
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
    setInteractionPlayback(true);
    setInteractionRun(undefined);
    setInteractionReview(undefined);
    try {
      const status = await window.flavorDesktop.runD2cInteractionTests(bundle.report.task);
      setInteractionRun(status.result);
      setInteractionReview(status.review);
      setBundle((current) => current === undefined ? current : { ...current, workflow: status.workflow });
      setIntegration((current) => current === undefined ? current : { ...current, workflow: status.workflow });
    } catch (cause) { reportError(cause); }
    finally { setInteractionPlayback(false); setInteractionBusy(false); }
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

  const ensureProductPreview = useCallback(async (task: string): Promise<void> => {
    const status = await window.flavorDesktop.startD2cProductPreview(task);
    setProductPreview(status);
  }, []);

  const refreshProduct = useCallback(async (task: string): Promise<D2cProductPlanView | undefined> => {
    const next = await window.flavorDesktop.getD2cProduct(task);
    if (next !== undefined && !shouldDeferD2cProductReview(
      productPhaseRef.current, next.plan.phase, disabledRef.current,
    )) setProductView(next);
    return next;
  }, []);

  useEffect(() => {
    if (productView === undefined) return;
    const generating = productView.plan.phase === "prd-generating" || productView.plan.phase === "design-generating";
    if (!generating) return;
    void refreshProduct(productView.plan.task).catch(reportError);
    const timer = setInterval(() => { void refreshProduct(productView.plan.task).catch(reportError); }, disabled ? 1_500 : 600);
    return () => clearInterval(timer);
  }, [disabled, productView?.plan.phase, productView?.plan.task, refreshProduct]);

  useEffect(() => {
    const task = productView?.plan.task;
    if (task === undefined || !shouldStartD2cProductPreview(productView?.plan.phase, disabled, productPreview.running)) return;
    let active = true;
    void window.flavorDesktop.startD2cProductPreview(task).then((status) => {
      if (active) setProductPreview(status);
    }).catch(reportError);
    return () => { active = false; };
  }, [disabled, productPreview.running, productView?.plan.phase, productView?.plan.task]);

  useEffect(() => {
    if (productView !== undefined || !taskValid || entryMode !== "requirement") return;
    const timer = setTimeout(() => {
      void window.flavorDesktop.getD2cProduct(taskName).then((next) => {
        if (next !== undefined && !shouldDeferD2cProductReview(
          productPhaseRef.current, next.plan.phase, disabledRef.current,
        )) {
          setProductView(next);
          setFramework(next.plan.framework);
        }
      }).catch(reportError);
    }, 350);
    return () => clearTimeout(timer);
  }, [disabled, entryMode, productView, taskName, taskValid]);

  const startProduct = async (): Promise<void> => {
    if (!taskValid || requirement.trim().length < 2 || productBusy || disabled) return;
    setProductBusy(true);
    try {
      const result = await window.flavorDesktop.createD2cProduct({ task: taskName, framework: "vue", requirement });
      setProductView(result.view);
      setProductFeedback("");
      await onStartTask(result.prompt);
    } catch (cause) { reportError(cause); }
    finally { setProductBusy(false); }
  };

  const decideProduct = async (stage: "prd" | "design", accepted: boolean): Promise<void> => {
    if (productView === undefined || productBusy || disabled) return;
    if (!accepted && productFeedback.trim().length === 0) return;
    setProductBusy(true);
    try {
      const result = await window.flavorDesktop.decideD2cProduct(
        productView.plan.task, stage, accepted, accepted ? undefined : productFeedback,
      );
      setProductView(result.view);
      setProductFeedback("");
      if (result.prompt !== undefined) await onStartTask(result.prompt);
      if (result.imported !== undefined) {
        await dispatchD2cTask(
          buildTaskPrompt(result.imported.task, result.imported.entryHtml, result.imported.files.length, result.imported.pages,
            result.view.plan.framework, result.view.plan.technology?.frontend),
          result.imported.task,
          result.view.plan.framework,
          onStartTask,
          onLaunch,
        );
      }
    } catch (cause) { reportError(cause); }
    finally { setProductBusy(false); }
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

  const resolveQualityIssue = async (issue: D2cQualityIssue, decision: "skipped" | "fixing"): Promise<void> => {
    if (bundle === undefined || qualityIssueBusy !== undefined || disabled) return;
    setQualityIssueBusy(issue.id);
    try {
      const result = await window.flavorDesktop.resolveD2cQualityIssue(bundle.report.task, issue.id, decision);
      setBundle((current) => current === undefined ? current : { ...current, workflow: result.workflow });
      setIntegration((current) => current === undefined ? current : { ...current, workflow: result.workflow });
      if (decision === "fixing" && result.prompt !== undefined) {
        qualityRepairAfterAgentRef.current = { task: bundle.report.task, category: issue.category, armed: false };
        const submitted = await onStartTask(result.prompt);
        if (submitted) onLaunch(bundle.report.task, result.workflow.framework);
        else qualityRepairAfterAgentRef.current = undefined;
      }
    } catch (cause) { reportError(cause); }
    finally { setQualityIssueBusy(undefined); }
  };

  useEffect(() => {
    const task = bundle?.report.task;
    const repair = qualityRepairAfterAgentRef.current;
    if (repair !== undefined && task === repair.task) {
      if (pending !== undefined && pending.task === task) repair.armed = true;
      if (pending === undefined && repair.armed) {
        qualityRepairAfterAgentRef.current = undefined;
        if (repair.category === "visual") {
          void loadReports().catch(reportError);
        } else {
          void (async () => {
            setInteractionBusy(true);
            setInteractionPlayback(true);
            try {
              if (!previewStatus.running) {
                const ready = await window.flavorDesktop.startD2cPreview(task);
                setPreviewStatus(ready);
                setMockStatus({ running: ready.mockUrl !== undefined, ...(ready.mockUrl === undefined ? {} : { url: ready.mockUrl }) });
              }
              const status = await window.flavorDesktop.runD2cInteractionTests(task);
              setInteractionRun(status.result);
              setInteractionReview(status.review);
              const judged = await window.flavorDesktop.runD2cQualityJudge(task);
              setBundle((current) => current === undefined ? current : { ...current, workflow: judged.workflow });
              setIntegration((current) => current === undefined ? current : { ...current, workflow: judged.workflow });
            } catch (cause) { reportError(cause); }
            finally { setInteractionPlayback(false); setInteractionBusy(false); }
          })();
        }
      }
      return;
    }
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

  return <section className="d2c-workbench d2c-v2" aria-label="E2E 端到端交付" data-state={viewState}>
    <header className="d2c-workbench-header">
      <div className="d2c-title-group">
        <button className="d2c-back" onClick={onClose} aria-label="返回对话">←</button>
        <div className="e2e-title-copy"><p>END-TO-END DELIVERY</p><div className="e2e-title-row"><h1>E2E</h1><span>D2C · 视觉还原</span></div></div>
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
        <button className="d2c-new-task" onClick={() => setCreating(true)}><span>＋</span> 新建 E2E</button>
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

      {viewState === "create" ? <main className={`d2c-start-screen${productView === undefined ? "" : " d2c-start-screen-product"}`}>
        <section className="d2c-start-intro">
          <p className="d2c-start-kicker">INTENT → EVIDENCE → SHIPPABLE UI</p>
          <h2>让一个想法沿着<br />可确认的轨道成为产品</h2>
          <p>从粗需求出发，先确认 PRD，再确认可交互设计；每一次确认都会成为后续生成、联调和验收的真实基线。</p>
          <ol className="e2e-pipeline" aria-label="E2E 从需求到成果物流程">
            <li><b>01</b><span><strong>需求</strong><small>粗需求输入</small></span></li>
            <li><b>02</b><span><strong>PRD</strong><small>产品定义</small></span></li>
            <li><b>03</b><span><strong>交互设计</strong><small>原型确认</small></span></li>
            <li data-module="d2c"><b>04</b><span><strong>D2C</strong><small>视觉还原</small></span></li>
            <li><b>05</b><span><strong>API 联调</strong><small>Swagger</small></span></li>
            <li><b>06</b><span><strong>自主验收</strong><small>多模态测试</small></span></li>
            <li><b>07</b><span><strong>成果交付</strong><small>评分与工件</small></span></li>
          </ol>
          {catalogReports.length > 0 && <div className="d2c-start-reports">
            <header><strong>最近结果</strong><span>{catalogReports.length} 个批次</span></header>
            {catalogReports.slice(0, 3).map((item) => <button key={`${item.task}/${item.reportId}`} onClick={() => void loadBundle(item)}>
              <span><strong>{item.task}</strong><small>{new Date(item.createdAt).toLocaleString()}</small></span><em>{item.evaluationStatus === "invalid" ? "未完成" : item.total.toFixed(1)}</em>
            </button>)}
          </div>}
        </section>
        <section className={`d2c-start-card${productView === undefined ? "" : " d2c-start-card-product"}`} aria-label="创建 E2E 任务">
          <header><span>NEW DELIVERY</span><h2>{productView === undefined ? "选择起点" : productView.plan.task}</h2>
            <p>{productView === undefined ? "从需求开始，或沿用已有设计稿。" : "关键工件需要你的确认，AI 不会越过阶段门。"}</p></header>
          {productView === undefined && <div className="d2c-entry-switch" role="tablist" aria-label="E2E 输入方式">
            <button type="button" role="tab" aria-selected={entryMode === "requirement"} data-active={entryMode === "requirement"}
              onClick={() => setEntryMode("requirement")}><strong>从需求开始</strong><small>自动生成 PRD 与交互稿</small></button>
            <button type="button" role="tab" aria-selected={entryMode === "design"} data-active={entryMode === "design"}
              onClick={() => setEntryMode("design")}><strong>已有设计稿</strong><small>导入 Pixso HTML</small></button>
          </div>}
          {productView !== undefined && <ol className="d2c-delivery-rail" aria-label="需求到交付进度">
            <li data-state={productView.plan.phase === "prd-generating" ? "active" : "done"}><span>01</span><div><strong>产品定义</strong><small>PRD</small></div></li>
            <li data-state={productView.plan.phase === "design-generating" || productView.plan.phase === "design-review" ? "active"
              : productView.plan.phase === "ready-for-d2c" ? "done" : "waiting"}><span>02</span><div><strong>体验基线</strong><small>交互原型</small></div></li>
            <li data-state={productView.plan.phase === "ready-for-d2c" ? "active" : "waiting"} data-module="d2c"><span>03</span><div><strong>D2C 视觉还原</strong><small>进入实现</small></div></li>
          </ol>}
          {productView === undefined && <>
          <label className="d2c-start-field"><span>任务名</span>
            <input value={taskName} placeholder="例如 homepage" aria-label="E2E 任务名" autoFocus
              onChange={(event) => setTaskName(event.target.value.trim().toLowerCase())} />
            <small data-error={taskName !== "" && !taskValid}>{taskName !== "" && !taskValid ? "仅支持小写字母、数字和连字符" : "将用于输出目录和评测报告标识"}</small>
          </label>
          {entryMode === "design" && <fieldset className="d2c-stack-picker"><legend>技术栈</legend>
            {(["vue", "react"] as const).map((value) => <button type="button" key={value} role="radio" aria-checked={framework === value}
              data-active={framework === value} onClick={() => setFramework(value)}>
              <span className="d2c-stack-mark">{value === "vue" ? "V" : "R"}</span>
              <span><strong>{value === "vue" ? "Vue 3" : "React"}</strong><small>{value === "vue" ? "Composition API · Vite" : "Hooks · Vite"}</small></span>
              <i>{framework === value ? "✓" : ""}</i>
            </button>)}
          </fieldset>}
          {entryMode === "requirement" ? <>
            <label className="d2c-start-field d2c-requirement-field"><span>用几句话描述需求</span>
              <textarea value={requirement} rows={5} maxLength={50_000}
                placeholder="例如：给连锁门店店长做一个经营台，打开后能快速发现异常门店，并下钻查看订单和退款原因。"
                onChange={(event) => setRequirement(event.target.value)} />
              <small>不需要写成 PRD；目标用户、要解决的问题和最重要的动作最有帮助。</small>
            </label>
            <div className="d2c-default-stack" aria-label="默认技术方案">
              <span>DEFAULT STACK</span>
              <strong>Vue 3 + Python + SQLite</strong>
              <small>真实后端联调 · 可迁移至 MySQL / PostgreSQL</small>
            </div>
            <button className="d2c-start-primary" disabled={!taskValid || requirement.trim().length < 2 || productBusy || disabled}
              onClick={() => void startProduct()}><span>{productBusy ? "正在建立产品上下文…" : "生成 PRD"}</span><b aria-hidden="true">→</b></button>
            <p className="d2c-start-note"><span>⌁</span> PRD 和交互稿会分别等待确认，不会直接进入编码。</p>
          </> : <>
            <button className="d2c-start-primary" disabled={!taskValid || launching || disabled} onClick={() => void startD2c()}>
              <span>{launching ? "正在选择并导入…" : "导入 HTML，从 D2C 视觉还原开始"}</span><b aria-hidden="true">→</b>
            </button>
            <p className="d2c-start-note"><span>⌁</span> 选择 Pixso HTML 文件夹后会立即开始生成，无需再次确认。</p>
          </>}
          </>}
          {productView?.plan.phase === "prd-generating" && <div className="d2c-artifact-wait" aria-live="polite">
            <i /><div><strong>正在把粗需求整理成 PRD</strong><span>AI 会先建立范围、状态与验收标准；完成后这里自动刷新。</span></div>
            <button type="button" onClick={() => void refreshProduct(productView.plan.task)}>刷新</button>
          </div>}
          {productView?.plan.phase === "prd-review" && <div className="d2c-artifact-review">
            <header><span>PRODUCT REQUIREMENT</span><h3>确认产品定义</h3><p>这份 PRD 将约束后续视觉、交互和代码生成。</p></header>
            <div className="d2c-prd-document">{productView.prdMarkdown !== undefined && <MarkdownContent text={productView.prdMarkdown} />}</div>
            <label><span>退回意见</span><textarea rows={3} value={productFeedback} placeholder="例如：补充退款失败后的恢复路径"
              onChange={(event) => setProductFeedback(event.target.value)} /></label>
            <div className="d2c-artifact-actions"><button type="button" disabled={productBusy || disabled || productFeedback.trim().length === 0}
              onClick={() => void decideProduct("prd", false)}>退回修改</button>
              <button type="button" className="primary" disabled={productBusy || disabled} onClick={() => void decideProduct("prd", true)}>确认 PRD，生成交互稿</button></div>
          </div>}
          {productView?.plan.phase === "design-generating" && <div className="d2c-artifact-wait"
            data-invalid={productView.validationError?.stage === "design"} aria-live="polite">
            <i /><div>{productView.validationError?.stage === "design" ? <>
              <strong>交互契约未通过预检</strong><span>{productView.validationError.message}</span>
            </> : <><strong>正在生成可交互体验基线</strong><span>视觉、关键状态和行为契约会一起落盘。</span></>}</div>
            {productView.validationError?.stage === "design"
              ? <button type="button" disabled={productBusy || disabled} onClick={() => void repairProductManifest()}>自动修复清单</button>
              : <button type="button" onClick={() => void refreshProduct(productView.plan.task)}>刷新</button>}
          </div>}
          {productView?.plan.phase === "design-review" && <div className="d2c-artifact-review d2c-design-review">
            <header><span>INTERACTIVE PROTOTYPE</span><h3>直接体验，再决定是否开发</h3><p>点击、输入并检查主流程和异常状态；确认后它会成为 E2E 中 D2C 视觉还原的设计基线。</p></header>
            <ProductPrototypePreview url={productPreview.url} onStart={() => void ensureProductPreview(productView.plan.task)} />
            <div className="d2c-prototype-tools"><span>{productPreview.running ? "● LOOPBACK PREVIEW" : "PREVIEW STOPPED"}</span>
              {productPreview.running && <button type="button" onClick={() => void window.flavorDesktop.openD2cProductPreview(productView.plan.task)}>浏览器打开</button>}</div>
            <label><span>退回意见</span><textarea rows={3} value={productFeedback} placeholder="例如：筛选结果缺少空状态，趋势图悬停信息不够明确"
              onChange={(event) => setProductFeedback(event.target.value)} /></label>
            <div className="d2c-artifact-actions"><button type="button" disabled={productBusy || disabled || productFeedback.trim().length === 0}
              onClick={() => void decideProduct("design", false)}>退回修改</button>
              <button type="button" className="primary" disabled={productBusy || disabled} onClick={() => void decideProduct("design", true)}>确认设计，进入 D2C 视觉还原</button></div>
          </div>}
          {productView?.plan.phase === "ready-for-d2c" && <div className="d2c-artifact-wait" data-ready="true">
            <i /><div><strong>设计基线已确认</strong><span>如果生成任务未启动或应用曾关闭，可从这里安全地继续 D2C 视觉还原。</span></div>
            <button type="button" disabled={productBusy || disabled} onClick={() => void decideProduct("design", true)}>继续视觉还原 →</button>
          </div>}
          {disabled && <p className="d2c-start-warning">当前会话正在执行其他任务，完成或中断后可开始 E2E。</p>}
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
            <InteractiveDesktopPreview url={previewStatus.url} reloadKey={previewReloadKey} task={bundle!.report.task} />
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
          <nav className="d2c-stage-tabs" aria-label="E2E 交付阶段">
            <button type="button" data-active={inspectorTab === "review"} aria-pressed={inspectorTab === "review"}
              onClick={() => setInspectorTab("review")}><span>04</span>D2C 视觉还原</button>
            <button type="button" data-active={inspectorTab === "integration"} aria-pressed={inspectorTab === "integration"}
              disabled={reviewState === undefined || !reviewState.complete || bundle.report.evaluation.status === "invalid"}
              title={reviewState?.complete ? "进入接口联调" : "全部差异通过后解锁"} onClick={openIntegration}><span>05—07</span>联调、验收与交付</button>
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
                onClick={() => void mutateReview(allIssues.map((item) => item.fingerprint), "accepted")}>全部跳过（不扣分）</button>}
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
              ? "修复项目并重新运行 E2E 中的 D2C 视觉还原后，这里会生成可定位的差异清单。"
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
                    onClick={() => void mutateReview([issue.fingerprint], "accepted")}>跳过（本项不扣分）</button>
                  <button type="button" className="d2c-fix" disabled={reviewBusy || disabled}
                    onClick={() => void mutateReview([issue.fingerprint], "needs-fix", reviewInstruction || undefined)}>修复并自动视觉复验</button>
                </div>
              </div>}
            </li>; })}
          </ol>}
          {filteredIssues.length > issueLimit && <button className="d2c-show-more" onClick={() => setIssueLimit((value) => value + INITIAL_ISSUE_LIMIT)}>再显示 {Math.min(INITIAL_ISSUE_LIMIT, filteredIssues.length - issueLimit)} 条</button>}
          </> : <section className="d2c-integration-panel" aria-label="接口联调">
            <header><p>API INTEGRATION</p><h2>{integration === undefined
              ? bundle.deliveryOrigin === "requirement" ? "自动准备接口契约" : "导入接口描述"
              : integration.document.title}</h2>
              <span>{integration === undefined
                ? bundle.deliveryOrigin === "requirement" ? "根据已确认 PRD 与实现模块生成 OpenAPI，无需手动上传。" : "上传 Swagger / OpenAPI JSON，自动匹配页面模块和接口出入参。"
                : `${integration.document.version}${integration.document.baseUrl ? ` · ${integration.document.baseUrl}` : ""}`}</span></header>
            {integration === undefined ? <div className="d2c-api-import" data-origin={bundle.deliveryOrigin}>
              <span aria-hidden="true">{"{}"}</span><strong>{bundle.deliveryOrigin === "requirement" ? "正在根据 PRD 与模块准备 OpenAPI 契约" : "Swagger JSON"}</strong>
              <p>{bundle.deliveryOrigin === "requirement" ? "契约会自动生成并映射到当前实现；也可接入已有后端契约覆盖默认结果。" : "支持 Swagger 2.0、OpenAPI 3.0/3.1 和文档内引用。"}</p>
              <button type="button" disabled={integrationBusy} onClick={() => void importOpenApi()}>{integrationBusy
                ? bundle.deliveryOrigin === "requirement" ? "自动准备中…" : "正在解析…"
                : bundle.deliveryOrigin === "requirement" ? "接入已有 Swagger / OpenAPI" : "选择 swagger.json"}</button>
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
                <div><i /><span><strong>{bundle.deliveryOrigin === "requirement"
                  ? mockStatus.running ? "真实后端服务运行中" : "真实后端服务未启动"
                  : mockStatus.running ? "本地契约服务运行中" : "本地契约服务未启动"}</strong><small>{mockStatus.url ?? "生成联调代码后可启动"}</small></span></div>
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
                    onClick={() => void runInteractionTests()}>{interactionPlayback ? "可视回放中…" : interactionBusy ? "处理中…" : "运行自动验收"}</button>
                  {previewStatus.running && <button type="button" onClick={() => void window.flavorDesktop.openD2cPreview(bundle.report.task)}>浏览器打开</button>}
                </div>
                {interactionPlayback && <div className="d2c-playback-notice" role="status" aria-live="polite">
                  <i aria-hidden="true" /><span><strong>正在可视化回放</strong>
                    <small>{judgeConfig.configured ? "多模态模型正在观察并规划用户旅程；随后青色指针会完成点击、输入、导航和检查。"
                      : "请观察左侧页面：青色指针会依次完成设计契约中的定位、点击、输入和检查。配置多模态模型后可启用自主审阅。"}</small></span>
                </div>}
                {interactionReview !== undefined && <div className="d2c-review-plan" data-mode={interactionReview.mode}>
                  <strong>{interactionReview.mode === "autonomous" ? "自主审阅已执行"
                    : interactionReview.mode === "contract-fallback" ? "自主规划失败，已执行设计契约" : "设计契约已执行"}</strong>
                  <span>{interactionReview.plannedScenarios} 条用户旅程{interactionReview.model ? ` · ${interactionReview.model}` : ""}</span>
                  {interactionReview.summary && <p>{interactionReview.summary}</p>}
                  {interactionReview.warning && <p role="alert">{interactionReview.warning}</p>}
                </div>}
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
                    {bundle.workflow.quality === undefined ? <p>可随时评测当前版本；自动与人工验收未通过时，评分只用于诊断，不会放行最终交付。</p> : <div className="d2c-quality-result">
                      <div><span>视觉质量 <b>{bundle.workflow.quality.visualScore}</b></span><span>交互质量 <b>{bundle.workflow.quality.interactionScore}</b></span>
                        <span>综合得分 <b>{bundle.workflow.quality.overallScore}</b></span></div>
                      <strong>{bundle.workflow.quality.verdict === "pass" ? "质量门通过" : "质量门未通过"}</strong>
                      <p>{bundle.workflow.quality.summary}</p>
                      {bundle.workflow.quality.issues.length > 0 && <ol>{bundle.workflow.quality.issues.map((issue) => <li key={issue.id}
                        data-severity={issue.severity} data-decision={issue.decision}>
                        <span>{issue.description}</span><small>{issue.recommendation}</small>
                        <em>{issue.category} · 影响 {issue.scoreImpact} 分 · {issue.decision === "skipped" ? "已跳过，不扣分" : issue.decision === "fixing" ? "修复中，完成后自动复验" : "待处理"}</em>
                        <div className="d2c-quality-issue-actions">
                          <button type="button" disabled={qualityIssueBusy !== undefined || issue.decision === "skipped"}
                            onClick={() => void resolveQualityIssue(issue, "skipped")}>跳过（不扣分）</button>
                          <button type="button" disabled={qualityIssueBusy !== undefined || issue.decision === "fixing"}
                            onClick={() => void resolveQualityIssue(issue, "fixing")}>修复并自动复验</button>
                        </div>
                      </li>)}</ol>}
                    </div>}
                    <button type="button" className="d2c-run-judge" disabled={judgeBusy || !previewStatus.running || bundle.workflow.interaction?.automated === undefined}
                      title={bundle.workflow.interaction?.automated === undefined ? "至少运行一次自动验收后可评分；验收失败也可以评分诊断" : undefined}
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

/** @deprecated Electron uses E2eViewer; retained for tests and downstream renderer imports. */
export const D2cViewer = E2eViewer;
