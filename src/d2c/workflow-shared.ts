import type { D2cElementDiff, D2cReport, D2cUnmatchedElement } from "./types.js";
import type { D2cQualityIssue } from "./judge.js";
import type { D2cInteractionScenarioResult } from "./interaction.js";

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

export function buildD2cInteractionRepairPrompt(
  task: string,
  scenarios: readonly D2cInteractionScenarioResult[],
): string {
  const failures = scenarios.filter((scenario) => !scenario.passed);
  if (failures.length === 0) throw new Error("No failed E2E scenarios were selected for repair");
  return [
    `修复 E2E 任务“${task}”的自动验收失败项。`,
    `只允许修改 src/d2c-output/${task}/ 内与失败直接相关的前端、真实服务端和测试文件；不得修改设计稿、PRD 或 interaction-manifest.json 来绕过验收。`,
    ...failures.map((scenario, index) => [
      `${index + 1}. ${scenario.id}`,
      `页面：${scenario.pageUrl}`,
      `失败：${scenario.failure ?? "场景未通过，但没有返回失败详情"}`,
      `观测：${scenario.apiRequestCount} 次 API 请求${scenario.requests?.length
        ? `；${scenario.requests.slice(0, 5).map((request) => `${request.method} ${request.path} → ${request.status}`).join("；")}` : ""}`,
    ].join("\n")),
    "先复现并定位根因，再做最小修复。请求成功不等于数据正确：列表、表格、统计和详情必须验证服务端返回了符合 PRD 的有效业务数据，并在页面中真实可见。",
    "若数据库存在初始化或种子数据，必须按业务表独立、幂等地补齐；部分表已有数据时不得跳过其它空表，也不得通过删除用户现有数据来恢复基线。",
    "修复会话结束后 Flavor Code 会自动重跑全部交互场景；不要手工启动或停止长期运行的前端与后端服务，也不要声称未实际执行的验收已经通过。",
    "完成前运行项目构建和可用的服务端单元测试。",
  ].join("\n");
}
