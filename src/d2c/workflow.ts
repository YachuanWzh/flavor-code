import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { D2C_TASK_PATTERN, taskDir } from "./store.js";
import type { D2cInteractionRun } from "./interaction.js";
import { applyD2cQualityIssueDecision, normalizeD2cQualityJudgment, type D2cQualityJudgment } from "./judge.js";
import type { D2cElementDiff, D2cReport, D2cUnmatchedElement } from "./types.js";

export { buildD2cQualityRepairPrompt, buildD2cRepairPrompt, reviewProgress } from "./workflow-shared.js";

export type D2cWorkflowStage = "visual-review" | "api-mapping" | "integrating" | "interaction-review" | "quality-judge" | "completed";
export type D2cReviewDecision = "pending" | "accepted" | "needs-fix";

export interface D2cIssueReview {
  fingerprint: string;
  pageId: string;
  reportId: string;
  signature: string;
  label: string;
  decision: D2cReviewDecision;
  instruction?: string;
  moduleId?: string;
  moduleSourceFiles?: string[];
  updatedAt: string;
}

export interface D2cStoredOpenApi {
  sourceName: string;
  importedAt: string;
  hash: string;
  version: string;
  title: string;
  baseUrl?: string;
}

export interface D2cWorkflow {
  schema: 1;
  task: string;
  revision: number;
  stage: D2cWorkflowStage;
  framework: "vue" | "react";
  activeReportId: string;
  activeBatchId?: string;
  implementationDir: string;
  reviews: D2cIssueReview[];
  openapi?: D2cStoredOpenApi;
  mappings?: unknown[];
  integrationFiles?: string[];
  interaction?: {
    manualDecision: "pending" | "accepted";
    automated?: D2cInteractionRun;
    updatedAt: string;
  };
  quality?: D2cQualityJudgment;
  qualityWaivers?: Array<{ issueId: string; updatedAt: string }>;
  updatedAt: string;
}

const ReviewSchema = z.object({
  fingerprint: z.string().min(1).max(256), pageId: z.string().min(1).max(128), reportId: z.string().min(1).max(128),
  signature: z.string().regex(/^[a-f0-9]{64}$/), label: z.string().min(1).max(1_000),
  decision: z.enum(["pending", "accepted", "needs-fix"]), instruction: z.string().max(10_000).optional(),
  moduleId: z.string().min(1).max(128).optional(), moduleSourceFiles: z.array(z.string().min(1).max(2_048)).max(64).optional(),
  updatedAt: z.iso.datetime(),
}).strict();

const InteractionRunSchema = z.object({
  schema: z.literal(1), runAt: z.iso.datetime(), baseUrl: z.string().url().max(2_048), passed: z.boolean(),
  total: z.number().int().nonnegative().max(50_000), failures: z.number().int().nonnegative().max(50_000),
  apiRequestCount: z.number().int().nonnegative().max(10_000_000),
  scenarios: z.array(z.object({
    id: z.string().min(1).max(128), pageUrl: z.string().url().max(2_048), passed: z.boolean(),
    durationMs: z.number().int().nonnegative().max(86_400_000), apiRequestCount: z.number().int().nonnegative().max(10_000_000),
    failure: z.string().max(20_000).optional(),
  }).strict()).max(50_000),
}).strict();

const QualityJudgmentSchema = z.object({
  schema: z.literal(1), runAt: z.iso.datetime(), model: z.string().min(1).max(256),
  visualScore: z.number().min(0).max(100), interactionScore: z.number().min(0).max(100),
  rawVisualScore: z.number().min(0).max(100).optional(), rawInteractionScore: z.number().min(0).max(100).optional(),
  staticVisualScore: z.number().min(0).max(100), deterministicInteractionPassed: z.boolean(),
  overallScore: z.number().min(0).max(100), threshold: z.number().min(0).max(100), verdict: z.enum(["pass", "fail"]),
  confidence: z.enum(["high", "medium", "low"]), summary: z.string().min(1).max(4_000),
  strengths: z.array(z.string().min(1).max(1_000)).max(20),
  issues: z.array(z.object({
    category: z.enum(["visual", "interaction", "accessibility", "reliability"]),
    severity: z.enum(["minor", "major", "critical"]), description: z.string().min(1).max(2_000),
    evidence: z.string().min(1).max(2_000).optional(), recommendation: z.string().min(1).max(2_000),
    scoreImpact: z.number().min(0).max(30).optional(), id: z.string().regex(/^quality-[a-f0-9]{20}$/).optional(),
    decision: z.enum(["pending", "skipped", "fixing"]).optional(), updatedAt: z.iso.datetime().optional(),
  }).strict()).max(100),
}).strict();

