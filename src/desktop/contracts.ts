import { z } from "zod";

import type { AgentEvent } from "../agent/types.js";
import type { D2cProgressEvent, D2cReport } from "../d2c/types.js";
import type { D2cWorkflow } from "../d2c/workflow.js";
import type { D2cInteractionRun } from "../d2c/interaction.js";
import type { D2cAutonomousInteractionPlan } from "../d2c/interaction-review.js";
import type { CreateD2cProductPlanInput, D2cProductPlanView, D2cProductStage } from "../d2c/product.js";
import type { D2cApiMapping, D2cOpenApiDocument } from "../d2c/openapi.js";
import type { E2eDeliveryRun } from "../e2e/delivery-run.js";
import { D2cJudgeConfigInputSchema, type D2cJudgeConfig, type D2cJudgeConfigView, type D2cQualityJudgment } from "../d2c/judge.js";
import { McpServerConfigSchema, McpServerNameSchema, type PermissionMode } from "../config/schema.js";
import type { TranscriptState } from "../ui/transcript.js";
import type { Question } from "../tools/ask-user-question.js";
import type { SessionOutput } from "../ui/session.js";
import type { ManagedSkill, ManagedSkillSummary, SkillDraft } from "../skills/manager.js";
import { MEMORY_TYPES, type MemoryCandidate, type MemoryEntry } from "../memory/types.js";
import type { MemorySnapshot } from "../memory/manager.js";
import type { MemoryReviewItem } from "../memory/review.js";
import type { JobSnapshot } from "../jobs/registry.js";
import type { ManagedMcpServer } from "../mcp/config-manager.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES,
  type ImageAttachmentInput,
} from "../session/assets.js";
export { DESKTOP_CHANNELS } from "./channels.js";

