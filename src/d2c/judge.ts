import { createHash } from "node:crypto";

import { z } from "zod";

import type { D2cInteractionRun } from "./interaction.js";
import type { D2cReport } from "./types.js";

export const D2cJudgeConfigInputSchema = z.object({
  protocol: z.enum(["openai-compatible", "anthropic"]),
  baseURL: z.string().trim().url().max(2_048).refine((value) => {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:")
      && url.username === "" && url.password === "" && url.hash === "";
  }, "Judge Base URL must be an HTTP(S) URL without credentials or fragment"),
  apiKey: z.string().trim().min(1).max(16_384),
  model: z.string().trim().min(1).max(256),
  passThreshold: z.number().min(0).max(100).default(80),
}).strict();

export type D2cJudgeConfig = z.infer<typeof D2cJudgeConfigInputSchema>;

export interface D2cJudgeConfigView {
  configured: boolean;
  protocol?: D2cJudgeConfig["protocol"];
  baseURL?: string;
  model?: string;
  passThreshold?: number;
}

export const D2cJudgeIssueSchema = z.object({
  category: z.enum(["visual", "interaction", "accessibility", "reliability"]),
  severity: z.enum(["minor", "major", "critical"]),
  description: z.string().trim().min(1).max(2_000),
  evidence: z.string().trim().min(1).max(2_000).optional(),
  recommendation: z.string().trim().min(1).max(2_000),
  scoreImpact: z.number().min(0).max(30).optional(),
}).strict();

export const D2cJudgeModelAssessmentSchema = z.object({
  visualScore: z.number().min(0).max(100),
  interactionScore: z.number().min(0).max(100),
  confidence: z.enum(["high", "medium", "low"]),
  summary: z.string().trim().min(1).max(4_000),
  strengths: z.array(z.string().trim().min(1).max(1_000)).max(20),
  issues: z.array(D2cJudgeIssueSchema).max(100),
}).strict();

export type D2cJudgeIssue = z.infer<typeof D2cJudgeIssueSchema>;
export type D2cJudgeModelAssessment = z.infer<typeof D2cJudgeModelAssessmentSchema>;

export interface D2cQualityIssue extends D2cJudgeIssue {
  id: string;
  scoreImpact: number;
  decision: "pending" | "skipped" | "fixing";
  updatedAt: string;
}

export interface D2cQualityJudgment extends Omit<D2cJudgeModelAssessment, "issues"> {
  schema: 1;
  runAt: string;
  model: string;
  rawVisualScore?: number;
  rawInteractionScore?: number;
  issues: D2cQualityIssue[];
  staticVisualScore: number;
  deterministicInteractionPassed: boolean;
  overallScore: number;
  threshold: number;
  verdict: "pass" | "fail";
}

export function parseD2cJudgeModelResponse(raw: string): D2cJudgeModelAssessment {
  const bounded = raw.trim().slice(0, 256_000);
  const unfenced = bounded.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? bounded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("D2C Judge did not return a JSON object");
    try { parsed = JSON.parse(unfenced.slice(start, end + 1)); }
    catch { throw new Error("D2C Judge returned invalid JSON"); }
  }
  return D2cJudgeModelAssessmentSchema.parse(parsed);
}

function scenarioEvidence(interaction: D2cInteractionRun): string[] {
  return interaction.scenarios.slice(0, 100).map((scenario) =>
    `- ${scenario.id}: ${scenario.passed ? "passed" : "failed"}; ${scenario.durationMs}ms; `
    + `${scenario.apiRequestCount} API requests${scenario.failure === undefined ? "" : `; ${scenario.failure.slice(0, 1_000)}`}`,
  );
}

function reportEvidence(report: D2cReport): string[] {
  const changed = report.diffs.slice(0, 20).map((item) =>
    `- ${item.label}: impact ${item.impact}; dx ${item.dx}; dy ${item.dy}; dw ${item.dw}; dh ${item.dh}`
    + `${item.textIssue === undefined ? "" : `; text ${item.textIssue.expected} -> ${item.textIssue.actual}`}`,
  );
  const missing = report.missing.slice(0, Math.max(0, 20 - changed.length)).map((item) => `- missing ${item.label}: impact ${item.impact}`);
  const extra = report.extra.slice(0, Math.max(0, 20 - changed.length - missing.length)).map((item) => `- extra ${item.label}: impact ${item.impact}`);
  return [...changed, ...missing, ...extra];
}

