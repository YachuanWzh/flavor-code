// Model-backed git insights: commit message suggestion and diff review.
// Both use the cheap (subagent) model and degrade gracefully when the model
// is unavailable — /commit falls back to a deterministic message, /review
// surfaces the error instead of silently passing.

import { z } from "zod";

import type { ModelRegistry } from "../models/registry.js";
import { withStructuredOutput } from "../models/structured.js";

export interface GitInsightOptions {
  registry: ModelRegistry;
  /** Cheap model id provider; evaluated lazily so /model switches apply. */
  modelId(): string;
}

export async function suggestCommitMessage(
  options: GitInsightOptions,
  input: { stat: string; diff: string; hint?: string },
  signal: AbortSignal,
): Promise<string> {
  const prompt = [
    "Write a git commit message for the staged changes below.",
    "Rules: Conventional Commits style (feat/fix/refactor/docs/test/chore scope); a short imperative subject line <= 72 chars; an optional body only when the change needs explanation; no code fences; reply with the commit message only.",
    ...(input.hint === undefined || input.hint.trim() === "" ? [] : [`The user added this context: ${input.hint.trim()}`]),
    "",
    `Change summary:\n${input.stat}`,
    "",
    `Diff:\n${input.diff}`,
  ].join("\n");

  const { adapter, model } = options.registry.get(options.modelId());
  let text = "";
  for await (const event of adapter.stream({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
  })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") throw new Error(`commit message generation failed: ${event.error.message}`);
    else if (event.type === "done") break;
  }
  const cleaned = cleanCommitMessage(text);
  if (cleaned === "") throw new Error("commit message generation returned no text");
  return cleaned;
}

/** Strip fences/quotes and any trailing commentary the model may add. */
export function cleanCommitMessage(raw: string): string {
  const trimmed = raw.trim()
    .replace(/^```[a-z]*\s*/iu, "")
    .replace(/```$/u, "")
    .trim();
  // Keep only the leading message block: stop at obvious commentary markers.
  const lines = trimmed.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (/^(here('|’)s|notes?:|explanation:)/iu.test(line.trim()) && kept.length > 0) break;
    kept.push(line);
  }
  return kept.join("\n").trim().slice(0, 2_000);
}

export const ReviewFindingSchema = z.object({
  severity: z.enum(["critical", "warning", "nit"]),
  file: z.string(),
  line: z.string().describe("Line number or hunk header the finding refers to, e.g. \"42\" or \"@@ -10,4 +10,6 @@\""),
  issue: z.string(),
  suggestion: z.string(),
}).strict();

export const ReviewReportSchema = z.object({
  summary: z.string().describe("One-paragraph overall assessment of the change"),
  verdict: z.enum(["ship", "ship-with-fixes", "needs-work"]),
  findings: z.array(ReviewFindingSchema).max(20),
}).strict();

export type ReviewReport = z.infer<typeof ReviewReportSchema>;

export async function reviewDiff(
  options: GitInsightOptions,
  input: { stat: string; diff: string; untracked: readonly string[]; focus?: string },
  signal: AbortSignal,
): Promise<ReviewReport> {
  const prompt = [
    "You are reviewing uncommitted local changes before the user commits them.",
    "Focus on: correctness bugs, broken error handling, security issues (secrets, injection, path traversal), missing edge cases, and obvious test gaps.",
    "Do not comment on formatting or style unless it hides a bug. Report at most the 10 most important findings.",
    ...(input.focus === undefined || input.focus.trim() === "" ? [] : [`The user specifically wants attention on: ${input.focus.trim()}`]),
    ...(input.untracked.length === 0 ? [] : [`Untracked files not shown in the diff: ${input.untracked.join(", ")}`]),
    "",
    `Change summary:\n${input.stat}`,
    "",
    `Diff:\n${input.diff}`,
  ].join("\n");

  const structured = withStructuredOutput({
    registry: options.registry,
    modelId: options.modelId(),
    name: "report_review",
    description: "Structured review report for uncommitted changes",
    schema: ReviewReportSchema,
  });
  const { value } = await structured.invoke({
    messages: [{ role: "user", content: prompt }],
    signal,
  });
  return value;
}

export function formatReviewReport(report: ReviewReport): string {
  const lines = [`Review verdict: ${report.verdict}`, "", report.summary.trim()];
  if (report.findings.length > 0) {
    lines.push("", "Findings:");
    for (const finding of report.findings) {
      lines.push(`- [${finding.severity}] ${finding.file}${finding.line === "" ? "" : `:${finding.line}`} — ${finding.issue}`);
      if (finding.suggestion.trim() !== "") lines.push(`  fix: ${finding.suggestion}`);
    }
  } else {
    lines.push("", "No issues found.");
  }
  return lines.join("\n");
}
