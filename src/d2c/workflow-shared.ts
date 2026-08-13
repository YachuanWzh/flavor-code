import type { D2cElementDiff, D2cReport, D2cUnmatchedElement } from "./types.js";
import type { D2cQualityIssue } from "./judge.js";

export interface D2cReviewSummaryInput {
  reviews: readonly { decision: "pending" | "accepted" | "needs-fix" }[];
}

export function reviewProgress(workflow: D2cReviewSummaryInput): { total: number; pending: number; accepted: number; needsFix: number; complete: boolean } {
  const pending = workflow.reviews.filter((item) => item.decision === "pending").length;
  const accepted = workflow.reviews.filter((item) => item.decision === "accepted").length;
  const needsFix = workflow.reviews.filter((item) => item.decision === "needs-fix").length;
  return { total: workflow.reviews.length, pending, accepted, needsFix, complete: pending === 0 && needsFix === 0 };
}

function reportIssues(report: D2cReport): Array<D2cElementDiff | D2cUnmatchedElement> {
  return [...report.diffs, ...report.missing, ...report.extra];
}

function repairSelector(item: D2cElementDiff | D2cUnmatchedElement): string {
  if ("designId" in item) return item.implementationSelector ?? item.designSelector ?? "未知";
  return item.selector ?? "未知";
}

export function buildD2cRepairPrompt(report: D2cReport, fingerprints: readonly string[], instruction?: string): string {
  const selected = new Set(fingerprints);
  const issues = reportIssues(report).filter((item) => selected.has(item.fingerprint));
  if (issues.length === 0) throw new Error("No matching D2C issues were selected for repair");
  const modules = [...new Set(issues.map((item) => item.moduleId).filter((item): item is string => item !== undefined))];
  const files = [...new Set(issues.flatMap((item) => item.moduleSourceFiles ?? []))];
  const fallback = `src/d2c-output/${report.task}`;
  return [
    `修复 D2C 任务“${report.task}”的已退回差异。当前报告：${report.reportId}。`,
    `目标模块：${modules.length === 0 ? "页面级兼容模块" : modules.join("、")}。`,
    files.length === 0
      ? `旧任务缺少模块清单，只允许修改 ${fallback}/ 内与这些差异直接相关的最小文件集合。`
      : `只允许修改以下模块文件：${files.join("、")}。不得改动其他页面模块、设计稿或公共基础设施。`,
    ...issues.map((item, index) => `${index + 1}. [${item.fingerprint}] ${item.label}；impact ${item.impact}；selector ${repairSelector(item)}`),
    ...(instruction?.trim() ? [`用户补充要求：${instruction.trim()}`] : []),
    "完成局部修改后必须调用 D2cCompare 对整个实现重新评测，以发现跨模块布局回归；不要自动继续修复其他问题。首次新报告生成后立即停止，等待用户审阅。",
  ].join("\n");
}

export function buildD2cQualityRepairPrompt(task: string, issue: D2cQualityIssue): string {
  const verification = issue.category === "visual"
    ? "完成修改后必须立即调用一次 D2cCompare，自动运行视觉验收并生成新报告；不得只凭肉眼声明已修复。"
    : "完成修改后不要手工启动或停止服务；Flavor Code 会自动重跑与该问题相关的交互 case，并用真实服务端和数据库完成联调验收。";
  return [
    `修复 E2E 任务“${task}”的最终质量问题。`,
    `类别：${issue.category}；严重度：${issue.severity}；预计影响：${issue.scoreImpact} 分。`,
    `问题：${issue.description}`,
    ...(issue.evidence === undefined ? [] : [`证据：${issue.evidence}`]),
    `建议：${issue.recommendation}`,
    `只修改 src/d2c-output/${task}/ 内与此问题直接相关的最小文件集合，不得修改设计稿或验收标准。`,
    verification,
  ].join("\n");
}