export function buildD2cJudgePrompt(input: { report: D2cReport; interaction: D2cInteractionRun }): string {
  const { report, interaction } = input;
  const issues = [...report.diffs, ...report.missing, ...report.extra].slice(0, 30);
  return [
    "你是 D2C 最终质量评审员。请结合两张图片和确定性证据，分别判断视觉还原质量、表单与交互质量。",
    "第一张图片是设计稿，第二张图片是 Electron 内当前联调页面。不要因为页面看起来美观就忽略与设计稿的偏差。",
    "交互评分关注：表单可理解性、填写反馈、校验、提交状态、成功/失败反馈、键盘可用性以及真实 API 行为。",
    "确定性交互用例是行为是否可用的最高优先级证据。全部通过时，不得仅凭静态截图推断按钮不可点击、流程未实现或反馈缺失；只有失败用例、控制台/网络证据或截图中可见的阻断才能支持此类结论。",
    "若确定性交互全部通过且观察到真实 API 请求，interactionScore 通常应在 85-100；确有截图可见的易用性问题时可以扣分，但必须逐项给出可验证证据。",
    "视觉评分关注：布局、间距、字体、颜色、层级、图片、溢出和整体构图。只报告图片与证据能够支持的问题。",
    `静态 D2C：${report.scores.total}/100；状态 ${report.evaluation.status}；结论 ${report.evaluation.verdict}；结构化问题 ${issues.length}。`,
    ...reportEvidence(report),
    `确定性交互：${interaction.passed ? "passed" : "failed"}；${interaction.total} scenarios；${interaction.failures} failures；${interaction.apiRequestCount} API requests。`,
    ...scenarioEvidence(interaction),
    "只返回一个 JSON 对象，不要 Markdown。结构必须为：",
    "每个问题的 scoreImpact 表示该问题对所属维度造成的 0-30 分扣分，所有问题的扣分应能解释对应维度得分。",
    '{"visualScore":0,"interactionScore":0,"confidence":"high|medium|low","summary":"...","strengths":["..."],"issues":[{"category":"visual|interaction|accessibility|reliability","severity":"minor|major|critical","description":"...","evidence":"...","recommendation":"...","scoreImpact":0}]}',
  ].join("\n").slice(0, 40_000);
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function defaultIssueImpact(severity: D2cJudgeIssue["severity"]): number {
  return severity === "critical" ? 12 : severity === "major" ? 6 : 2;
}

function issueId(issue: D2cJudgeIssue): string {
  return `quality-${createHash("sha256").update(`${issue.category}\0${issue.description}\0${issue.recommendation}`).digest("hex").slice(0, 20)}`;
}

function scoreJudgment(input: D2cQualityJudgment): D2cQualityJudgment {
  const skipped = input.issues.filter((issue) => issue.decision === "skipped");
  const visualWaiver = skipped.filter((issue) => issue.category === "visual").reduce((sum, issue) => sum + issue.scoreImpact, 0);
  const interactionWaiver = skipped.filter((issue) => issue.category !== "visual").reduce((sum, issue) => sum + issue.scoreImpact, 0);
  const visualScore = rounded(Math.min(100, (input.rawVisualScore ?? input.visualScore) + visualWaiver));
  const interactionScore = rounded(Math.min(100, (input.rawInteractionScore ?? input.interactionScore) + interactionWaiver));
  const overallScore = rounded(
    visualScore * .4
    + interactionScore * .3
    + input.staticVisualScore * .2
    + (input.deterministicInteractionPassed ? 100 : 0) * .1,
  );
  const unresolved = input.issues.some((issue) => issue.decision !== "skipped");
  return {
    ...input,
    visualScore,
    interactionScore,
    overallScore,
    verdict: input.deterministicInteractionPassed && !unresolved && overallScore >= input.threshold ? "pass" : "fail",
  };
}

export function normalizeD2cQualityJudgment(judgment: D2cQualityJudgment): D2cQualityJudgment {
  return scoreJudgment({
    ...judgment,
    rawVisualScore: judgment.rawVisualScore ?? judgment.visualScore,
    rawInteractionScore: judgment.rawInteractionScore ?? judgment.interactionScore,
    issues: judgment.issues.map((issue) => ({
      ...issue,
      id: issue.id ?? issueId(issue),
      scoreImpact: issue.scoreImpact ?? defaultIssueImpact(issue.severity),
      decision: issue.decision ?? "pending",
      updatedAt: issue.updatedAt ?? judgment.runAt,
    })),
  });
}

export function applyD2cQualityIssueDecision(
  judgment: D2cQualityJudgment,
  id: string,
  decision: "skipped" | "fixing",
  now = new Date(),
): D2cQualityJudgment {
  if (!judgment.issues.some((issue) => issue.id === id)) throw new Error(`Unknown D2C quality issue: ${id}`);
  return scoreJudgment({
    ...judgment,
    issues: judgment.issues.map((issue) => issue.id === id
      ? { ...issue, decision, updatedAt: now.toISOString() }
      : issue),
  });
}

export function finalizeD2cQualityJudgment(input: {
  assessment: D2cJudgeModelAssessment;
  report: D2cReport;
  interaction: D2cInteractionRun;
  model: string;
  passThreshold: number;
  now?: Date;
}): D2cQualityJudgment {
  const assessment = D2cJudgeModelAssessmentSchema.parse(input.assessment);
  const threshold = Math.max(0, Math.min(100, input.passThreshold));
  const interactionFloor = input.interaction.passed && input.interaction.total > 0
    ? input.interaction.apiRequestCount > 0 ? 85 : 80
    : 0;
  const interactionScore = Math.max(assessment.interactionScore, interactionFloor);
  const runAt = (input.now ?? new Date()).toISOString();
  return scoreJudgment({
    schema: 1,
    runAt,
    model: input.model,
    visualScore: assessment.visualScore,
    interactionScore,
    rawVisualScore: assessment.visualScore,
    rawInteractionScore: interactionScore,
    confidence: assessment.confidence,
    summary: assessment.summary,
    strengths: assessment.strengths,
    issues: assessment.issues.map((issue) => ({
      ...issue,
      id: issueId(issue),
      scoreImpact: issue.scoreImpact ?? defaultIssueImpact(issue.severity),
      decision: "pending" as const,
      updatedAt: runAt,
    })),
    staticVisualScore: input.report.scores.total,
    deterministicInteractionPassed: input.interaction.passed,
    overallScore: 0,
    threshold,
    verdict: "fail",
  });
}