export const OpenWorkspaceInputSchema = z.object({ path: z.string().trim().min(1).max(32_768) }).strict();
export const StartSessionInputSchema = z.object({
  resumeSession: z.string().trim().min(1).max(128).optional(),
}).strict();
export const DeleteSessionInputSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Invalid session id"),
}).strict();
export const UpdateSessionInputSchema = DeleteSessionInputSchema.extend({
  title: z.string().trim().max(120).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict();
export const UpdateProjectInputSchema = z.object({
  workspace: z.string().trim().min(1).max(32_768),
  label: z.string().trim().max(80).optional(),
  pinned: z.boolean().optional(),
}).strict();
export const ProjectPathInputSchema = z.object({ workspace: z.string().trim().min(1).max(32_768) }).strict();
export const CloseProjectInputSchema = ProjectPathInputSchema.extend({ force: z.boolean().optional() }).strict();
export const GitPathInputSchema = z.object({ path: z.string().min(1).max(32_768) }).strict();
export const GitDiffInputSchema = GitPathInputSchema.extend({ staged: z.boolean().optional() }).strict();
export const GitCommitInputSchema = z.object({ message: z.string().trim().min(1).max(20_000) }).strict();
export const AppMenuInputSchema = z.object({
  menu: z.enum(["file", "edit", "view", "help"]),
  x: z.number().int().min(0).max(32_768),
  y: z.number().int().min(0).max(32_768),
}).strict();
const DesktopMessageDeliverySchema = z.enum(["prompt", "steer", "followUp"]);
const DesktopPermissionProfileSchema = z.literal("d2c");
const ImageAttachmentInputSchema = z.object({
  name: z.string().min(1).max(255),
  mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]),
  dataBase64: z.string().min(4).max(Math.ceil(DEFAULT_MAX_IMAGE_BYTES / 3) * 4 + 4),
}).strict();
export const SubmitInputSchema = z.object({
  prompt: z.string().max(1_000_000),
  delivery: DesktopMessageDeliverySchema.optional(),
  permissionProfile: DesktopPermissionProfileSchema.optional(),
  attachments: z.array(ImageAttachmentInputSchema).max(DEFAULT_MAX_IMAGES).optional(),
}).strict().superRefine((value, context) => {
  const attachments = value.attachments ?? [];
  if (value.prompt.trim().length === 0 && attachments.length === 0) {
    context.addIssue({ code: "custom", path: ["prompt"], message: "Prompt or image attachment is required" });
  }
  if (value.delivery !== undefined && value.delivery !== "prompt" && attachments.length > 0) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Images are only supported on new prompts" });
  }
  if (value.permissionProfile !== undefined && value.delivery !== undefined && value.delivery !== "prompt") {
    context.addIssue({ code: "custom", path: ["permissionProfile"], message: "Permission profiles require a new prompt" });
  }
  if (attachments.length > 0 && value.prompt.trim().startsWith("/")) {
    context.addIssue({ code: "custom", path: ["attachments"], message: "Images cannot be attached to slash commands" });
  }
});
export type DesktopImageAttachmentInput = ImageAttachmentInput;
export type DesktopMessageDelivery = z.infer<typeof DesktopMessageDeliverySchema>;
export type DesktopPermissionProfile = z.infer<typeof DesktopPermissionProfileSchema>;
export const ResolveApprovalInputSchema = z.object({ decision: z.enum(["allow", "deny", "always"]) }).strict();
export const AnswerQuestionsInputSchema = z.object({
  answers: z.record(z.coerce.number().int().min(0).max(3), z.string().min(1).max(10_000)),
}).strict();
export const ResolveMemoryReviewInputSchema = z.object({
  id: z.string().max(64).regex(/^memory-review-[1-9][0-9]*$/, "Invalid memory review id"),
  decision: z.enum(["accept", "dismiss"]),
}).strict();
const SkillNameInput = z.string().trim().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const SkillNameInputSchema = z.object({ name: SkillNameInput }).strict();
export const SkillDraftInputSchema = z.object({
  name: SkillNameInput,
  description: z.string().trim().min(1).max(4_000),
  body: z.string().trim().min(1).max(300_000),
  disableModelInvocation: z.boolean().default(false),
}).strict();
export const UpdateSkillInputSchema = z.object({
  originalName: SkillNameInput,
  draft: SkillDraftInputSchema,
}).strict();
export const SetSkillEnabledInputSchema = z.object({ name: SkillNameInput, enabled: z.boolean() }).strict();
const McpServerNameInput = McpServerNameSchema;
export const McpServerNameInputSchema = z.object({ name: McpServerNameInput }).strict();
export const SaveMcpServerInputSchema = z.object({
  originalName: McpServerNameInput.optional(),
  draft: z.object({ name: McpServerNameInput, config: McpServerConfigSchema }).strict(),
}).strict();
export const SetMcpServerEnabledInputSchema = z.object({ name: McpServerNameInput, enabled: z.boolean() }).strict();
const MemoryIdInput = z.string().regex(/^[a-f0-9]{12}$/, "Invalid memory id");
export const MemoryCandidateInputSchema = z.object({
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(20_000),
}).strict();
export const UpdateMemoryInputSchema = z.object({
  id: MemoryIdInput,
  type: z.enum(MEMORY_TYPES),
  content: z.string().trim().min(1).max(20_000),
}).strict();
export const DeleteMemoryInputSchema = z.object({ id: MemoryIdInput }).strict();
const ProviderNameInput = z.string().trim().min(1).max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "厂商名称只能包含字母、数字、下划线和连字符");
const ModelNameInput = z.string().trim().min(1).max(256)
  .regex(/^\S+$/, "模型名称不能包含空格");
const HttpUrlInput = z.string().trim().url().max(2_048).refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "Base URL 必须使用 http 或 https");

export const AddDesktopModelInputSchema = z.object({
  provider: ProviderNameInput,
  model: ModelNameInput,
  baseURL: HttpUrlInput,
  apiKey: z.string().min(1).max(16_384),
  protocol: z.enum(["openai-compatible", "anthropic"]),
}).strict();
export const SwitchDesktopModelInputSchema = z.object({
  modelId: z.string().trim().min(3).max(1_024).refine((value) => {
    const separator = value.indexOf(":");
    return separator > 0 && separator < value.length - 1;
  }, "模型 ID 必须使用 provider:model 格式"),
}).strict();

