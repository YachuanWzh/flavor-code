import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

import type { PermissionMode } from "../config/schema.js";
import { assertPngDimensions } from "../d2c/pixel.js";
import { importDesign, listReports, listTasks, readManifest, readReport, taskDir } from "../d2c/store.js";
import { applyInteractionRun, applyManualInteractionDecision, applyQualityJudgment, applyReviewDecision, createWorkflow, readWorkflow, reconcileWorkflow, reviewProgress, writeWorkflow, type D2cWorkflow } from "../d2c/workflow.js";
import { parseInteractionManifest, type D2cInteractionManifest, type D2cInteractionRun } from "../d2c/interaction.js";
import { runFrontendProject, type RunningProject } from "../d2c/runner.js";
import { confirmApiMapping, matchModulesToOperations, parseOpenApiDocument, type D2cApiMapping, type D2cOpenApiDocument } from "../d2c/openapi.js";
import { d2cOutputDirectory, readD2cModules } from "../d2c/modules.js";
import { generateIntegrationArtifacts } from "../d2c/integration.js";
import { runD2cMockServer, type D2cRunningMock } from "../d2c/mock-runner.js";
import type { D2cJudgeConfig, D2cJudgeConfigView, D2cQualityJudgment } from "../d2c/judge.js";
import type { D2cReport } from "../d2c/types.js";
import { createProductionRuntime, type ProductionRuntimeOptions } from "../production.js";
import { SessionStore } from "../session/store.js";
import {
  SessionAssetStore,
  type ImageAttachmentInput,
} from "../session/assets.js";
import type { Question } from "../tools/ask-user-question.js";
import type { MultimodalSessionInput, SessionOutput } from "../ui/session.js";
import type { TranscriptState } from "../ui/transcript.js";
import { message } from "../utils/error.js";
import { modelContentText } from "../models/types.js";
import type { ApprovalDecision } from "../tools/runtime.js";
import type { PermissionProfile } from "../permissions/engine.js";
import { createGlobTool, type SearchResult } from "../tools/search.js";
import { SkillManager, type ManagedSkill, type ManagedSkillSummary, type SkillDraft } from "../skills/manager.js";
import { createProjectMemoryManager, type MemoryManagerLike, type MemorySnapshot } from "../memory/manager.js";
import type { MemoryCandidate, MemoryEntry } from "../memory/types.js";
import type { MemoryReviewItem } from "../memory/review.js";
import { ProjectMcpConfigManager, type ManagedMcpServer, type ProjectMcpConfigManagerLike } from "../mcp/config-manager.js";
import { DEFAULT_DESKTOP_MODELS, loadDesktopModels, saveDesktopModel } from "./model-config.js";
import type { AddDesktopModelInput, D2cImportResult, D2cIntegrationGenerationResult, D2cIntegrationView, D2cInteractionStatus, D2cMockStatus, D2cPreviewStatus, D2cQualityJudgeStatus, D2cReportListItem, D2cReportView, DesktopEvent, DesktopMessageDelivery, DesktopModelOption, DesktopModelMutationResult, DesktopPermissionProfile, DesktopSessionSummary, DesktopSnapshot, McpServerDraft, SessionStartedPayload } from "./contracts.js";

