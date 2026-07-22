import { z } from "zod";

import type { AgentEvent } from "../agent/types.js";
import type { PermissionMode } from "../config/schema.js";
import type { TranscriptState } from "../ui/transcript.js";
import type { Question } from "../tools/ask-user-question.js";
import type { SessionOutput } from "../ui/session.js";
import type { ManagedSkill, ManagedSkillSummary, SkillDraft } from "../skills/manager.js";
export { DESKTOP_CHANNELS } from "./channels.js";

export const OpenWorkspaceInputSchema = z.object({ path: z.string().trim().min(1).max(32_768) }).strict();
export const StartSessionInputSchema = z.object({
  resumeSession: z.string().trim().min(1).max(128).optional(),
}).strict();
export const DeleteSessionInputSchema = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, "Invalid session id"),
}).strict();
export const AppMenuInputSchema = z.object({
  menu: z.enum(["file", "edit", "view", "help"]),
  x: z.number().int().min(0).max(32_768),
  y: z.number().int().min(0).max(32_768),
}).strict();
export const SubmitInputSchema = z.object({ prompt: z.string().trim().min(1).max(1_000_000) }).strict();
export const ResolveApprovalInputSchema = z.object({ decision: z.enum(["allow", "deny", "always"]) }).strict();
export const AnswerQuestionsInputSchema = z.object({
  answers: z.record(z.coerce.number().int().min(0).max(3), z.string().min(1).max(10_000)),
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

export interface DesktopSessionSummary {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  mainModel: string;
  preview?: string;
}

export interface DesktopApproval {
  agent: "main" | "subagent";
  tool: string;
  reason?: string;
  paths?: readonly string[];
  command?: string;
  args?: readonly string[];
  cwd?: string;
}

export interface DesktopSnapshot {
  workspace?: string;
  sessions: readonly DesktopSessionSummary[];
  activeSession?: {
    sessionId: string;
    mainModel: string;
    subagentModel: string;
    permissionMode: PermissionMode;
    busy: boolean;
  };
  approval?: DesktopApproval;
  questions?: readonly Question[];
  diagnostics: readonly string[];
}

export interface SessionStartedPayload {
  sessionId: string;
  restoredTranscript: TranscriptState;
  snapshot: DesktopSnapshot;
}

export type DesktopEvent =
  | { type: "snapshot"; snapshot: DesktopSnapshot }
  | { type: "session-started"; payload: SessionStartedPayload }
  | { type: "session-output"; event: SessionOutput }
  | { type: "runtime-error"; message: string };

export interface FlavorDesktopApi {
  bootstrap(): Promise<DesktopSnapshot>;
  chooseWorkspace(): Promise<DesktopSnapshot | undefined>;
  openWorkspace(path: string): Promise<DesktopSnapshot>;
  startSession(resumeSession?: string): Promise<SessionStartedPayload>;
  deleteSession(sessionId: string): Promise<DesktopSnapshot>;
  showAppMenu(menu: "file" | "edit" | "view" | "help", x: number, y: number): Promise<void>;
  submit(prompt: string): Promise<void>;
  interrupt(): Promise<void>;
  resolveApproval(decision: "allow" | "deny" | "always"): Promise<void>;
  answerQuestions(answers: Record<number, string>): Promise<void>;
  listFiles(): Promise<readonly string[]>;
  listSkills(): Promise<readonly ManagedSkillSummary[]>;
  getSkill(name: string): Promise<ManagedSkill>;
  createSkill(draft: SkillDraft): Promise<ManagedSkill>;
  updateSkill(originalName: string, draft: SkillDraft): Promise<ManagedSkill>;
  deleteSkill(name: string): Promise<void>;
  setSkillEnabled(name: string, enabled: boolean): Promise<void>;
  onEvent(listener: (event: DesktopEvent) => void): () => void;
}

// Keep this reference so contract changes remain coupled to the runtime event union at compile time.
export type DesktopAgentEvent = AgentEvent;