const D2cTaskInput = z.string().trim().min(1).max(64)
  .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Invalid D2C task name");
export const D2cImportInputSchema = z.object({
  task: D2cTaskInput,
}).strict();
export const D2cCreateProductInputSchema = z.object({
  task: D2cTaskInput,
  framework: z.enum(["vue", "react"]),
  requirement: z.string().trim().min(2).max(50_000),
}).strict();
export const D2cProductDecisionInputSchema = z.object({
  task: D2cTaskInput,
  stage: z.enum(["prd", "design"]),
  accepted: z.boolean(),
  feedback: z.string().trim().min(1).max(10_000).optional(),
}).strict().superRefine((value, context) => {
  if (!value.accepted && value.feedback === undefined) {
    context.addIssue({ code: "custom", path: ["feedback"], message: "Feedback is required when rejecting an artifact" });
  }
});
export const D2cPrdRegenerateInputSchema = z.object({
  task: D2cTaskInput,
  query: z.string().trim().min(1).max(10_000),
}).strict();
export const D2cPrdSectionUpdateInputSchema = z.object({
  task: D2cTaskInput,
  sectionId: z.string().trim().min(1).max(500),
  body: z.string().max(100_000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const D2cGetReportInputSchema = z.object({
  task: D2cTaskInput,
  reportId: z.string().trim().regex(/^run-\d{8}-\d{6}(?:-[2-9]\d*)?$/, "Invalid D2C report id").optional(),
}).strict();
const D2cReportInput = z.string().trim().regex(/^run-\d{8}-\d{6}(?:-[2-9]\d*)?$/, "Invalid D2C report id");
const D2cFingerprintInput = z.string().trim().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Invalid D2C issue fingerprint");
const D2cModuleInput = z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Invalid D2C module id");
export const D2cReviewInputSchema = z.object({
  task: D2cTaskInput,
  reportId: D2cReportInput,
  fingerprints: z.array(D2cFingerprintInput).min(1).max(10_000),
  decision: z.enum(["pending", "accepted", "needs-fix"]),
  instruction: z.string().trim().min(1).max(10_000).optional(),
}).strict();
export const D2cTaskActionInputSchema = z.object({ task: D2cTaskInput }).strict();
export const D2cManualAcceptanceInputSchema = z.object({ task: D2cTaskInput, accepted: z.boolean() }).strict();
export const D2cQualityIssueDecisionInputSchema = z.object({
  task: D2cTaskInput,
  issueId: z.string().regex(/^quality-[a-f0-9]{20}$/),
  decision: z.enum(["skipped", "fixing"]),
}).strict();
export { D2cJudgeConfigInputSchema };
export const D2cConfirmMappingInputSchema = z.object({
  task: D2cTaskInput,
  moduleId: D2cModuleInput,
  operationKey: z.string().trim().min(3).max(2_048).refine((value) => !/[\u0000-\u001f]/.test(value), "Invalid operation key"),
}).strict();

export type AddDesktopModelInput = z.infer<typeof AddDesktopModelInputSchema>;
export type McpServerDraft = z.input<typeof SaveMcpServerInputSchema>["draft"];

export interface DesktopModelOption {
  id: string;
  provider: string;
  model: string;
  label: string;
  description: string;
  source: "built-in" | "custom";
}

export interface DesktopSessionSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  mainModel: string;
  preview?: string;
  title?: string | undefined;
  pinned?: boolean;
  archived?: boolean;
  activity?: "running" | "completed" | "failed" | "attention" | "interrupted";
  unread?: boolean;
}

export interface DesktopActivityItem {
  id: string;
  workspace: string;
  sessionId?: string;
  kind: "completed" | "failed" | "attention" | "interrupted";
  title: string;
  detail?: string;
  createdAt: string;
  unread: boolean;
}

export interface DesktopRecoveryItem {
  workspace: string;
  sessionId: string;
  reason: string;
  interruptedAt: string;
}

export interface DesktopGitFile {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface DesktopGitStatus {
  repository: boolean;
  branch: string;
  head: string;
  files: readonly DesktopGitFile[];
}

/** Lightweight state used to render and switch projects without activating them. */
export interface DesktopProjectSummary {
  workspace: string;
  label?: string | undefined;
  pinned?: boolean;
  sessions: readonly DesktopSessionSummary[];
  activeSession?: {
    sessionId: string;
    busy: boolean;
  };
  /** Includes foreground agent work and managed background jobs. */
  running: boolean;
  runningSessions?: readonly string[];
  unreadCount?: number;
}

export interface DesktopApproval {
  agent: "main" | "subagent";
  tool: string;
  reason?: string;
  paths?: readonly string[];
  command?: string;
  args?: readonly string[];
  cwd?: string;
  allowAlways?: false;
}

export interface DesktopSnapshot {
  workspace?: string;
  /** Every project kept open by the desktop app, in most-recently-opened order. */
  projects?: readonly DesktopProjectSummary[];
  activities?: readonly DesktopActivityItem[];
  recoveryItems?: readonly DesktopRecoveryItem[];
  sessions: readonly DesktopSessionSummary[];
  activeSession?: {
    sessionId: string;
    mainModel: string;
    subagentModel: string;
    permissionMode: PermissionMode;
    busy: boolean;
    queue: { steering: readonly string[]; followUp: readonly string[] };
  };
  approval?: DesktopApproval;
  questions?: readonly Question[];
  memoryReviews?: readonly MemoryReviewItem[];
  /** Seconds an unconfirmed memory review stays visible before auto-dismissal; 0 disables it. */
  memoryAutoDismissSeconds?: number;
  diagnostics: readonly string[];
  models: readonly DesktopModelOption[];
  jobs: readonly JobSnapshot[];
}

export interface DesktopModelMutationResult {
  model: DesktopModelOption;
  snapshot: DesktopSnapshot;
}

export interface SessionStartedPayload {
  sessionId: string;
  restoredTranscript: TranscriptState;
  snapshot: DesktopSnapshot;
}

export interface D2cReportListItem {
  task: string;
  reportId: string;
  createdAt: string;
  total: number;
  grade: string;
  evaluationStatus: D2cReport["evaluation"]["status"];
  verdict: D2cReport["evaluation"]["verdict"];
  issueCount: number;
  batchId?: string;
  page?: D2cReport["page"];
}

/** Result of importing a Pixso export directory through the D2C view. */
export interface D2cImportResult {
  task: string;
  entryHtml: string;
  files: readonly string[];
  pages: readonly { id: string; label: string; html: string }[];
}

/** Report plus screenshots encoded as PNG data URLs for renderer display. */
export interface D2cReportView {
  report: D2cReport;
  /** Requirement deliveries own their API contract; design imports may attach an existing one. */
  deliveryOrigin: "requirement" | "design";
  /** True when the task design was re-imported after this report was created. */
  designOutdated: boolean;
  designPng: string;
  implementationPng: string;
  heatmapPng: string;
  /** Other page reports from the same comparison batch; PNGs load on selection. */
  relatedPages: readonly D2cReportListItem[];
  workflow: D2cWorkflow;
}

export interface D2cIntegrationView {
  workflow: D2cWorkflow;
  document: D2cOpenApiDocument;
  mappings: readonly D2cApiMapping[];
}

export interface D2cIntegrationGenerationResult extends D2cIntegrationView {
  files: readonly string[];
  prompt: string;
}

export interface D2cMockStatus {
  running: boolean;
  url?: string;
  output?: string;
}

export interface D2cPreviewStatus {
  running: boolean;
  url?: string;
  mockUrl?: string;
}

export interface D2cInteractionStatus {
  workflow: D2cWorkflow;
  result?: D2cInteractionRun;
  review?: {
    mode: "autonomous" | "contract" | "contract-fallback";
    model?: string;
    summary?: string;
    warning?: string;
    plannedScenarios: number;
    pageAnalyses?: D2cAutonomousInteractionPlan["pageAnalyses"];
  };
}

export interface D2cProductGenerationResult {
  view: D2cProductPlanView;
  prompt: string;
}

export interface D2cProductDecisionResult {
  view: D2cProductPlanView;
  prompt?: string;
  imported?: D2cImportResult;
}

export interface D2cProductPreviewStatus {
  running: boolean;
  url?: string;
}

export interface D2cQualityJudgeStatus {
  workflow: D2cWorkflow;
  judgment: D2cQualityJudgment;
}

export interface D2cQualityIssueDecisionResult {
  workflow: D2cWorkflow;
  prompt?: string;
}

export interface D2cReportEventPayload {
  task: string;
  reportId: string;
  total: number;
  grade: string;
  pageCount?: number;
}

export type DesktopEvent = (
  | { type: "snapshot"; snapshot: DesktopSnapshot }
  | { type: "session-started"; payload: SessionStartedPayload }
  | { type: "session-output"; sessionId: string; event: SessionOutput }
  | { type: "d2c-progress"; payload: D2cProgressEvent }
  | { type: "d2c-report"; payload: D2cReportEventPayload }
  | { type: "runtime-error"; sessionId?: string; message: string }
) & {
  /** Present for events emitted by a project managed in the desktop app. */
  workspace?: string;
};

export interface FlavorDesktopApi {
  bootstrap(): Promise<DesktopSnapshot>;
  /** App icon as data URL (from assets/icon.png); undefined when the asset is missing. */
  appIcon(): Promise<string | undefined>;
  chooseWorkspace(): Promise<DesktopSnapshot | undefined>;
  openWorkspace(path: string): Promise<DesktopSnapshot>;
  startSession(resumeSession?: string): Promise<SessionStartedPayload>;
  selectSession(sessionId: string): Promise<SessionStartedPayload>;
  deleteSession(sessionId: string): Promise<DesktopSnapshot>;
  updateSession(sessionId: string, changes: { title?: string; pinned?: boolean; archived?: boolean }): Promise<DesktopSnapshot>;
  acknowledgeSession(sessionId?: string): Promise<DesktopSnapshot>;
  updateProject(workspace: string, changes: { label?: string; pinned?: boolean }): Promise<DesktopSnapshot>;
  closeProject(workspace: string, force?: boolean): Promise<DesktopSnapshot>;
  revealProject(workspace: string): Promise<void>;
  copyProjectPath(workspace: string): Promise<void>;
  dismissRecovery(sessionId: string): Promise<DesktopSnapshot>;
  gitStatus(): Promise<DesktopGitStatus>;
  gitDiff(path: string, staged?: boolean): Promise<string>;
  gitStage(path: string): Promise<DesktopGitStatus>;
  gitUnstage(path: string): Promise<DesktopGitStatus>;
  gitDiscard(path: string): Promise<DesktopGitStatus>;
  gitCommit(message: string): Promise<{ result: string; status: DesktopGitStatus }>;
  showAppMenu(menu: "file" | "edit" | "view" | "help", x: number, y: number): Promise<void>;
  submit(
    prompt: string,
    delivery?: DesktopMessageDelivery,
    attachments?: readonly DesktopImageAttachmentInput[],
    permissionProfile?: DesktopPermissionProfile,
  ): Promise<void>;
  finishTask(): Promise<string>;
  interrupt(): Promise<void>;
  resolveApproval(decision: "allow" | "deny" | "always"): Promise<void>;
  answerQuestions(answers: Record<number, string>): Promise<void>;
  resolveMemoryReview(id: string, decision: "accept" | "dismiss"): Promise<void>;
  listFiles(): Promise<readonly string[]>;
  listSkills(): Promise<readonly ManagedSkillSummary[]>;
  getSkill(name: string): Promise<ManagedSkill>;
  createSkill(draft: SkillDraft): Promise<ManagedSkill>;
  updateSkill(originalName: string, draft: SkillDraft): Promise<ManagedSkill>;
  deleteSkill(name: string): Promise<void>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  listMcpServers(): Promise<readonly ManagedMcpServer[]>;
  saveMcpServer(originalName: string | undefined, draft: McpServerDraft): Promise<ManagedMcpServer>;
  deleteMcpServer(name: string): Promise<void>;
  setMcpServerEnabled(name: string, enabled: boolean): Promise<ManagedMcpServer>;
  listMemory(): Promise<MemorySnapshot>;
  createMemory(candidate: MemoryCandidate): Promise<MemoryEntry>;
  updateMemory(id: string, candidate: MemoryCandidate): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<boolean>;
  switchModel(modelId: string): Promise<DesktopSnapshot>;
  addModel(input: AddDesktopModelInput): Promise<DesktopModelMutationResult>;
  listD2cReports(): Promise<readonly D2cReportListItem[]>;
  getD2cReport(task: string, reportId?: string): Promise<D2cReportView>;
  /** Opens a directory picker and imports the chosen Pixso export; undefined when cancelled. */
  importD2cDesign(task: string): Promise<D2cImportResult | undefined>;
  createD2cProduct(input: CreateD2cProductPlanInput): Promise<D2cProductGenerationResult>;
  getD2cProduct(task: string): Promise<D2cProductPlanView | undefined>;
  regenerateD2cPrd(task: string, query: string): Promise<D2cProductGenerationResult>;
  updateD2cPrdSection(task: string, sectionId: string, body: string, expectedHash: string): Promise<D2cProductPlanView>;
  decideD2cProduct(task: string, stage: D2cProductStage, accepted: boolean, feedback?: string): Promise<D2cProductDecisionResult>;
  startD2cProductPreview(task: string): Promise<D2cProductPreviewStatus>;
  stopD2cProductPreview(task: string): Promise<D2cProductPreviewStatus>;
  getD2cProductPreviewStatus(task: string): Promise<D2cProductPreviewStatus>;
  openD2cProductPreview(task: string): Promise<void>;
  updateD2cReview(task: string, reportId: string, fingerprints: readonly string[], decision: "pending" | "accepted" | "needs-fix", instruction?: string): Promise<D2cWorkflow>;
  importD2cOpenApi(task: string): Promise<D2cIntegrationView | undefined>;
  getD2cIntegration(task: string): Promise<D2cIntegrationView | undefined>;
  confirmD2cMapping(task: string, moduleId: string, operationKey: string): Promise<D2cIntegrationView>;
  generateD2cIntegration(task: string): Promise<D2cIntegrationGenerationResult>;
  startD2cMock(task: string): Promise<D2cMockStatus>;
  stopD2cMock(task: string): Promise<D2cMockStatus>;
  getD2cMockStatus(task: string): Promise<D2cMockStatus>;
  startD2cPreview(task: string): Promise<D2cPreviewStatus>;
  stopD2cPreview(task: string): Promise<D2cPreviewStatus>;
  getD2cPreviewStatus(task: string): Promise<D2cPreviewStatus>;
  openD2cPreview(task: string): Promise<void>;
  runD2cInteractionTests(task: string): Promise<D2cInteractionStatus>;
  setD2cManualAcceptance(task: string, accepted: boolean): Promise<D2cWorkflow>;
  getD2cJudgeConfig(): Promise<D2cJudgeConfigView>;
  saveD2cJudgeConfig(input: D2cJudgeConfig): Promise<D2cJudgeConfigView>;
  runD2cQualityJudge(task: string): Promise<D2cQualityJudgeStatus>;
  resolveD2cQualityIssue(task: string, issueId: string, decision: "skipped" | "fixing"): Promise<D2cQualityIssueDecisionResult>;
  /** Read-only snapshot of the E2E delivery state machine; undefined when the task never started a delivery. */
  getE2eDeliveryRun(task: string): Promise<E2eDeliveryRun | undefined>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

// Keep this reference so contract changes remain coupled to the runtime event union at compile time.
export type DesktopAgentEvent = AgentEvent;
