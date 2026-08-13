import { diffPages } from "./diff.js";
import { computeScores } from "./score.js";
import type {
  D2cCaptureDiagnostics,
  D2cElementDiff,
  D2cEvaluation,
  D2cPageSnapshot,
  D2cReport,
  D2cScores,
  D2cUnmatchedElement,
  D2cValidityCheck,
} from "./types.js";

export interface BuildReportInput {
  task: string;
  reportId: string;
  batchId?: string;
  page?: D2cReport["page"];
  createdAt: Date;
  design: { source: string; snapshot: D2cPageSnapshot; designHash?: string; capture?: D2cCaptureDiagnostics };
  implementation: { source: string; snapshot: D2cPageSnapshot; capture?: D2cCaptureDiagnostics };
  pixelMismatchRate?: number;
}

function check(
  key: D2cValidityCheck["key"],
  label: string,
  status: D2cValidityCheck["status"],
  message: string,
): D2cValidityCheck {
  return { key, label, status, message };
}

function captureCoverage(snapshot: D2cPageSnapshot, capture: D2cCaptureDiagnostics): number {
  const naturalArea = Math.max(1, capture.naturalWidth * capture.naturalHeight);
  return Math.max(0, Math.min(1, (snapshot.width * snapshot.height) / naturalArea));
}

function buildEvaluation(input: BuildReportInput, scores: D2cScores, hasContentBlocker: boolean): D2cEvaluation {
  const { design, implementation } = input;
  const checks: D2cValidityCheck[] = [];
  const viewportMatches = design.snapshot.width === implementation.snapshot.width
    && design.snapshot.height === implementation.snapshot.height;
  checks.push(check(
    "viewport",
    "画布尺寸",
    viewportMatches ? "pass" : "fail",
    viewportMatches
      ? `${design.snapshot.width}×${design.snapshot.height}`
      : `设计稿 ${design.snapshot.width}×${design.snapshot.height}，实现 ${implementation.snapshot.width}×${implementation.snapshot.height}`,
  ));

  if (design.capture === undefined || implementation.capture === undefined) {
    checks.push(check("capture-metadata", "采集元数据", "warn", "旧报告或外部快照未提供完整采集诊断"));
  } else {
    const dprMatches = Math.abs(design.capture.devicePixelRatio - implementation.capture.devicePixelRatio) < 0.001;
    checks.push(check("dpr", "像素密度", dprMatches ? "pass" : "fail",
      dprMatches ? `DPR ${design.capture.devicePixelRatio}`
        : `设计稿 DPR ${design.capture.devicePixelRatio}，实现 DPR ${implementation.capture.devicePixelRatio}`));
    const fontsReady = design.capture.fontsReady && implementation.capture.fontsReady;
    checks.push(check("fonts", "字体加载", fontsReady ? "pass" : "fail",
      fontsReady ? "两侧字体均已就绪" : "至少一侧字体未完成加载"));
    const failedImages = design.capture.failedImages + implementation.capture.failedImages;
    checks.push(check("images", "图片加载", failedImages === 0 ? "pass" : "fail",
      failedImages === 0 ? "图片资源均已就绪" : `${failedImages} 个图片资源加载失败`));
    const clipped = design.capture.clipped || implementation.capture.clipped;
    const coverage = Math.min(
      captureCoverage(design.snapshot, design.capture),
      captureCoverage(implementation.snapshot, implementation.capture),
    );
    checks.push(check("clipping", "完整截取", clipped ? "fail" : "pass",
      clipped
        ? `仅采集 ${(coverage * 100).toFixed(1)}%：画布 ${design.snapshot.width}×${design.snapshot.height}，页面 ${design.capture.naturalWidth}×${design.capture.naturalHeight}`
        : "页面内容完整进入采集画布"));
  }

  const hasFailure = checks.some((item) => item.status === "fail");
  const hasWarning = checks.some((item) => item.status === "warn");
  const status: D2cEvaluation["status"] = hasFailure ? "invalid" : hasWarning ? "warning" : "valid";
  const confidence: D2cEvaluation["confidence"] = status === "invalid" ? "low" : status === "warning" ? "medium" : "high";
  const verdict: D2cEvaluation["verdict"] = status === "invalid"
    ? "invalid"
    : scores.total < 80
      ? "fail"
      : scores.total < 95 || hasContentBlocker
        ? "conditional"
        : "pass";
  const summary = status === "invalid"
    ? "评测环境无效，请先修复失败的可信度检查后重新运行。"
    : hasContentBlocker
      ? "存在文本或图片内容错误，不能判定为像素级还原。"
      : verdict === "pass"
        ? "实现通过像素级还原验收。"
        : verdict === "fail"
          ? "实现未达到验收基线，需要修复主要差异。"
          : "实现可继续迭代，但仍有差异或评测可信度提示。";
  return { status, confidence, verdict, summary, checks };
}