const WorkflowSchema = z.object({
  schema: z.literal(1), task: z.string().regex(D2C_TASK_PATTERN), revision: z.number().int().nonnegative(),
  stage: z.enum(["visual-review", "api-mapping", "integrating", "interaction-review", "quality-judge", "completed"]), framework: z.enum(["vue", "react"]),
  activeReportId: z.string().min(1).max(128), activeBatchId: z.string().min(1).max(128).optional(),
  implementationDir: z.string().min(1).max(32_768), reviews: z.array(ReviewSchema).max(10_000),
  openapi: z.object({ sourceName: z.string().min(1).max(255), importedAt: z.iso.datetime(), hash: z.string().regex(/^[a-f0-9]{64}$/),
    version: z.string().min(1).max(32), title: z.string().min(1).max(500), baseUrl: z.string().max(4_096).optional() }).strict().optional(),
  mappings: z.array(z.unknown()).max(5_000).optional(), integrationFiles: z.array(z.string().min(1).max(2_048)).max(1_000).optional(),
  interaction: z.object({ manualDecision: z.enum(["pending", "accepted"]), automated: InteractionRunSchema.optional(), updatedAt: z.iso.datetime() }).strict().optional(),
  quality: QualityJudgmentSchema.optional(),
  qualityWaivers: z.array(z.object({ issueId: z.string().regex(/^quality-[a-f0-9]{20}$/), updatedAt: z.iso.datetime() }).strict()).max(100).optional(),
  updatedAt: z.iso.datetime(),
}).strict();

const workflowLocks = new Map<string, Promise<void>>();

function pageId(report: D2cReport): string { return report.page?.id ?? "index"; }

function issueSignature(issue: D2cElementDiff | D2cUnmatchedElement, kind: string): string {
  return createHash("sha256").update(JSON.stringify({ kind, ...issue })).digest("hex");
}

function reviewsFor(report: D2cReport, previous?: D2cWorkflow): D2cIssueReview[] {
  const prior = new Map(previous?.reviews.map((item) => [`${item.pageId}:${item.fingerprint}`, item]) ?? []);
  const now = new Date().toISOString();
  const currentPage = pageId(report);
  const entries: Array<{ issue: D2cElementDiff | D2cUnmatchedElement; kind: string }> = [
    ...report.diffs.map((issue) => ({ issue, kind: "changed" })),
    ...report.missing.map((issue) => ({ issue, kind: "missing" })),
    ...report.extra.map((issue) => ({ issue, kind: "extra" })),
  ];
  return entries.map(({ issue, kind }) => {
    const signature = issueSignature(issue, kind);
    const existing = prior.get(`${currentPage}:${issue.fingerprint}`);
    const preserved = existing?.signature === signature;
    return {
      fingerprint: issue.fingerprint, pageId: currentPage, reportId: report.reportId, signature, label: issue.label,
      decision: preserved ? existing.decision : "pending",
      ...(preserved && existing.instruction !== undefined ? { instruction: existing.instruction } : {}),
      ...(issue.moduleId === undefined ? {} : { moduleId: issue.moduleId }),
      ...(issue.moduleSourceFiles === undefined ? {} : { moduleSourceFiles: [...issue.moduleSourceFiles] }),
      updatedAt: preserved ? existing.updatedAt : now,
    };
  });
}

