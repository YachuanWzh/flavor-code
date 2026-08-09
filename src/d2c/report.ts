import { diffPages } from "./diff.js";
import { computeScores } from "./score.js";
import type { D2cElementDiff, D2cPageSnapshot, D2cReport, D2cUnmatchedElement } from "./types.js";

export interface BuildReportInput {
  task: string;
  reportId: string;
  createdAt: Date;
  design: { source: string; snapshot: D2cPageSnapshot; designHash?: string };
  implementation: { source: string; snapshot: D2cPageSnapshot };
  pixelMismatchRate?: number;
}

export function buildReport(input: BuildReportInput): D2cReport {
  const diff = diffPages(input.design.snapshot, input.implementation.snapshot);
  const scores = computeScores(input.design.snapshot, diff, input.pixelMismatchRate);
  return {
    schema: 1,
    task: input.task,
    reportId: input.reportId,
    createdAt: input.createdAt.toISOString(),
    design: {
      source: input.design.source,
      width: input.design.snapshot.width,
      height: input.design.snapshot.height,
      elementCount: input.design.snapshot.elements.length,
      ...(input.design.designHash === undefined ? {} : { designHash: input.design.designHash }),
    },
    implementation: {
      source: input.implementation.source,
      width: input.implementation.snapshot.width,
      height: input.implementation.snapshot.height,
      elementCount: input.implementation.snapshot.elements.length,
    },
    scores,
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
  const lines: string[] = [
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