export function buildReport(input: BuildReportInput): D2cReport {
  const diff = diffPages(input.design.snapshot, input.implementation.snapshot);
  const scores = computeScores(input.design.snapshot, diff, input.pixelMismatchRate);
  const hasContentBlocker = diff.diffs.some((item) => item.textIssue !== undefined || item.imageIssue !== undefined)
    || diff.missing.some((item) => item.text.trim() !== "" || item.hasImage);
  const evaluation = buildEvaluation(input, scores, hasContentBlocker);
  return {
    schema: 2,
    task: input.task,
    reportId: input.reportId,
    ...(input.batchId === undefined ? {} : { batchId: input.batchId }),
    ...(input.page === undefined ? {} : { page: input.page }),
    createdAt: input.createdAt.toISOString(),
    design: {
      source: input.design.source,
      width: input.design.snapshot.width,
      height: input.design.snapshot.height,
      elementCount: input.design.snapshot.elements.length,
      ...(input.design.designHash === undefined ? {} : { designHash: input.design.designHash }),
      ...(input.design.capture === undefined ? {} : { capture: input.design.capture }),
    },
    implementation: {
      source: input.implementation.source,
      width: input.implementation.snapshot.width,
      height: input.implementation.snapshot.height,
      elementCount: input.implementation.snapshot.elements.length,
      ...(input.implementation.capture === undefined ? {} : { capture: input.implementation.capture }),
    },
    scores,
    evaluation,
    diffs: diff.diffs,
    missing: diff.missing,
    extra: diff.extra,
    ...(input.pixelMismatchRate === undefined ? {} : { pixelMismatchRate: input.pixelMismatchRate }),
  };
}

function formatSigned(value: number): string {
  const rounded = Math.round(value);
  if (rounded === 0) return "0px";
  return `${rounded > 0 ? "+" : ""}${rounded}px`;
}

function describeDiff(item: D2cElementDiff): string {
  const parts: string[] = [];
  const maxOffset = Math.max(Math.abs(item.dx), Math.abs(item.dy), Math.abs(item.dw), Math.abs(item.dh));
  if (maxOffset > 0) {
    parts.push(`[偏移] ${item.label} dx=${formatSigned(item.dx)} dy=${formatSigned(item.dy)}`
      + (item.dw !== 0 || item.dh !== 0 ? ` 尺寸 dw=${formatSigned(item.dw)} dh=${formatSigned(item.dh)}` : "")
      + `（设计 (${item.designRect.x},${item.designRect.y}) → 实现 (${item.implRect.x},${item.implRect.y})）`);
  }
  for (const issue of item.colorIssues) {
    const property = issue.property === "color" ? "文字色" : "背景色";
    parts.push(`[色差] ${item.label} ${property} 设计 ${issue.expected} → 实际 ${issue.actual}（ΔE ${issue.deltaE}）`);
  }
  for (const issue of item.fontIssues) {
    const property = { fontSize: "字号", fontWeight: "字重", fontFamily: "字体" }[issue.property];
    parts.push(`[字体] ${item.label} ${property} 设计 ${issue.expected} → 实际 ${issue.actual}`);
  }
  if (item.textIssue !== undefined) {
    parts.push(`[文本] ${item.label} 设计 “${item.textIssue.expected}” → 实际 “${item.textIssue.actual}”`);
  }
  if (item.imageIssue !== undefined) {
    parts.push(`[图片] ${item.label} 设计 ${item.imageIssue.expected ? "有图片" : "无图片"}`
      + ` → 实际 ${item.imageIssue.actual ? "有图片" : "无图片"}`);
  }
  return parts.join("\n");
}

function describeUnmatched(kind: "缺失" | "多余", item: D2cUnmatchedElement): string {
  const { x, y, width, height } = item.rect;
  return `[${kind}] ${item.label} 位于 (${Math.round(x)},${Math.round(y)}) ${Math.round(width)}×${Math.round(height)}`;
}

/** Plain-text report digest for the agent repair loop. */
export function summarizeReport(report: D2cReport, topN = 8): string {
  const percent = (value: number): string => Math.round(value * 100).toString();
  const lines: string[] = report.evaluation.status === "invalid" ? [
    `D2C 评测未完成 · 任务 ${report.task}`,
    `已采集区域相似度 ${report.scores.total.toFixed(1)} / 100，仅供诊断，不是正式得分`,
    ...report.evaluation.checks.filter((item) => item.status === "fail").map((item) => `${item.label}：${item.message}`),
  ] : [
    `D2C 对比完成 · 任务 ${report.task}`,
    `总分 ${report.scores.total.toFixed(1)} / 100（${report.scores.grade}）`,
    `分项: 布局 ${percent(report.scores.layout)} | 色彩 ${percent(report.scores.color)}`
      + ` | 字体 ${percent(report.scores.typography)}`
      + (report.scores.pixel === undefined ? "" : ` | 像素 ${percent(report.scores.pixel)}`),
  ];
  const issues: string[] = [];
  for (const item of report.diffs) issues.push(describeDiff(item));
  for (const item of report.missing) issues.push(describeUnmatched("缺失", item));
  for (const item of report.extra) issues.push(describeUnmatched("多余", item));
  if (issues.length === 0) {
    lines.push("未发现差异，实现与设计稿一致。");
    return lines.join("\n");
  }
  lines.push(`共 ${issues.length} 处差异${issues.length > topN ? `（显示 Top ${topN}）` : ""}：`);
  issues.slice(0, topN).forEach((issue, index) => {
    for (const [lineIndex, line] of issue.split("\n").entries()) {
      lines.push(lineIndex === 0 ? `${index + 1}. ${line}` : `   ${line}`);
    }
  });
  return lines.join("\n");
}