function implementationDirectory(report: D2cReport): string {
  const source = report.implementation.source;
  if (!/^https?:\/\//i.test(source)) return source;
  return join("src", "d2c-output", report.task);
}

export function createWorkflow(report: D2cReport, framework: "vue" | "react"): D2cWorkflow {
  const now = new Date().toISOString();
  const reviews = reviewsFor(report);
  return {
    schema: 1, task: report.task, revision: 0,
    stage: report.evaluation.status !== "invalid" && reviews.length === 0 ? "api-mapping" : "visual-review",
    framework, activeReportId: report.reportId,
    ...(report.batchId === undefined ? {} : { activeBatchId: report.batchId }),
    implementationDir: implementationDirectory(report), reviews, updatedAt: now,
  };
}

export function reconcileWorkflow(workflow: D2cWorkflow, report: D2cReport): D2cWorkflow {
  if (workflow.task !== report.task) throw new Error("D2C workflow and report tasks do not match");
  const currentPage = pageId(report);
  const sameBatch = workflow.activeBatchId !== undefined && report.batchId === workflow.activeBatchId;
  const reviews = [
    ...(sameBatch ? workflow.reviews.filter((item) => item.pageId !== currentPage) : []),
    ...reviewsFor(report, workflow),
  ];
  const complete = report.evaluation.status !== "invalid" && reviews.every((item) => item.decision === "accepted");
  const { activeBatchId: _activeBatchId, quality: _quality, ...base } = workflow;
  return {
    ...base, revision: workflow.revision + 1, activeReportId: report.reportId,
    ...(report.batchId === undefined ? {} : { activeBatchId: report.batchId }),
    implementationDir: implementationDirectory(report), reviews,
    stage: complete ? "api-mapping" : "visual-review", updatedAt: new Date().toISOString(),
  };
}

export interface D2cReviewMutation {
  fingerprints: readonly string[];
  decision: D2cReviewDecision;
  instruction?: string;
}

export function applyReviewDecision(workflow: D2cWorkflow, mutation: D2cReviewMutation, report: D2cReport): D2cWorkflow {
  if (workflow.task !== report.task || workflow.activeReportId !== report.reportId) {
    throw new Error("D2C review is stale; reload the current report");
  }
  if (mutation.fingerprints.length === 0) throw new Error("Select at least one D2C issue");
  if (mutation.decision === "accepted" && report.evaluation.status === "invalid") {
    throw new Error("评测未完成（invalid），不能通过视觉审阅");
  }
  const selected = new Set(mutation.fingerprints);
  const activePage = pageId(report);
  const known = new Set(workflow.reviews.filter((item) => item.pageId === activePage).map((item) => item.fingerprint));
  for (const fingerprint of selected) if (!known.has(fingerprint)) throw new Error(`Unknown D2C issue: ${fingerprint}`);
  const now = new Date().toISOString();
  const instruction = mutation.instruction?.trim();
  const reviews = workflow.reviews.map((item): D2cIssueReview => {
    if (item.pageId !== activePage || !selected.has(item.fingerprint)) return item;
    const { instruction: previousInstruction, ...base } = item;
    return {
      ...base, decision: mutation.decision,
      ...(instruction ? { instruction } : mutation.decision === "needs-fix" && previousInstruction !== undefined ? { instruction: previousInstruction } : {}),
      updatedAt: now,
    };
  });
  const complete = report.evaluation.status !== "invalid" && reviews.every((item) => item.decision === "accepted");
  const { quality: _quality, ...base } = workflow;
  return { ...base, revision: workflow.revision + 1, reviews, stage: complete ? "api-mapping" : "visual-review", updatedAt: now };
}

function interactionStage(interaction: D2cWorkflow["interaction"], quality?: D2cQualityJudgment): D2cWorkflowStage {
  if (interaction?.manualDecision !== "accepted" || interaction.automated?.passed !== true) return "interaction-review";
  return quality?.verdict === "pass" ? "completed" : "quality-judge";
}

export function applyInteractionRun(workflow: D2cWorkflow, automated: D2cInteractionRun): D2cWorkflow {
  const now = new Date().toISOString();
  const interaction = { manualDecision: workflow.interaction?.manualDecision ?? "pending" as const, automated, updatedAt: now };
  const { quality: _quality, ...base } = workflow;
  return { ...base, revision: workflow.revision + 1, interaction, stage: interactionStage(interaction), updatedAt: now };
}

export function applyManualInteractionDecision(workflow: D2cWorkflow, accepted: boolean): D2cWorkflow {
  const now = new Date().toISOString();
  const interaction = {
    manualDecision: accepted ? "accepted" as const : "pending" as const,
    ...(workflow.interaction?.automated === undefined ? {} : { automated: workflow.interaction.automated }),
    updatedAt: now,
  };
  const { quality: _quality, ...base } = workflow;
  return { ...base, revision: workflow.revision + 1, interaction, stage: interactionStage(interaction), updatedAt: now };
}

export function applyQualityJudgment(workflow: D2cWorkflow, quality: D2cQualityJudgment): D2cWorkflow {
  if (workflow.interaction?.automated === undefined) throw new Error("Run D2C automated interaction acceptance before running the quality judge");
  const parsed = QualityJudgmentSchema.parse(quality) as D2cQualityJudgment;
  const now = new Date().toISOString();
  return { ...workflow, revision: workflow.revision + 1, quality: parsed,
    stage: interactionStage(workflow.interaction, parsed), updatedAt: now };
}

export function applyQualityIssueDecision(
  workflow: D2cWorkflow,
  issueId: string,
  decision: "skipped" | "fixing",
): D2cWorkflow {
  if (workflow.quality === undefined) throw new Error("Run the D2C quality judge before resolving quality issues");
  const now = new Date().toISOString();
  const quality = applyD2cQualityIssueDecision(workflow.quality, issueId, decision, new Date(now));
  const withoutIssue = (workflow.qualityWaivers ?? []).filter((item) => item.issueId !== issueId);
  const qualityWaivers = decision === "skipped" ? [...withoutIssue, { issueId, updatedAt: now }] : withoutIssue;
  return {
    ...workflow,
    revision: workflow.revision + 1,
    quality,
    qualityWaivers,
    stage: interactionStage(workflow.interaction, quality),
    updatedAt: now,
  };
}

function workflowPath(workspace: string, task: string): string { return join(taskDir(workspace, task), "workflow.json"); }

async function withLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = workflowLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.then(() => current);
  workflowLocks.set(key, queued);
  await previous;
  try { return await action(); }
  finally { release(); if (workflowLocks.get(key) === queued) workflowLocks.delete(key); }
}

export async function readWorkflow(workspace: string, task: string): Promise<D2cWorkflow | undefined> {
  let raw: string;
  try { raw = await readFile(workflowPath(workspace, task), "utf8"); }
  catch { return undefined; }
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error("D2C workflow exceeds the supported size");
  const parsed = WorkflowSchema.parse(JSON.parse(raw)) as D2cWorkflow;
  return parsed.quality === undefined ? parsed : { ...parsed, quality: normalizeD2cQualityJudgment(parsed.quality) };
}

export async function writeWorkflow(workspace: string, workflow: D2cWorkflow): Promise<D2cWorkflow> {
  WorkflowSchema.parse(workflow);
  const path = workflowPath(workspace, workflow.task);
  return withLock(path, async () => {
    const stored = WorkflowSchema.parse({ ...workflow, revision: workflow.revision + 1, updatedAt: new Date().toISOString() }) as D2cWorkflow;
    await mkdir(taskDir(workspace, workflow.task), { recursive: true });
    const stage = `${path}.${randomUUID()}.tmp`;
    await writeFile(stage, `${JSON.stringify(stored, null, 2)}\n`, { flag: "wx" });
    try { await rename(stage, path); }
    finally { await rm(stage, { force: true }); }
    return stored;
  });
}
