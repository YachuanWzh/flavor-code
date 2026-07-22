import { homedir } from "node:os";
import { resolve } from "node:path";

import type { PermissionMode } from "../config/schema.js";
import { createProductionRuntime, type ProductionRuntimeOptions } from "../production.js";
import { SessionStore } from "../session/store.js";
import type { Question } from "../tools/ask-user-question.js";
import type { SessionOutput } from "../ui/session.js";
import type { TranscriptState } from "../ui/transcript.js";
import { message } from "../utils/error.js";
import type { ApprovalDecision } from "../tools/runtime.js";
import { createGlobTool, type SearchResult } from "../tools/search.js";
import { SkillManager, type ManagedSkill, type ManagedSkillSummary, type SkillDraft } from "../skills/manager.js";
import { createProjectMemoryManager, type MemoryManagerLike, type MemorySnapshot } from "../memory/manager.js";
import type { MemoryCandidate, MemoryEntry } from "../memory/types.js";
import { ProjectMcpConfigManager, type ManagedMcpServer, type ProjectMcpConfigManagerLike } from "../mcp/config-manager.js";
import { DEFAULT_DESKTOP_MODELS, loadDesktopModels, saveDesktopModel } from "./model-config.js";
import type { AddDesktopModelInput, DesktopEvent, DesktopModelOption, DesktopModelMutationResult, DesktopSessionSummary, DesktopSnapshot, McpServerDraft, SessionStartedPayload } from "./contracts.js";

export interface RuntimeLike {
  readonly sessionId: string;
  readonly restoredTranscript: TranscriptState;
  readonly diagnostics: readonly string[];
  readonly session: {
    readonly active: boolean;
    start(): Promise<void>;
    submit(prompt: string): Promise<void>;
    interrupt(): "cancelled" | "exit";
    close(): Promise<void>;
  };
  readonly services: {
    mainModel(): string;
    subagentModel(): string;
    permissionMode(): PermissionMode;
    setModel(role: "main" | "subagent", modelId: string): void | Promise<void>;
    reloadSkills?(): Promise<void>;
    questions: { readonly pending: readonly Question[] | undefined; answer(answers: Record<number, string>): void };
  };
  readonly approvals: {
    readonly pending: DesktopSnapshot["approval"];
    resolve(decision: ApprovalDecision): void;
  };
  dispose(): Promise<void>;
}

export interface RuntimeFactoryOptions extends Pick<ProductionRuntimeOptions,
  "workspace" | "home" | "output" | "onApprovalChange" | "approvalPolicy" | "resumeSession"> {}

export interface DesktopRuntimeControllerOptions {
  home?: string;
  createRuntime?(options: RuntimeFactoryOptions): Promise<RuntimeLike>;
  listSessions?(workspace: string): Promise<readonly DesktopSessionSummary[]>;
  deleteSession?(workspace: string, sessionId: string): Promise<void>;
  loadModels?(workspace: string, home: string): Promise<DesktopModelOption[]>;
  saveModel?(workspace: string, home: string, input: AddDesktopModelInput): Promise<DesktopModelOption>;
  loadMemoryManager?(workspace: string, home: string): Promise<MemoryManagerLike>;
  loadMcpManager?(workspace: string): ProjectMcpConfigManagerLike;
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
  readonly #emit: (event: DesktopEvent) => void;
  #workspace: string | undefined;
  #sessions: readonly DesktopSessionSummary[] = [];
  #runtime: RuntimeLike | undefined;
  #skillManager: SkillManager | undefined;
  #memoryManager: MemoryManagerLike | undefined;
  #mcpManager: ProjectMcpConfigManagerLike | undefined;
  #models: readonly DesktopModelOption[] = DEFAULT_DESKTOP_MODELS;
  #busy = false;