function pngDataUrl(png: Uint8Array): string {
  const buffer = Buffer.from(png);
  assertPngDimensions(buffer);
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function detectD2cFramework(workspace: string, task: string): Promise<"vue" | "react"> {
  try {
    const pkg = JSON.parse(await readFile(join(d2cOutputDirectory(workspace, task), "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    return pkg.dependencies?.react === undefined ? "vue" : "react";
  } catch { return "vue"; }
}

function integrationDirectory(workspace: string, task: string): string {
  return join(workspace, ".flavor", "d2c", task, "integration");
}

export interface RuntimeLike {
  readonly sessionId: string;
  readonly restoredTranscript: TranscriptState;
  readonly diagnostics: readonly string[];
  readonly session: {
    readonly active: boolean;
    start(): Promise<void>;
    submit(prompt: string): Promise<void>;
    steer(prompt: string): void;
    followUp(prompt: string): void;
    queueSnapshot(): { steering: readonly string[]; followUp: readonly string[] };
    interrupt(): "cancelled" | "exit";
    close(): Promise<void>;
  };
  readonly services: {
    mainModel(): string;
    subagentModel(): string;
    permissionMode(): PermissionMode;
    setModel(role: "main" | "subagent", modelId: string): void | Promise<void>;
    finishTask(): Promise<string>;
    refreshMemory?(): Promise<void>;
    reloadSkills?(): Promise<void>;
    questions: { readonly pending: readonly Question[] | undefined; answer(answers: Record<number, string>): void };
  };
  readonly approvals: {
    readonly pending: DesktopSnapshot["approval"];
    resolve(decision: ApprovalDecision): void;
  };
  readonly authorization: {
    permissionProfile(): PermissionProfile;
    setPermissionProfile(profile: PermissionProfile): void;
  };
  readonly memoryReviews: {
    readonly pending: readonly MemoryReviewItem[];
    readonly autoDismissSeconds: number;
    accept(id: string): Promise<boolean>;
    dismiss(id: string): boolean;
  };
  dispose(): Promise<void>;
}

export interface RuntimeFactoryOptions extends Pick<ProductionRuntimeOptions,
  "workspace" | "home" | "output" | "onApprovalChange" | "approvalPolicy" | "resumeSession" | "extraTools"> {}

export interface D2cJudgeService {
  config(): Promise<D2cJudgeConfigView>;
  saveConfig(input: D2cJudgeConfig): Promise<D2cJudgeConfigView>;
  evaluate(input: {
    report: D2cReport;
    interaction: D2cInteractionRun;
    designPng: Buffer;
    implementationPng: Buffer;
  }): Promise<D2cQualityJudgment>;
}

export interface DesktopRuntimeControllerOptions {
  home?: string;
  createRuntime?(options: RuntimeFactoryOptions): Promise<RuntimeLike>;
  listSessions?(workspace: string): Promise<readonly DesktopSessionSummary[]>;
  deleteSession?(workspace: string, sessionId: string): Promise<void>;
  loadModels?(workspace: string, home: string): Promise<DesktopModelOption[]>;
  saveModel?(workspace: string, home: string, input: AddDesktopModelInput): Promise<DesktopModelOption>;
  loadMemoryManager?(workspace: string, home: string): Promise<MemoryManagerLike>;
  loadMcpManager?(workspace: string): ProjectMcpConfigManagerLike;
  storeAttachments?(
    workspace: string,
    sessionId: string,
    attachments: readonly ImageAttachmentInput[],
  ): Promise<MultimodalSessionInput["content"]>;
  runD2cPreview?(projectDir: string, options: { workspace: string }): Promise<RunningProject>;
  runD2cMockServer?(projectDir: string): Promise<D2cRunningMock>;
  runD2cInteractionTests?(manifest: D2cInteractionManifest, baseUrl: string, mockUrl: string): Promise<D2cInteractionRun>;
  captureD2cPreview?(url: string): Promise<Buffer>;
  d2cJudge?: D2cJudgeService;
  /** Checks whether the managed Express mock still answers; defaults to a /_d2c/health probe. */
  probeD2cMock?(mockUrl: string): Promise<boolean>;
  emit(event: DesktopEvent): void;
}

export class DesktopRuntimeController {
  readonly #home: string;
  readonly #createRuntime: NonNullable<DesktopRuntimeControllerOptions["createRuntime"]>;
  readonly #listSessions: NonNullable<DesktopRuntimeControllerOptions["listSessions"]>;
  readonly #deleteStoredSession: NonNullable<DesktopRuntimeControllerOptions["deleteSession"]>;
  readonly #loadModels: NonNullable<DesktopRuntimeControllerOptions["loadModels"]>;
  readonly #saveModel: NonNullable<DesktopRuntimeControllerOptions["saveModel"]>;
  readonly #loadMemoryManager: NonNullable<DesktopRuntimeControllerOptions["loadMemoryManager"]>;
  readonly #loadMcpManager: NonNullable<DesktopRuntimeControllerOptions["loadMcpManager"]>;
  readonly #storeAttachments: NonNullable<DesktopRuntimeControllerOptions["storeAttachments"]>;
  readonly #runD2cPreview: NonNullable<DesktopRuntimeControllerOptions["runD2cPreview"]>;
  readonly #runD2cMockServer: NonNullable<DesktopRuntimeControllerOptions["runD2cMockServer"]>;
  readonly #probeD2cMock: NonNullable<DesktopRuntimeControllerOptions["probeD2cMock"]>;
  readonly #executeD2cInteractionTests: DesktopRuntimeControllerOptions["runD2cInteractionTests"];
  readonly #captureD2cPreview: DesktopRuntimeControllerOptions["captureD2cPreview"];
  readonly #d2cJudge: DesktopRuntimeControllerOptions["d2cJudge"];
  readonly #emit: (event: DesktopEvent) => void;
  #workspace: string | undefined;
  #sessions: readonly DesktopSessionSummary[] = [];
  #runtime: RuntimeLike | undefined;
  #skillManager: SkillManager | undefined;
  #memoryManager: MemoryManagerLike | undefined;
  #mcpManager: ProjectMcpConfigManagerLike | undefined;
  #models: readonly DesktopModelOption[] = DEFAULT_DESKTOP_MODELS;
  #busy = false;
  readonly #d2cMocks = new Map<string, D2cRunningMock>();
  readonly #d2cPreviews = new Map<string, RunningProject>();
  /** Mock URL each preview observed at startup; Vite only reads .env.local on boot. */
  readonly #d2cPreviewMockUrls = new Map<string, string>();

  constructor(options: DesktopRuntimeControllerOptions) {
    this.#home = resolve(options.home ?? homedir());
    this.#createRuntime = options.createRuntime ?? (async (runtimeOptions) => createProductionRuntime(runtimeOptions));
    this.#listSessions = options.listSessions ?? (async (workspace) => {
      const store = new SessionStore({ workspace });
      const entries = await store.list();
      return Promise.all(entries.map(async (entry) => {
        try {
          const document = await store.load(entry.sessionId);
          const firstUser = document.conversation.messages.find((item) => item.role === "user");
          const preview = (firstUser === undefined ? undefined : modelContentText(firstUser.content).trim())
            ?? document.timeline.state.completed.find((turn) => turn.kind !== "compaction")?.prompt.trim()
            ?? document.timeline.state.active?.prompt.trim();
          return { ...entry, ...(preview ? { preview } : {}) };
        } catch { return entry; }
      }));
    });
    this.#deleteStoredSession = options.deleteSession ?? (async (workspace, sessionId) => {
      await new SessionStore({ workspace }).delete(sessionId);
    });
    this.#loadModels = options.loadModels ?? loadDesktopModels;
    this.#saveModel = options.saveModel ?? saveDesktopModel;
    this.#loadMemoryManager = options.loadMemoryManager
      ?? ((workspace, home) => createProjectMemoryManager({ workspace, home }));
    this.#loadMcpManager = options.loadMcpManager ?? ((workspace) => new ProjectMcpConfigManager(workspace));
    this.#storeAttachments = options.storeAttachments
      ?? ((workspace, sessionId, attachments) =>
        new SessionAssetStore({ workspace }).store(sessionId, attachments));
    this.#runD2cPreview = options.runD2cPreview ?? runFrontendProject;
    this.#runD2cMockServer = options.runD2cMockServer ?? runD2cMockServer;
    this.#probeD2cMock = options.probeD2cMock ?? (async (mockUrl) => {
      try {
        const response = await fetch(`${mockUrl}/_d2c/health`, { signal: AbortSignal.timeout(3_000) });
        return response.ok;
      } catch { return false; }
    });
    this.#executeD2cInteractionTests = options.runD2cInteractionTests;
    this.#captureD2cPreview = options.captureD2cPreview;
    this.#d2cJudge = options.d2cJudge;
    this.#emit = options.emit;
  }

  snapshot(): DesktopSnapshot {
    const runtime = this.#runtime;
    return {
      ...(this.#workspace === undefined ? {} : { workspace: this.#workspace }),
      sessions: this.#sessions,
      ...(runtime === undefined ? {} : {
        activeSession: {
          sessionId: runtime.sessionId,
          mainModel: runtime.services.mainModel(),
          subagentModel: runtime.services.subagentModel(),
          permissionMode: runtime.services.permissionMode(),
          busy: this.#busy,
          queue: runtime.session.queueSnapshot(),
        },
        ...(runtime.approvals.pending === undefined ? {} : { approval: runtime.approvals.pending }),
        ...(runtime.services.questions.pending === undefined ? {} : { questions: runtime.services.questions.pending }),
        ...(runtime.memoryReviews.pending.length === 0 ? {} : { memoryReviews: runtime.memoryReviews.pending }),
        ...((runtime.memoryReviews.autoDismissSeconds ?? 0) > 0 ? { memoryAutoDismissSeconds: runtime.memoryReviews.autoDismissSeconds } : {}),
      }),
      diagnostics: runtime?.diagnostics ?? [],
      models: this.#models,
    };
  }

  async openWorkspace(path: string): Promise<DesktopSnapshot> {
    const workspace = resolve(path);
    if (workspace !== this.#workspace) {
      await this.#disposeRuntime();
      await this.#stopAllD2cPreviews();
      await this.#stopAllD2cMocks();
    }
    this.#workspace = workspace;
    this.#skillManager = new SkillManager({ workspace, home: this.#home });
    this.#memoryManager = await this.#loadMemoryManager(workspace, this.#home);
    this.#mcpManager = this.#loadMcpManager(workspace);
    this.#models = await this.#loadModels(workspace, this.#home);
    this.#sessions = await this.#listSessions(workspace);
    return this.#publishSnapshot();
  }

  async refreshSessions(): Promise<DesktopSnapshot> {
    if (this.#workspace !== undefined) {
      this.#sessions = this.#withActiveSession(await this.#listSessions(this.#workspace));
    }
    return this.#publishSnapshot();
  }

  async startSession(resumeSession?: string): Promise<SessionStartedPayload> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before starting a session");
    await this.#disposeRuntime();
    const bufferedOutput: SessionOutput[] = [];
    let outputSessionId: string | undefined;
    let outputReady = false;
    const runtime = await this.#createRuntime({
      workspace,
      home: this.#home,
      approvalPolicy: "prompt",
      ...(resumeSession === undefined ? {} : { resumeSession }),
      output: (event) => {
        if (!outputReady || outputSessionId === undefined) {
          bufferedOutput.push(event);
          return;
        }
        this.#emit({ type: "session-output", sessionId: outputSessionId, event });
      },
      onApprovalChange: () => {
        if (this.#runtime !== undefined) this.#publishSnapshot();
      },
    });
    outputSessionId = runtime.sessionId;
    this.#runtime = runtime;
    await runtime.session.start();
    if (!this.#sessions.some((session) => session.sessionId === runtime.sessionId)) {
      const now = new Date().toISOString();
      this.#sessions = [{
        sessionId: runtime.sessionId,
        createdAt: now,
        updatedAt: now,
        mainModel: runtime.services.mainModel(),
      }, ...this.#sessions];
    }
    const payload = { sessionId: runtime.sessionId, restoredTranscript: runtime.restoredTranscript, snapshot: this.snapshot() };
    this.#emit({ type: "session-started", payload });
    outputReady = true;
    for (const event of bufferedOutput) {
      this.#emit({ type: "session-output", sessionId: runtime.sessionId, event });
    }
    this.#publishSnapshot();
    return payload;
  }

  async deleteSession(sessionId: string): Promise<DesktopSnapshot> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before deleting a session");
    if (this.#runtime?.sessionId === sessionId) {
      if (this.#busy) throw new Error("Stop the active task before deleting this session");
      await this.#disposeRuntime();
    }
    await this.#deleteStoredSession(workspace, sessionId);
    this.#sessions = await this.#listSessions(workspace);
    return this.#publishSnapshot();
  }

  async submit(
    prompt: string,
    delivery: DesktopMessageDelivery = "prompt",
    attachments: readonly ImageAttachmentInput[] = [],
    permissionProfile?: DesktopPermissionProfile,
  ): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new Error("Start a session before sending a message");
    if (attachments.length > 0 && delivery !== "prompt") {
      throw new Error("Images are only supported on new prompts");
    }
    if (permissionProfile !== undefined && (delivery !== "prompt" || this.#busy)) {
      throw new Error("D2C permission profile requires a new idle prompt");
    }
    if (delivery === "followUp") {
      runtime.session.followUp(prompt);
      this.#publishSnapshot();
      return;
    }
    if (delivery === "steer" || this.#busy) {
      runtime.session.steer(prompt);
      this.#publishSnapshot();
      return;
    }
    const preview = prompt.trim();
    const now = new Date().toISOString();
    this.#sessions = this.#sessions.map((session) => session.sessionId !== runtime.sessionId ? session : {
      ...session,
      updatedAt: now,
      ...(session.preview !== undefined || preview.length === 0 ? {} : { preview }),
    });
    const previousPermissionProfile = runtime.authorization.permissionProfile();
    if (permissionProfile !== undefined) runtime.authorization.setPermissionProfile(permissionProfile);
    this.#busy = true;
    this.#publishSnapshot();
    try {
      if (attachments.length === 0) {
        await runtime.session.submit(prompt);
      } else {
        const workspace = this.#workspace;
        if (workspace === undefined) throw new Error("Open a project before sending images");
        const content = await this.#storeAttachments(workspace, runtime.sessionId, attachments);
        const submitMultimodal = runtime.session.submit as unknown as
          (input: MultimodalSessionInput) => Promise<void>;
        await submitMultimodal.call(runtime.session, { text: prompt, content });
      }
    } catch (error) {
      if (this.#runtime === runtime) {
        this.#emit({ type: "runtime-error", sessionId: runtime.sessionId, message: message(error) });
      }
      throw error;
    } finally {
      if (permissionProfile !== undefined) runtime.authorization.setPermissionProfile(previousPermissionProfile);
      if (this.#runtime === runtime) {
        this.#busy = false;
        const sessions = this.#workspace === undefined
          ? this.#sessions
          : await this.#listSessions(this.#workspace).catch(() => this.#sessions);
        if (this.#runtime === runtime) {
          this.#sessions = this.#withActiveSession(sessions);
          this.#publishSnapshot();
        }
      }
    }
  }

  async listWorkspaceFiles(): Promise<readonly string[]> {
    const workspace = this.#workspace;
    if (workspace === undefined) return [];
    try {
      const controller = new AbortController();
      const glob = createGlobTool(workspace, { defaultLimit: 10_000 });
      const result = await glob.execute({ pattern: "**", limit: 10_000 }, controller.signal) as SearchResult<string>;
      return result.matches.map((path) => path.replaceAll("\\", "/"));
    } catch {
      return [];
    }
  }

  async finishTask(): Promise<string> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new Error("Start a session before finishing a task");
    if (this.#busy) throw new Error("Wait for the active task before finishing it");
    this.#busy = true;
    this.#publishSnapshot();
    try {
      const result = await runtime.services.finishTask();
      this.#emit({
        type: "session-output",
        sessionId: runtime.sessionId,
        event: { type: "notice", message: result },
      });
      return result;
    } catch (error) {
      if (this.#runtime === runtime) {
        this.#emit({ type: "runtime-error", sessionId: runtime.sessionId, message: message(error) });
      }
      throw error;
    } finally {
      if (this.#runtime === runtime) {
        this.#busy = false;
        const sessions = this.#workspace === undefined
          ? this.#sessions
          : await this.#listSessions(this.#workspace).catch(() => this.#sessions);
        if (this.#runtime === runtime) {
          this.#sessions = this.#withActiveSession(sessions);
          this.#publishSnapshot();
        }
      }
    }
  }

  async listSkills(): Promise<readonly ManagedSkillSummary[]> {
    return this.#requireSkillManager().list();
  }

  async getSkill(name: string): Promise<ManagedSkill> {
    return this.#requireSkillManager().get(name);
  }

  async createSkill(draft: SkillDraft): Promise<ManagedSkill> {
    const result = await this.#requireSkillManager().create(draft);
    await this.#runtime?.services.reloadSkills?.();
    return result;
  }

  async updateSkill(name: string, draft: SkillDraft): Promise<ManagedSkill> {
    const result = await this.#requireSkillManager().update(name, draft);
    await this.#runtime?.services.reloadSkills?.();
    return result;
  }

  async deleteSkill(name: string): Promise<void> {
    await this.#requireSkillManager().delete(name);
    await this.#runtime?.services.reloadSkills?.();
  }

  async setSkillEnabled(name: string, enabled: boolean): Promise<void> {
    await this.#requireSkillManager().setEnabled(name, enabled);
    await this.#runtime?.services.reloadSkills?.();
  }

  async listMcpServers(): Promise<readonly ManagedMcpServer[]> {
    return this.#requireMcpManager().list();
  }

  async saveMcpServer(originalName: string | undefined, draft: McpServerDraft): Promise<ManagedMcpServer> {
    const manager = this.#requireMcpManager();
    return originalName === undefined
      ? manager.create(draft.name, draft.config)
      : manager.update(originalName, draft.name, draft.config);
  }

  async deleteMcpServer(name: string): Promise<void> {
    await this.#requireMcpManager().delete(name);
  }

  async setMcpServerEnabled(name: string, enabled: boolean): Promise<ManagedMcpServer> {
    return this.#requireMcpManager().setEnabled(name, enabled);
  }

  async listMemory(): Promise<MemorySnapshot> {
    return this.#requireMemoryManager().snapshot();
  }

  async createMemory(candidate: MemoryCandidate): Promise<MemoryEntry> {
    const entry = await this.#requireMemoryManager().remember(candidate);
    await this.#runtime?.services.refreshMemory?.();
    return entry;
  }

  async updateMemory(id: string, candidate: MemoryCandidate): Promise<MemoryEntry> {
    const entry = await this.#requireMemoryManager().update(id, candidate);
    await this.#runtime?.services.refreshMemory?.();
    return entry;
  }

  async deleteMemory(id: string): Promise<boolean> {
    const deleted = await this.#requireMemoryManager().delete(id);
    if (deleted) await this.#runtime?.services.refreshMemory?.();
    return deleted;
  }

  async switchModel(modelId: string): Promise<DesktopSnapshot> {
    if (this.#busy) throw new Error("Stop the active task before switching models");
    if (!this.#models.some((model) => model.id === modelId)) {
      throw new Error(`Model is not configured for Electron: ${modelId}`);
    }
    if (this.#runtime === undefined) await this.startSession();
    await this.#runtime!.services.setModel("main", modelId);
    return this.#publishSnapshot();
  }

  async addModel(input: AddDesktopModelInput): Promise<DesktopModelMutationResult> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before adding a model");
    if (this.#busy) throw new Error("Stop the active task before adding a model");
    const model = await this.#saveModel(workspace, this.#home, input);
    await this.#disposeRuntime();
    this.#models = await this.#loadModels(workspace, this.#home);
    if (!this.#models.some((item) => item.id === model.id)) this.#models = [...this.#models, model];
    const snapshot = await this.switchModel(model.id);
    return { model, snapshot };
  }

  async interrupt(): Promise<void> {
    this.#runtime?.session.interrupt();
  }

  /** Imports a Pixso export directory chosen by the user; same path as the D2cImport tool. */
  async importD2cDesign(task: string, exportDir: string): Promise<D2cImportResult> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before importing a D2C design");
    const manifest = await importDesign(workspace, task, exportDir);
    return { task, entryHtml: manifest.entryHtml, files: manifest.files, pages: manifest.pages };
  }

  /** Lists stored D2C comparison reports across all tasks, newest first. */
  async listD2cReports(): Promise<readonly D2cReportListItem[]> {
    const workspace = this.#workspace;
    if (workspace === undefined) return [];
    const items: D2cReportListItem[] = [];
    for (const task of await listTasks(workspace)) {
      for (const report of await listReports(workspace, task)) {
        items.push({ task, ...report });
      }
    }
    return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.reportId.localeCompare(a.reportId));
  }

  async getD2cReport(task: string, reportId?: string): Promise<D2cReportView> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before viewing D2C reports");
    const bundle = await readReport(workspace, task, reportId);
    const currentManifest = await readManifest(workspace, task);
    const relatedPages = bundle.report.batchId === undefined ? [] : (await listReports(workspace, task))
      .filter((item) => item.batchId === bundle.report.batchId)
      .map((item) => ({ task, ...item }));
    let workflow = await readWorkflow(workspace, task);
    if (workflow === undefined) workflow = createWorkflow(bundle.report, await detectD2cFramework(workspace, task));
    else if (workflow.activeReportId !== bundle.report.reportId) workflow = reconcileWorkflow(workflow, bundle.report);
    if (relatedPages.length > 1) {
      for (const page of relatedPages) {
        if (page.reportId === bundle.report.reportId) continue;
        workflow = reconcileWorkflow(workflow, (await readReport(workspace, task, page.reportId)).report);
      }
      workflow = reconcileWorkflow(workflow, bundle.report);
    }
    workflow = await writeWorkflow(workspace, workflow);
    return {
      report: bundle.report,
      designOutdated: bundle.report.design.designHash !== undefined
        && bundle.report.design.designHash !== currentManifest.designHash,
      designPng: pngDataUrl(bundle.designPng),
      implementationPng: pngDataUrl(bundle.implementationPng),
      heatmapPng: pngDataUrl(bundle.heatmapPng),
      relatedPages,
      workflow,
    };
  }

  async updateD2cReview(
    task: string,
    reportId: string,
    fingerprints: readonly string[],
    decision: "pending" | "accepted" | "needs-fix",
    instruction?: string,
  ): Promise<D2cWorkflow> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before reviewing D2C issues");
    const report = (await readReport(workspace, task, reportId)).report;
    let workflow = await readWorkflow(workspace, task);
    if (workflow === undefined) workflow = createWorkflow(report, await detectD2cFramework(workspace, task));
    if (workflow.activeReportId !== reportId) workflow = reconcileWorkflow(workflow, report);
    return writeWorkflow(workspace, applyReviewDecision(workflow, { fingerprints, decision, ...(instruction === undefined ? {} : { instruction }) }, report));
  }

  async importD2cOpenApi(task: string, sourcePath: string): Promise<D2cIntegrationView> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before importing OpenAPI");
    const workflow = await readWorkflow(workspace, task);
    if (workflow === undefined || !reviewProgress(workflow).complete || workflow.stage === "visual-review") {
      throw new Error("Complete visual review before importing OpenAPI");
    }
    const moduleManifest = join(d2cOutputDirectory(workspace, task), "d2c.modules.json");
    const moduleManifestInfo = await stat(moduleManifest).catch(() => undefined);
    if (moduleManifestInfo === undefined || !moduleManifestInfo.isFile()) {
      throw new Error("D2C implementation must write d2c.modules.json before API mapping; ask the agent to split the project into modules first");
    }
    const info = await stat(sourcePath);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) throw new Error("OpenAPI JSON must be a file no larger than 8 MiB");
    const raw = await readFile(sourcePath, "utf8");
    const document = parseOpenApiDocument(raw);
    const modules = await readD2cModules(workspace, task);
    const mappings = matchModulesToOperations(modules, document.operations);
    const dir = integrationDirectory(workspace, task);
    await mkdir(dir, { recursive: true });
    const hash = createHash("sha256").update(raw).digest("hex");
    await Promise.all([
      writeFile(join(dir, "swagger.json"), raw),
      writeFile(join(dir, "openapi.normalized.json"), `${JSON.stringify(document, null, 2)}\n`),
    ]);
    const next: D2cWorkflow = {
      ...workflow, revision: workflow.revision + 1, stage: "api-mapping", mappings,
      openapi: { sourceName: basename(sourcePath), importedAt: new Date().toISOString(), hash,
        version: document.version, title: document.title, ...(document.baseUrl === undefined ? {} : { baseUrl: document.baseUrl }) },
      updatedAt: new Date().toISOString(),
    };
    return { workflow: await writeWorkflow(workspace, next), document, mappings };
  }

  async getD2cIntegration(task: string): Promise<D2cIntegrationView | undefined> {
    const workspace = this.#workspace;
    if (workspace === undefined) return undefined;
    const workflow = await readWorkflow(workspace, task);
    if (workflow?.openapi === undefined || workflow.mappings === undefined) return undefined;
    const document = JSON.parse(await readFile(join(integrationDirectory(workspace, task), "openapi.normalized.json"), "utf8")) as D2cOpenApiDocument;
    return { workflow, document, mappings: workflow.mappings as D2cApiMapping[] };
  }

  async confirmD2cMapping(task: string, moduleId: string, operationKey: string): Promise<D2cIntegrationView> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before confirming API mappings");
    const view = await this.getD2cIntegration(task);
    if (view === undefined) throw new Error("Import OpenAPI before confirming mappings");
    if (!view.mappings.some((item) => item.moduleId === moduleId)) throw new Error(`Unknown D2C module: ${moduleId}`);
    const mappings = view.mappings.map((item) => item.moduleId === moduleId ? confirmApiMapping(item, operationKey, view.document.operations) : item);
    const workflow = await writeWorkflow(workspace, { ...view.workflow, revision: view.workflow.revision + 1, mappings, updatedAt: new Date().toISOString() });
    return { workflow, document: view.document, mappings };
  }

  async generateD2cIntegration(task: string): Promise<D2cIntegrationGenerationResult> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before generating integration code");
    const view = await this.getD2cIntegration(task);
    if (view === undefined) throw new Error("Import OpenAPI before generating integration code");
    const project = d2cOutputDirectory(workspace, task);
    const generated = await generateIntegrationArtifacts(project, view.document, view.mappings);
    const now = new Date().toISOString();
    const { quality: _quality, ...workflowBase } = view.workflow;
    const workflow = await writeWorkflow(workspace, { ...workflowBase, revision: view.workflow.revision + 1,
      stage: "integrating", integrationFiles: generated.files,
      interaction: { manualDecision: "pending", updatedAt: now }, updatedAt: now });
    const prompt = [
      `继续 D2C 任务“${task}”的接口联调。视觉审阅已全部通过。`,
      `OpenAPI 绑定计划位于 src/d2c-output/${task}/src/api/d2c-bindings.json，Axios client 已生成。`,
      ...view.mappings.map((mapping) => `- 模块 ${mapping.moduleId} → ${mapping.operationId}（${mapping.operationKey}）`),
      `只在 src/d2c-output/${task}/ 内完成模块数据加载、表单提交和响应 ViewModel 适配；统一使用 src/api/http.js，不得直接散落 axios 调用。`,
      "先使用 npm run mock 对接生成的 Express mock，运行构建和可用的测试；遇到不确定字段映射时使用 AskUserQuestion，不得猜测。完成后汇报实际调用、构建与测试结果。",
      "Acceptance requirements: keep the Vite page runnable and interactive; every data-bearing module must use the generated Axios client for initial loading and user actions.",
      "Implement loading, empty, success, validation and API-error states without replacing server behavior with local-only fixtures or decorative toasts.",
      "Use design/interaction-manifest.json as the executable behavior contract when it exists. Preserve its selectors, exercise every scenario, and ensure required scenarios produce observable XHR/fetch traffic.",
      "Do not start or stop long-running dev servers yourself; Flavor Code owns the preview and Express mock lifecycles and Vite hot reload will pick up source changes.",
      "Run the project build and available unit tests before reporting completion. Only edit within the generated D2C project.",
    ].join("\n");
    return { workflow, document: view.document, mappings: view.mappings, files: generated.files, prompt };
  }

  async startD2cMock(task: string): Promise<D2cMockStatus> {
    const existing = this.#d2cMocks.get(task);
    if (existing !== undefined) return { running: true, url: existing.url, output: existing.output() };
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before starting a D2C mock server");
    const project = d2cOutputDirectory(workspace, task);
    const running = await this.#runD2cMockServer(project);
    this.#d2cMocks.set(task, running);
    try {
      const environmentPath = join(project, ".env.local");
      const existingEnvironment = await readFile(environmentPath, "utf8").catch(() => "");
      const environment = `${existingEnvironment.split(/\r?\n/).filter((line) => !/^\s*VITE_API_BASE_URL\s*=/.test(line)).join("\n").trim()}\nVITE_API_BASE_URL=${running.url}\n`.replace(/^\n/, "");
      await writeFile(environmentPath, environment);
      return { running: true, url: running.url, output: running.output() };
    } catch (error) {
      this.#d2cMocks.delete(task);
      await running.stop();
      throw error;
    }
  }

  async stopD2cMock(task: string): Promise<D2cMockStatus> {
    if (this.#d2cPreviews.has(task)) throw new Error("Stop the D2C preview before stopping its mock server");
    const running = this.#d2cMocks.get(task);
    if (running !== undefined) { this.#d2cMocks.delete(task); await running.stop(); }
    return { running: false };
  }

  getD2cMockStatus(task: string): D2cMockStatus {
    const running = this.#d2cMocks.get(task);
    return running === undefined ? { running: false } : { running: true, url: running.url, output: running.output() };
  }

  async startD2cPreview(task: string): Promise<D2cPreviewStatus> {
    const existing = this.#d2cPreviews.get(task);
    if (existing !== undefined) return { running: true, url: existing.url, ...this.#mockUrl(task) };
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before starting a D2C preview");
    const workflow = await readWorkflow(workspace, task);
    if (workflow?.integrationFiles === undefined) throw new Error("Generate D2C integration code before starting the preview");
    const mockStatus = await this.startD2cMock(task);
    const running = await this.#runD2cPreview(d2cOutputDirectory(workspace, task), { workspace });
    this.#d2cPreviews.set(task, running);
    if (mockStatus.url !== undefined) this.#d2cPreviewMockUrls.set(task, mockStatus.url);
    const interaction = workflow.interaction ?? { manualDecision: "pending" as const, updatedAt: new Date().toISOString() };
    await writeWorkflow(workspace, { ...workflow, revision: workflow.revision + 1, stage: "interaction-review", interaction, updatedAt: new Date().toISOString() });
    return { running: true, url: running.url, ...this.#mockUrl(task) };
  }

  async stopD2cPreview(task: string): Promise<D2cPreviewStatus> {
    const running = this.#d2cPreviews.get(task);
    if (running !== undefined) { this.#d2cPreviews.delete(task); this.#d2cPreviewMockUrls.delete(task); await running.stop(); }
    return { running: false, ...this.#mockUrl(task) };
  }

  getD2cPreviewStatus(task: string): D2cPreviewStatus {
    const running = this.#d2cPreviews.get(task);
    return running === undefined ? { running: false, ...this.#mockUrl(task) } : { running: true, url: running.url, ...this.#mockUrl(task) };
  }

  async runD2cInteractionTests(task: string): Promise<D2cInteractionStatus> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before running D2C interaction tests");
    const preview = this.#d2cPreviews.get(task);
    if (preview === undefined) throw new Error("Start the interactive D2C preview before running tests");
    const mock = this.#d2cMocks.get(task);
    if (mock === undefined) throw new Error("Start the D2C Express mock before running tests");
    if (this.#executeD2cInteractionTests === undefined) throw new Error("D2C interaction runner is unavailable");
    const workflow = await readWorkflow(workspace, task);
    if (workflow === undefined) throw new Error("D2C workflow is unavailable");
    const mappings = workflow.mappings as D2cApiMapping[] | undefined;
    if (mappings === undefined || !mappings.some((mapping) => mapping.status === "confirmed" || mapping.status === "auto")) {
      throw new Error("No API binding is confirmed; confirm module bindings in the integration view before running automated acceptance");
    }
    await this.#syncD2cRuntimeForAcceptance(task);
    const readyPreview = this.#d2cPreviews.get(task);
    const readyMock = this.#d2cMocks.get(task);
    if (readyPreview === undefined || readyMock === undefined) throw new Error("D2C preview or mock server is unavailable after synchronization");
    const manifestPath = join(taskDir(workspace, task), "design", "interaction-manifest.json");
    const manifest = parseInteractionManifest(await readFile(manifestPath, "utf8"));
    const result = await this.annotateD2cMockFailure(await this.#executeD2cInteractionTests(manifest, readyPreview.url, readyMock.url), task);
    const dir = integrationDirectory(workspace, task);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "interaction-results.json"), `${JSON.stringify(result, null, 2)}\n`);
    const next = await writeWorkflow(workspace, applyInteractionRun(workflow, result));
    return { workflow: next, result };
  }

  /** When the mock died during the run, persist its final output and mark every failed scenario with it. */
  async annotateD2cMockFailure(result: D2cInteractionRun, task: string): Promise<D2cInteractionRun> {
    const workspace = this.#workspace;
    if (workspace === undefined) return result;
    const mock = this.#d2cMocks.get(task);
    if (mock === undefined || !mock.exited() || result.failures === 0) return result;
    const output = mock.output().trim();
    try {
      const dir = join(d2cOutputDirectory(workspace, task), "mock-server.log");
      await writeFile(dir, `${output}\n`);
    } catch { /* diagnostics must never break acceptance */ }
    const note = `Mock server exited during the run; final output: ${output.slice(-600) || "<empty>"}`;
    return {
      ...result,
      scenarios: result.scenarios.map((scenario) => scenario.passed ? scenario : { ...scenario, failure: `${scenario.failure ?? "Scenario failed"} | ${note}` }),
    };
  }

  /** Restarts a dead mock and any preview whose baked-in VITE_API_BASE_URL no longer matches it. */
  async #syncD2cRuntimeForAcceptance(task: string): Promise<void> {
    const mock = this.#d2cMocks.get(task);
    if (mock === undefined) return;
    const healthy = await this.#probeD2cMock(mock.url);
    if (healthy && this.#d2cPreviewMockUrls.get(task) === mock.url) return;
    if (!healthy) {
      this.#d2cMocks.delete(task);
      await mock.stop().catch(() => undefined);
      await this.startD2cMock(task);
    }
    const currentMock = this.#d2cMocks.get(task);
    const preview = this.#d2cPreviews.get(task);
    // Vite reads .env.local only at startup; restart the preview so its API base matches the live mock.
    if (preview !== undefined && currentMock !== undefined && this.#d2cPreviewMockUrls.get(task) !== currentMock.url) {
      this.#d2cPreviews.delete(task);
      this.#d2cPreviewMockUrls.delete(task);
      await preview.stop().catch(() => undefined);
      await this.startD2cPreview(task);
    }
  }

  async setD2cManualAcceptance(task: string, accepted: boolean): Promise<D2cWorkflow> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before accepting a D2C interaction preview");
    if (accepted && !this.#d2cPreviews.has(task)) throw new Error("Start and inspect the interactive preview before accepting it");
    const workflow = await readWorkflow(workspace, task);
    if (workflow === undefined) throw new Error("D2C workflow is unavailable");
    return writeWorkflow(workspace, applyManualInteractionDecision(workflow, accepted));
  }

  async getD2cJudgeConfig(): Promise<D2cJudgeConfigView> {
    return this.#d2cJudge?.config() ?? { configured: false };
  }

  async saveD2cJudgeConfig(input: D2cJudgeConfig): Promise<D2cJudgeConfigView> {
    if (this.#d2cJudge === undefined) throw new Error("D2C multimodal judge is unavailable");
    return this.#d2cJudge.saveConfig(input);
  }

  async runD2cQualityJudge(task: string): Promise<D2cQualityJudgeStatus> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before running the D2C quality judge");
    if (this.#d2cJudge === undefined || this.#captureD2cPreview === undefined) {
      throw new Error("D2C multimodal judge is unavailable");
    }
    const configured = await this.#d2cJudge.config();
    if (!configured.configured) throw new Error("Configure a multimodal D2C judge model before running the quality gate");
    const workflow = await readWorkflow(workspace, task);
    if (workflow?.interaction?.automated?.passed !== true || workflow.interaction.manualDecision !== "accepted") {
      throw new Error("Complete automated and manual D2C interaction acceptance before running the quality judge");
    }
    const preview = this.#d2cPreviews.get(task);
    if (preview === undefined) throw new Error("Start and keep the embedded D2C preview open before running the quality judge");
    const bundle = await readReport(workspace, task, workflow.activeReportId);
    const manifest = await readManifest(workspace, task);
    const page = bundle.report.page?.html ?? manifest.entryHtml;
    const targetUrl = new URL(page, preview.url.endsWith("/") ? preview.url : `${preview.url}/`).toString();
    const implementationPng = await this.#captureD2cPreview(targetUrl);
    assertPngDimensions(implementationPng);
    const judgment = await this.#d2cJudge.evaluate({
      report: bundle.report,
      interaction: workflow.interaction.automated,
      designPng: Buffer.from(bundle.designPng),
      implementationPng,
    });
    const next = await writeWorkflow(workspace, applyQualityJudgment(workflow, judgment));
    await writeFile(join(taskDir(workspace, task), "quality-judge.json"), `${JSON.stringify(judgment, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return { workflow: next, judgment };
  }

  resolveApproval(decision: "allow" | "deny" | "always"): void {
    this.#runtime?.approvals.resolve(decision === "deny" ? "deny" : decision === "always" ? "always" : "once");
  }

  answerQuestions(answers: Record<number, string>): void {
    this.#runtime?.services.questions.answer(answers);
  }

  async resolveMemoryReview(id: string, decision: "accept" | "dismiss"): Promise<void> {
    const reviews = this.#runtime?.memoryReviews;
    if (reviews === undefined) return;
    if (decision === "accept") await reviews.accept(id);
    else reviews.dismiss(id);
    this.#publishSnapshot();
  }

  async dispose(): Promise<void> {
    await this.#disposeRuntime();
    await this.#stopAllD2cPreviews();
    await this.#stopAllD2cMocks();
  }

  #publishSnapshot(): DesktopSnapshot {
    const snapshot = this.snapshot();
    this.#emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  #withActiveSession(sessions: readonly DesktopSessionSummary[]): readonly DesktopSessionSummary[] {
    const activeSessionId = this.#runtime?.sessionId;
    if (activeSessionId === undefined || sessions.some((session) => session.sessionId === activeSessionId)) {
      return sessions;
    }
    const active = this.#sessions.find((session) => session.sessionId === activeSessionId);
    return active === undefined ? sessions : [active, ...sessions];
  }

  async #disposeRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#busy = false;
    if (runtime === undefined) return;
    await runtime.session.close();
    await runtime.dispose();
  }

  async #stopAllD2cMocks(): Promise<void> {
    const running = [...this.#d2cMocks.values()];
    this.#d2cMocks.clear();
    await Promise.all(running.map((item) => item.stop().catch(() => undefined)));
  }

  #mockUrl(task: string): { mockUrl?: string } {
    const url = this.#d2cMocks.get(task)?.url;
    return url === undefined ? {} : { mockUrl: url };
  }

  async #stopAllD2cPreviews(): Promise<void> {
    const running = [...this.#d2cPreviews.values()];
    this.#d2cPreviews.clear();
    this.#d2cPreviewMockUrls.clear();
    await Promise.all(running.map((item) => item.stop().catch(() => undefined)));
  }

  #requireSkillManager(): SkillManager {
    if (this.#skillManager === undefined) throw new Error("Open a project before managing skills");
    return this.#skillManager;
  }

  #requireMemoryManager(): MemoryManagerLike {
    if (this.#memoryManager === undefined) throw new Error("Open a project before managing long-term memory");
    return this.#memoryManager;
  }

  #requireMcpManager(): ProjectMcpConfigManagerLike {
    if (this.#mcpManager === undefined) throw new Error("Open a project before managing MCP services");
    return this.#mcpManager;
  }
}
