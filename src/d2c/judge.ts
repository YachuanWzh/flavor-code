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

export interface D2cQualityJudgment extends D2cJudgeModelAssessment {
  schema: 1;
  runAt: string;
  model: string;
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
    "视觉评分关注：布局、间距、字体、颜色、层级、图片、溢出和整体构图。只报告图片与证据能够支持的问题。",
    `静态 D2C：${report.scores.total}/100；状态 ${report.evaluation.status}；结论 ${report.evaluation.verdict}；结构化问题 ${issues.length}。`,
    ...reportEvidence(report),
    `确定性交互：${interaction.passed ? "passed" : "failed"}；${interaction.total} scenarios；${interaction.failures} failures；${interaction.apiRequestCount} API requests。`,
    ...scenarioEvidence(interaction),
    "只返回一个 JSON 对象，不要 Markdown。结构必须为：",
    '{"visualScore":0,"interactionScore":0,"confidence":"high|medium|low","summary":"...","strengths":["..."],"issues":[{"category":"visual|interaction|accessibility|reliability","severity":"minor|major|critical","description":"...","evidence":"...","recommendation":"..."}]}',
  ].join("\n").slice(0, 40_000);
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
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
  const deterministicScore = input.interaction.passed ? 100 : 0;
  const overallScore = rounded(
    assessment.visualScore * .4
    + assessment.interactionScore * .3
    + input.report.scores.total * .2
    + deterministicScore * .1,
  );
  const critical = assessment.issues.some((issue) => issue.severity === "critical");
  const verdict = input.interaction.passed && !critical && overallScore >= threshold ? "pass" : "fail";
  return {
    schema: 1,
    runAt: (input.now ?? new Date()).toISOString(),
    model: input.model,
    ...assessment,
    staticVisualScore: input.report.scores.total,
    deterministicInteractionPassed: input.interaction.passed,
    overallScore,
    threshold,
    verdict,
  };
}
