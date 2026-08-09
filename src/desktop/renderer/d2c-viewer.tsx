import React, { useCallback, useEffect, useMemo, useState } from "react";

import type { D2cElementDiff, D2cReport, D2cUnmatchedElement } from "../../d2c/types.js";
import type { D2cImportResult, D2cReportListItem, D2cReportView } from "../contracts.js";

interface D2cViewerProps {
  onClose(): void;
  onError(message: string): void;
  /** Increments whenever a fresh D2C report event arrives, triggering a reload. */
  refreshKey: number;
  /** Sends the assembled D2C task prompt to the active conversation. */
  onStartTask(prompt: string): Promise<boolean>;
  /** Task dispatched but not yet compared; cleared by the app when its report arrives. */
  pending?: D2cPendingTask | undefined;
  /** Records a freshly dispatched task so the running state survives view switches. */
  onLaunch(task: string, framework: D2cFramework): void;
  /** Prevents starting a second prompt while the current session is busy. */
  disabled?: boolean;
}

export type D2cFramework = "vue" | "react";

/** A D2C task that has been dispatched to the agent and is still coding/comparing. */
export interface D2cPendingTask {
  task: string;
  framework: D2cFramework;
  startedAt: number;
}

const TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function buildTaskPrompt(task: string, entryHtml: string, fileCount: number, framework: D2cFramework): string {
  const frameworkLabel = framework === "vue" ? "Vue 3" : "React";
  return [
    `执行 D2C 任务 "${task}"：Pixso 设计稿已导入 .flavor/d2c/${task}/design/（入口 ${entryHtml}，共 ${fileCount} 个文件）。`,
    `请用 ${frameworkLabel} 像素级实现该设计稿：在 src/d2c-output/${task}/ 生成可运行的 Vite 项目，`,
    `然后调用 D2cCompare，implementation 传该项目目录，对比设计稿与运行中的实现并评分。`,
    `若总分低于 90，依据差异报告迭代修复实现代码（不要修改设计稿）并重新对比，直至达到 90 或用户接受，最后汇报总分与等级。`,
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

type D2cViewMode = "overlay" | "design" | "implementation" | "heatmap";

const MODE_LABELS: Record<D2cViewMode, string> = {
  overlay: "叠加对比",
  design: "设计稿",
  implementation: "实现",
  heatmap: "像素热力图",
};

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0";
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function describeColorIssues(diff: D2cElementDiff): string[] {
  return diff.colorIssues.map((issue) =>
    `${issue.property === "color" ? "文字色" : "背景色"}：设计 ${issue.expected} → 实际 ${issue.actual}（ΔE ${issue.deltaE}）`);
}

function describeFontIssues(diff: D2cElementDiff): string[] {
  const labels = { fontSize: "字号", fontWeight: "字重", fontFamily: "字体" } as const;
  return diff.fontIssues.map((issue) => `${labels[issue.property]}：设计 ${issue.expected} → 实际 ${issue.actual}`);
}

/** Offset tag like [---3px---] rendered next to an annotated region. */
function OffsetTag({ diff }: { diff: D2cElementDiff }): React.JSX.Element | null {
  const maxOffset = Math.max(Math.abs(diff.dx), Math.abs(diff.dy), Math.abs(diff.dw), Math.abs(diff.dh));
  if (maxOffset === 0) return null;
  const dashes = "-".repeat(Math.min(5, Math.max(2, Math.round(maxOffset))));
  return <span className="d2c-offset-tag" data-severity={diff.severity}>
    [{dashes}{formatSigned(diff.dx)}px,{formatSigned(diff.dy)}px{dashes}]
  </span>;
}

export function D2cViewer({ onClose, onError, refreshKey, onStartTask, pending, onLaunch, disabled = false }: D2cViewerProps): React.JSX.Element {
  const [reports, setReports] = useState<readonly D2cReportListItem[]>([]);
  const [bundle, setBundle] = useState<D2cReportView>();
  const [loading, setLoading] = useState(true);
  const [loadingReport, setLoadingReport] = useState(false);
  const [mode, setMode] = useState<D2cViewMode>("overlay");
  const [implOpacity, setImplOpacity] = useState(0.55);
  const [selectedDiff, setSelectedDiff] = useState<number>();

  const [taskName, setTaskName] = useState("");
  const [framework, setFramework] = useState<D2cFramework>("vue");
  const [imported, setImported] = useState<D2cImportResult>();
  const [launching, setLaunching] = useState(false);

  const report = (cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause));

  const taskValid = TASK_PATTERN.test(taskName);
  const importDesign = async () => {
    if (!taskValid) return;
    try {
      const result = await window.flavorDesktop.importD2cDesign(taskName);
      if (result !== undefined) setImported(result);
    } catch (cause) { report(cause); }
  };
  const startTask = async () => {
    if (imported === undefined || launching || disabled) return;
    setLaunching(true);
    try {
      await dispatchD2cTask(
        buildTaskPrompt(imported.task, imported.entryHtml, imported.files.length, framework),
        imported.task,
        framework,
        onStartTask,
        onLaunch,
      );
    } catch (cause) { report(cause); }
    finally { setLaunching(false); }
  };

  const loadReports = useCallback(async (autoSelect?: { task: string; reportId: string }) => {
    const entries = await window.flavorDesktop.listD2cReports();
    setReports(entries);
    const first = autoSelect ?? entries[0];
    if (first !== undefined) {
      try {
        setLoadingReport(true);
        setBundle(await window.flavorDesktop.getD2cReport(first.task, first.reportId));
        setSelectedDiff(undefined);
      } finally {
        setLoadingReport(false);
      }
    } else {
      setBundle(undefined);
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    loadReports().catch((cause) => { if (active) report(cause); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [refreshKey, loadReports]);

  const select = async (item: D2cReportListItem) => {
    try {
      setLoadingReport(true);
      setBundle(await window.flavorDesktop.getD2cReport(item.task, item.reportId));
      setSelectedDiff(undefined);
    } catch (cause) { report(cause); }
    finally { setLoadingReport(false); }
  };

  const issues = useMemo(() => {
    if (bundle === undefined) return { diffs: [] as D2cElementDiff[], missing: [] as D2cUnmatchedElement[], extra: [] as D2cUnmatchedElement[] };
    return { diffs: bundle.report.diffs, missing: bundle.report.missing, extra: bundle.report.extra };
  }, [bundle]);
  const issueCount = issues.diffs.length + issues.missing.length + issues.extra.length;

  const scores = bundle?.report.scores;
  const canvas = bundle === undefined ? undefined : {
    width: Math.max(bundle.report.design.width, bundle.report.implementation.width, 1),
    height: Math.max(bundle.report.design.height, bundle.report.implementation.height, 1),
  };

  return <section className="d2c-workbench" aria-label="D2C">
    <header className="d2c-workbench-header">
      <div>
        <button className="d2c-back" onClick={onClose} aria-label="返回对话">‹</button>
        <div><p>Design to Code</p><h1>D2C</h1></div>
      </div>
      {scores !== undefined && <div className="d2c-score" data-grade={scores.grade}>
        <strong>{scores.total.toFixed(1)}</strong><span>/ 100 · {scores.grade}</span>
      </div>}
      {bundle?.designOutdated === true && <span className="d2c-report-stale">设计稿已重新导入，此报告对应旧版本</span>}
    </header>

    <div className="d2c-workbench-body">
      <aside className="d2c-catalog">
        <div className="d2c-launch" aria-label="新建 D2C 任务">
          <strong>新建任务</strong>
          <input className="d2c-launch-input" value={taskName} placeholder="任务名，如 homepage"
            aria-label="D2C 任务名"
            onChange={(event) => { setTaskName(event.target.value.trim().toLowerCase()); setImported(undefined); }} />
          {taskName !== "" && !taskValid && <small className="d2c-launch-hint">任务名只能用小写字母、数字和连字符，且以字母或数字开头</small>}
          <div className="d2c-launch-framework" role="radiogroup" aria-label="目标框架">
            <button role="radio" aria-checked={framework === "vue"} data-active={framework === "vue"}
              onClick={() => setFramework("vue")}>Vue 3</button>
            <button role="radio" aria-checked={framework === "react"} data-active={framework === "react"}
              onClick={() => setFramework("react")}>React</button>
          </div>
          {imported === undefined
            ? <button className="d2c-launch-action" disabled={!taskValid} onClick={() => void importDesign()}>导入设计稿…</button>
            : <p className="d2c-launch-imported">✓ 已导入 {imported.files.length} 个文件，入口 {imported.entryHtml}</p>}
          <button className="d2c-launch-action" data-primary={imported !== undefined}
            disabled={imported === undefined || launching || disabled}
            onClick={() => void startTask()}>{launching ? "正在派发…" : "开始实现"}</button>
          {imported !== undefined && <small>派发后 Agent 将按你导入的 D2C 技能编码并对比，完成后自动在此展示结果。</small>}
          {disabled && <small className="d2c-launch-hint">当前会话正在运行，请完成或中断后再启动 D2C 任务。</small>}
        </div>
        <div className="d2c-catalog-tools"><span>⌕</span><strong>对比报告</strong><button onClick={() => void loadReports()} aria-label="刷新报告列表">↻</button></div>
        <div className="d2c-list" aria-busy={loading}>
          {loading && <p className="d2c-list-empty">正在读取报告…</p>}
          {!loading && reports.length === 0 && <div className="d2c-list-empty">
            <strong>还没有对比报告</strong>
            <span>在上方新建任务：导入设计稿、选择框架并开始实现，完成后对比结果会自动展示在这里。</span>
          </div>}
          {reports.map((item) => <button className="d2c-list-item" key={`${item.task}/${item.reportId}`}
            data-selected={bundle?.report.reportId === item.reportId && bundle.report.task === item.task}
            onClick={() => void select(item)}>
            <strong>{item.task}</strong>
            <small>{item.reportId}</small>
            <span className="d2c-list-meta"><em data-grade={item.grade}>{item.total.toFixed(1)}</em><time>{new Date(item.createdAt).toLocaleString()}</time></span>
          </button>)}
        </div>
      </aside>

      <main className="d2c-canvas-area">
        {bundle !== undefined && canvas !== undefined ? <>
          <div className="d2c-canvas-toolbar">
            <div className="d2c-mode-switch" role="tablist" aria-label="展示模式">
              {(Object.keys(MODE_LABELS) as D2cViewMode[]).map((value) =>
                <button key={value} role="tab" aria-selected={mode === value} data-active={mode === value}
                  onClick={() => setMode(value)}>{MODE_LABELS[value]}</button>)}
            </div>
            {mode === "overlay" && <label className="d2c-opacity">
              <span>实现透明度</span>
              <input type="range" min={0} max={100} value={Math.round(implOpacity * 100)}
                onChange={(event) => setImplOpacity(Number(event.target.value) / 100)} />
            </label>}
            <span className="d2c-canvas-size">{canvas.width} × {canvas.height}px</span>
          </div>

          <div className="d2c-canvas-scroll">
            <div className="d2c-canvas" style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}>
              {(mode === "overlay" || mode === "design") && <img className="d2c-layer d2c-layer-design" src={bundle.designPng} alt="设计稿截图" draggable={false} />}
              {(mode === "overlay" || mode === "implementation") && <img className="d2c-layer d2c-layer-impl" src={bundle.implementationPng}
                style={{ opacity: mode === "overlay" ? implOpacity : 1 }} alt="实现截图" draggable={false} />}
              {mode === "heatmap" && <img className="d2c-layer" src={bundle.heatmapPng} alt="像素差异热力图" draggable={false} />}

              {(mode === "overlay" || mode === "design") && <div className="d2c-annotations">
                {issues.diffs.map((diff, index) => <div className="d2c-annotation" key={diff.implId} data-severity={diff.severity}
                  data-selected={selectedDiff === index}
                  style={{
                    left: `${(diff.designRect.x / canvas.width) * 100}%`,
                    top: `${(diff.designRect.y / canvas.height) * 100}%`,
                    width: `${(diff.designRect.width / canvas.width) * 100}%`,
                    height: `${(diff.designRect.height / canvas.height) * 100}%`,
                  }}
                  onClick={() => setSelectedDiff((current) => current === index ? undefined : index)}>
                  <OffsetTag diff={diff} />
                </div>)}
                {issues.missing.map((item) => <div className="d2c-annotation d2c-annotation-missing" key={`missing-${item.id}`}
                  style={{
                    left: `${(item.rect.x / canvas.width) * 100}%`,
                    top: `${(item.rect.y / canvas.height) * 100}%`,
                    width: `${(item.rect.width / canvas.width) * 100}%`,
                    height: `${(item.rect.height / canvas.height) * 100}%`,
                  }} title={`缺失：${item.label}`}>
                  <span className="d2c-offset-tag">[缺失]</span>
                </div>)}
              </div>}
            </div>
          </div>

          <div className="d2c-issue-panel">
            <header><h2>差异明细</h2><span>{issueCount} 处</span>
              {bundle.report.pixelMismatchRate !== undefined &&
                <small>像素不一致 {Math.round(bundle.report.pixelMismatchRate * 1000) / 10}%</small>}
            </header>
            <div className="d2c-score-strip" aria-label="分项得分">
              <span>布局 {(scores!.layout * 100).toFixed(0)}</span>
              <span>色彩 {(scores!.color * 100).toFixed(0)}</span>
              <span>字体 {(scores!.typography * 100).toFixed(0)}</span>
              {scores!.pixel !== undefined && <span>像素 {(scores!.pixel * 100).toFixed(0)}</span>}
            </div>
            {issueCount === 0 ? <p className="d2c-issue-empty">未发现差异，实现与设计稿一致。</p> : <ol className="d2c-issue-list">
              {issues.diffs.map((diff, index) => <li key={diff.implId} data-severity={diff.severity} data-selected={selectedDiff === index}
                onClick={() => setSelectedDiff((current) => current === index ? undefined : index)}>
                <strong>{diff.label}</strong>
                {(Math.abs(diff.dx) > 0 || Math.abs(diff.dy) > 0 || Math.abs(diff.dw) > 0 || Math.abs(diff.dh) > 0) &&
                  <span>[偏移] dx={formatSigned(diff.dx)}px dy={formatSigned(diff.dy)}px
                    {(Math.abs(diff.dw) > 0 || Math.abs(diff.dh) > 0) && ` · 尺寸 dw=${formatSigned(diff.dw)}px dh=${formatSigned(diff.dh)}px`}</span>}
                {describeColorIssues(diff).map((line) => <span key={line}>[色差] {line}</span>)}
                {describeFontIssues(diff).map((line) => <span key={line}>[字体] {line}</span>)}
                {diff.textIssue !== undefined && <span>[文本] 设计 “{diff.textIssue.expected}” → 实际 “{diff.textIssue.actual}”</span>}
                {diff.imageIssue !== undefined && <span>[图片] 设计 {diff.imageIssue.expected ? "有图片" : "无图片"}
                  {` → 实际 ${diff.imageIssue.actual ? "有图片" : "无图片"}`}</span>}
              </li>)}
              {issues.missing.map((item) => <li key={`missing-${item.id}`} data-severity="major">
                <strong>{item.label}</strong><span>[缺失] 设计稿中存在，实现中未找到（{Math.round(item.rect.width)}×{Math.round(item.rect.height)} @ {Math.round(item.rect.x)},{Math.round(item.rect.y)}）</span>
              </li>)}
              {issues.extra.map((item) => <li key={`extra-${item.id}`} data-severity="minor">
                <strong>{item.label}</strong><span>[多余] 实现中存在，设计稿中没有（{Math.round(item.rect.width)}×{Math.round(item.rect.height)} @ {Math.round(item.rect.x)},{Math.round(item.rect.y)}）</span>
              </li>)}
            </ol>}
          </div>
        </> : pending !== undefined ? <div className="d2c-running">
          <span className="d2c-running-spinner" aria-hidden="true" />
          <h2>任务 “{pending.task}” 正在编码…</h2>
          <p>Agent 正在按设计稿生成 {pending.framework === "vue" ? "Vue 3" : "React"} 实现，编码完成后会自动运行实现项目并对比，完成后结果将自动展示在本页。</p>
          <small>开始于 {new Date(pending.startedAt).toLocaleTimeString()} · 可在左侧对话中查看编码进度</small>
        </div> : <div className="d2c-empty">
          <span>▤</span><h2>对比结果尚未就绪</h2><p>在左侧新建任务、导入设计稿并点击“开始实现”，Agent 编码完成后对比结果会自动展示在这里。</p>
        </div>}
        {loadingReport && <div className="d2c-loading" aria-busy="true">正在加载报告…</div>}
      </main>
    </div>
  </section>;
}