  constructor(options: DesktopRuntimeControllerOptions) {
    this.#home = resolve(options.home ?? homedir());
    this.#createRuntime = options.createRuntime ?? (async (runtimeOptions) => createProductionRuntime(runtimeOptions));
    this.#listSessions = options.listSessions ?? (async (workspace) => {
      const store = new SessionStore({ workspace });
      const entries = await store.list();
      return Promise.all(entries.map(async (entry) => {
        try {
          const document = await store.load(entry.sessionId);
          const preview = document.conversation.messages.find((item) => item.role === "user")?.content.trim();
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
        },
        ...(runtime.approvals.pending === undefined ? {} : { approval: runtime.approvals.pending }),
        ...(runtime.services.questions.pending === undefined ? {} : { questions: runtime.services.questions.pending }),
      }),
      diagnostics: runtime?.diagnostics ?? [],
      models: this.#models,
    };
  }

  async openWorkspace(path: string): Promise<DesktopSnapshot> {
    const workspace = resolve(path);
    if (workspace !== this.#workspace) await this.#disposeRuntime();
    this.#workspace = workspace;
    this.#skillManager = new SkillManager({ workspace, home: this.#home });
    this.#memoryManager = await this.#loadMemoryManager(workspace, this.#home);
    this.#mcpManager = this.#loadMcpManager(workspace);
    this.#models = await this.#loadModels(workspace, this.#home);
    this.#sessions = await this.#listSessions(workspace);
    return this.#publishSnapshot();
  }

  async refreshSessions(): Promise<DesktopSnapshot> {
    if (this.#workspace !== undefined) this.#sessions = await this.#listSessions(this.#workspace);
    return this.#publishSnapshot();
  }

  async startSession(resumeSession?: string): Promise<SessionStartedPayload> {
    const workspace = this.#workspace;
    if (workspace === undefined) throw new Error("Open a project before starting a session");
    await this.#disposeRuntime();
    const runtime = await this.#createRuntime({
      workspace,
      home: this.#home,
      approvalPolicy: "prompt",
      ...(resumeSession === undefined ? {} : { resumeSession }),
      output: (event) => this.#emit({ type: "session-output", event }),
      onApprovalChange: () => {
        if (this.#runtime !== undefined) this.#publishSnapshot();
      },
    });
    this.#runtime = runtime;
    await runtime.session.start();
    const payload = { sessionId: runtime.sessionId, restoredTranscript: runtime.restoredTranscript, snapshot: this.snapshot() };
    this.#emit({ type: "session-started", payload });
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

  async submit(prompt: string): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) throw new Error("Start a session before sending a message");
    if (this.#busy) throw new Error("A task is already running");
    this.#busy = true;
    this.#publishSnapshot();
    try {
      await runtime.session.submit(prompt);
    } catch (error) {
      this.#emit({ type: "runtime-error", message: message(error) });
      throw error;
    } finally {
      this.#busy = false;
      if (this.#workspace !== undefined) this.#sessions = await this.#listSessions(this.#workspace).catch(() => this.#sessions);
      this.#publishSnapshot();
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
    return this.#requireMemoryManager().remember(candidate);
  }

  async updateMemory(id: string, candidate: MemoryCandidate): Promise<MemoryEntry> {
    return this.#requireMemoryManager().update(id, candidate);
  }

  async deleteMemory(id: string): Promise<boolean> {
    return this.#requireMemoryManager().delete(id);
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

  resolveApproval(decision: "allow" | "deny" | "always"): void {
    this.#runtime?.approvals.resolve(decision === "deny" ? "deny" : decision === "always" ? "always" : "once");
  }

  answerQuestions(answers: Record<number, string>): void {
    this.#runtime?.services.questions.answer(answers);
  }

  async dispose(): Promise<void> {
    await this.#disposeRuntime();
  }

  #publishSnapshot(): DesktopSnapshot {
    const snapshot = this.snapshot();
    this.#emit({ type: "snapshot", snapshot });
    return snapshot;
  }

  async #disposeRuntime(): Promise<void> {
    const runtime = this.#runtime;
    this.#runtime = undefined;
    this.#busy = false;
    if (runtime === undefined) return;
    await runtime.session.close();
    await runtime.dispose();
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
