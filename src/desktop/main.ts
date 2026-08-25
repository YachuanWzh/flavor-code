import { appendFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, shell } from "electron";

import {
  AnswerQuestionsInputSchema,
  AddDesktopModelInputSchema,
  AppMenuInputSchema,
  D2cGetReportInputSchema,
  D2cImportInputSchema,
  D2cCreateProductInputSchema,
  D2cProductDecisionInputSchema,
  D2cPrdRegenerateInputSchema,
  D2cPrdSectionUpdateInputSchema,
  D2cReviewInputSchema,
  D2cManualAcceptanceInputSchema,
  D2cJudgeConfigInputSchema,
  D2cQualityIssueDecisionInputSchema,
  D2cConfirmMappingInputSchema,
  D2cTaskActionInputSchema,
  CloseProjectInputSchema,
  DeleteSessionInputSchema,
  GitCommitInputSchema,
  GitDiffInputSchema,
  GitPathInputSchema,
  DeleteMemoryInputSchema,
  DESKTOP_CHANNELS,
  OpenWorkspaceInputSchema,
  ProjectPathInputSchema,
  MemoryCandidateInputSchema,
  McpServerNameInputSchema,
  ResolveApprovalInputSchema,
  ResolveMemoryReviewInputSchema,
  StartSessionInputSchema,
  UpdateProjectInputSchema,
  UpdateSessionInputSchema,
  SkillDraftInputSchema,
  SkillNameInputSchema,
  UpdateSkillInputSchema,
  UpdateMemoryInputSchema,
  SetSkillEnabledInputSchema,
  SaveMcpServerInputSchema,
  SetMcpServerEnabledInputSchema,
  SwitchDesktopModelInputSchema,
  SubmitInputSchema,
  type DesktopEvent,
  type DesktopActivityItem,
  type DesktopRecoveryItem,
  type DesktopSnapshot,
  type SessionStartedPayload,
} from "./contracts.js";
import { createD2cCaptureService } from "./d2c-capture.js";
import { isLoopbackPreviewUrl } from "../d2c/interaction.js";
import { buildD2cJudgePrompt, finalizeD2cQualityJudgment } from "../d2c/judge.js";
import { buildD2cAutonomousPlanPrompt } from "../d2c/interaction-review.js";
import { createEmbeddedD2cAutomation, type D2cEmbeddedHost } from "./d2c-embedded-runner.js";
import { createD2cJudgeClient } from "./d2c-judge-client.js";
import { createD2cJudgeConfigStore } from "./d2c-judge-config.js";
import { createD2cTools } from "../d2c/tools.js";
import { createProductionRuntime } from "../production.js";
import { DesktopRuntimeController } from "./runtime-controller.js";
import { isSafeExternalUrl, isTrustedNavigation, normalizePersistedDesktopProjects } from "./security.js";
import { desktopWindowChrome } from "./window-options.js";
import { installCrashGuard } from "../utils/crash-guard.js";
import { desktopGitCommit, desktopGitDiff, desktopGitDiscard, desktopGitStage, desktopGitStatus, desktopGitUnstage } from "./git-manager.js";

// Record uncaught failures to .flavor/crash-*.log instead of dying silently.
installCrashGuard();

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const developmentUrl = process.env.FLAVOR_DESKTOP_DEV_URL;
let mainWindow: BrowserWindow | undefined;
let appMenu: Menu | undefined;
let quitting = false;

function logStartup(step: string, detail?: string): void {
  try {
    const logPath = join(dirname(process.execPath), "flavor-code-startup.log");
    const ts = new Date().toISOString();
    appendFileSync(logPath, `[${ts}] ${step}${detail ? ` | ${detail}` : ""}\n`);
  } catch { /* ignore logging errors */ }
}

// GPU 进程沙箱在部分 Windows 环境下会崩溃（exit_code=-2147483645），
// 导致打包后的 exe 无法显示窗口。开发模式通过 --no-sandbox 绕过。
app.commandLine.appendSwitch("disable-gpu-sandbox");

logStartup("module-loaded", `moduleDirectory=${moduleDirectory}, packaged=${app.isPackaged}`);

function emitDesktopEvent(event: DesktopEvent): void {
  if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(DESKTOP_CHANNELS.event, event);
  }
}

// D2C（Design to Code）：隐藏窗口快照服务，仅供 D2cCompare 工具使用。
const d2cCapture = createD2cCaptureService();
const d2cEmbedded = createEmbeddedD2cAutomation((): D2cEmbeddedHost | undefined => {
  const window = mainWindow;
  if (window === undefined || window.isDestroyed()) return undefined;
  return {
    isDestroyed: () => window.isDestroyed(),
    mainFrame: window.webContents.mainFrame,
    capturePage: (rect) => window.webContents.capturePage(rect),
  };
});
const d2cJudgeClient = createD2cJudgeClient();
const judgeStore = () => createD2cJudgeConfigStore(join(app.getPath("userData"), "d2c-judge.json"));
function judgeImage(png: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(png);
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest <= 2_048) return png;
  const ratio = 2_048 / longest;
  return image.resize({ width: Math.max(1, Math.round(size.width * ratio)), height: Math.max(1, Math.round(size.height * ratio)), quality: "best" }).toPNG();
}

interface ManagedDesktopTask {
  controller: DesktopRuntimeController;
  snapshot: DesktopSnapshot;
  sessionId?: string;
  payload?: SessionStartedPayload;
  terminal?: "completed" | "failed" | "interrupted";
}

interface ManagedDesktopProject {
  controller: DesktopRuntimeController;
  snapshot: DesktopSnapshot;
  tasks: Set<ManagedDesktopTask>;
  selectedTask?: ManagedDesktopTask;
}

interface PersistedProjectMeta { label?: string | undefined; pinned?: boolean }
interface PersistedSessionMeta { title?: string | undefined; pinned?: boolean; archived?: boolean }
interface DesktopWorkbenchState {
  projectMeta: Record<string, PersistedProjectMeta>;
  sessionMeta: Record<string, PersistedSessionMeta>;
  activities: DesktopActivityItem[];
  recoveryItems: DesktopRecoveryItem[];
  runningSessions: { workspace: string; sessionId: string }[];
  cleanShutdown: boolean;
}

const workbench: DesktopWorkbenchState = {
  projectMeta: {}, sessionMeta: {}, activities: [], recoveryItems: [], runningSessions: [], cleanShutdown: true,
};

const managedProjects = new Map<string, ManagedDesktopProject>();
const projectOrder: string[] = [];
let activeWorkspace: string | undefined;

function sessionMetaKey(workspace: string, sessionId: string): string { return `${workspace}\u0000${sessionId}`; }

function projectSessions(workspace: string, project: ManagedDesktopProject) {
  const merged = new Map(project.snapshot.sessions.map((session) => [session.sessionId, session]));
  for (const task of project.tasks) for (const session of task.snapshot.sessions) {
    const previous = merged.get(session.sessionId);
    if (previous === undefined || session.updatedAt >= previous.updatedAt) merged.set(session.sessionId, session);
  }
  return [...merged.values()].map((session) => {
    const meta = workbench.sessionMeta[sessionMetaKey(workspace, session.sessionId)] ?? {};
    const activity = workbench.activities.find((item) => item.workspace === workspace && item.sessionId === session.sessionId);
    const running = [...project.tasks].some((task) => task.sessionId === session.sessionId && task.snapshot.activeSession?.busy);
    return { ...session, ...meta, ...(running ? { activity: "running" as const } : activity === undefined ? {} : { activity: activity.kind, unread: activity.unread }) };
  }).sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.updatedAt.localeCompare(left.updatedAt));
}

function projectSummaries() {
  return [...projectOrder].sort((left, right) => Number(Boolean(workbench.projectMeta[right]?.pinned)) - Number(Boolean(workbench.projectMeta[left]?.pinned))).flatMap((workspace) => {
    const project = managedProjects.get(workspace);
    if (project === undefined) return [];
    const snapshot = project.selectedTask?.snapshot ?? project.snapshot;
    const active = snapshot.activeSession;
    const runningSessions = [...project.tasks].flatMap((task) => task.sessionId !== undefined && task.snapshot.activeSession?.busy ? [task.sessionId] : []);
    return [{
      workspace,
      ...workbench.projectMeta[workspace],
      sessions: projectSessions(workspace, project),
      ...(active === undefined ? {} : { activeSession: { sessionId: active.sessionId, busy: active.busy } }),
      running: runningSessions.length > 0 || snapshot.jobs.some((job) => job.state === "running"),
      runningSessions,
      unreadCount: workbench.activities.filter((item) => item.workspace === workspace && item.unread).length,
    }];
  });
}

function decorateSnapshot(snapshot: DesktopSnapshot): DesktopSnapshot {
  const workspace = snapshot.workspace;
  return {
    ...snapshot,
    sessions: workspace === undefined ? snapshot.sessions : projectSessions(workspace, managedProjects.get(workspace) ?? { controller, snapshot, tasks: new Set() }),
    projects: projectSummaries(),
    activities: workbench.activities,
    recoveryItems: workbench.recoveryItems,
  };
}

function decorateSessionStarted(payload: SessionStartedPayload): SessionStartedPayload {
  return { ...payload, snapshot: decorateSnapshot(payload.snapshot) };
}

function emitManagedDesktopEvent(workspace: string | undefined, owner: ManagedDesktopTask | undefined, event: DesktopEvent): void {
  if (workspace === undefined) {
    emitDesktopEvent(event.type === "snapshot" ? { ...event, snapshot: decorateSnapshot(event.snapshot) } : event);
    return;
  }
  const project = managedProjects.get(workspace);
  if (project !== undefined) {
    if (event.type === "snapshot") {
      const previous = owner?.snapshot;
      if (owner !== undefined) {
        owner.snapshot = event.snapshot;
        if (owner.payload !== undefined) owner.payload = { ...owner.payload, snapshot: event.snapshot };
      }
      else project.snapshot = event.snapshot;
      trackTaskTransition(workspace, owner, previous, event.snapshot);
    } else if (event.type === "session-started") {
      if (owner !== undefined) {
        owner.sessionId = event.payload.sessionId;
        owner.payload = event.payload;
        owner.snapshot = event.payload.snapshot;
      } else project.snapshot = event.payload.snapshot;
    } else if (event.type === "session-output" && owner !== undefined) {
      if (event.event.type === "done") owner.terminal = "completed";
      else if (event.event.type === "error") owner.terminal = "failed";
      else if (event.event.type === "exit") owner.terminal = "interrupted";
    } else if (event.type === "runtime-error") {
      if (owner !== undefined) owner.terminal = "failed";
      addActivity(workspace, event.sessionId ?? owner?.sessionId, "failed", "任务执行失败", event.message);
    }
  }
  const ownerSelected = owner === undefined ? project?.selectedTask === undefined : project?.selectedTask === owner;
  if (workspace === activeWorkspace && ownerSelected) {
    if (event.type === "snapshot") emitDesktopEvent({ ...event, workspace, snapshot: decorateSnapshot(event.snapshot) });
    else if (event.type === "session-started") emitDesktopEvent({ ...event, workspace, payload: decorateSessionStarted(event.payload) });
    else emitDesktopEvent({ ...event, workspace });
    return;
  }
  // Background output lets the renderer keep a warm transcript cache. Snapshot
  // changes redraw the active project's rail without stealing its conversation.
  if (event.type === "session-output") emitDesktopEvent({ ...event, workspace });
  if ((event.type === "snapshot" || event.type === "session-started") && activeWorkspace !== undefined) {
    emitDesktopEvent({ type: "snapshot", workspace: activeWorkspace, snapshot: decorateSnapshot(controller.snapshot()) });
  }
}

function createDesktopController(workspace?: string, owner?: ManagedDesktopTask): DesktopRuntimeController {
  return new DesktopRuntimeController({
    emit: (event) => emitManagedDesktopEvent(workspace, owner, event),
    runD2cInteractionTests: (manifest, baseUrl, mockUrl) => d2cEmbedded.run(manifest, baseUrl, mockUrl),
    observeD2cPages: (manifest, baseUrl) => d2cEmbedded.observe(manifest, baseUrl),
    captureD2cPreview: (url) => d2cEmbedded.capture(url),
    d2cJudge: {
      config: () => judgeStore().view(),
      saveConfig: (input) => judgeStore().save(input),
      evaluate: async ({ report, interaction, designPng, implementationPng }) => {
        const config = await judgeStore().load();
        if (config === undefined) throw new Error("Configure a multimodal D2C judge model before running the quality gate");
        const assessment = await d2cJudgeClient.evaluate(config, {
          prompt: buildD2cJudgePrompt({ report, interaction }),
          designPng: judgeImage(designPng), implementationPng: judgeImage(implementationPng),
        });
        return finalizeD2cQualityJudgment({ assessment, report, interaction, model: config.model, passThreshold: config.passThreshold });
      },
      planInteractions: async (input) => {
        const config = await judgeStore().load();
        if (config === undefined) throw new Error("Configure a multimodal D2C judge model before autonomous interaction review");
        return d2cJudgeClient.planInteractions(config, {
          prompt: buildD2cAutonomousPlanPrompt(input),
          screenshots: input.observations.map((page) => judgeImage(page.screenshot)),
          observedPages: input.observations.map((page) => page.url),
          observedSelectors: input.observations.flatMap((page) => page.elements.map((element) => element.selector)),
        });
      },
    },
    createRuntime: async (runtimeOptions) => createProductionRuntime({
      ...runtimeOptions,
      ...(runtimeOptions.workspace === undefined ? {} : {
        extraTools: createD2cTools(runtimeOptions.workspace, {
          capture: d2cCapture,
          onProgress: (progress) => emitManagedDesktopEvent(workspace, owner, { type: "d2c-progress", payload: progress }),
          onReport: (report) => emitManagedDesktopEvent(workspace, owner, { type: "d2c-report", payload: report }),
        }),
      }),
    }),
  });
}

const detachedController = createDesktopController();
let controller = detachedController;

function statePath(): string {
  return join(app.getPath("userData"), "desktop-state.json");
}

async function loadPersistedProjects() {
  try {
    const raw = await readFile(statePath(), "utf8");
    if (raw.length > 100_000) return { projects: [] as readonly string[] };
    const parsed = JSON.parse(raw) as Partial<DesktopWorkbenchState>;
    Object.assign(workbench, {
      projectMeta: validRecord(parsed.projectMeta), sessionMeta: validRecord(parsed.sessionMeta),
      activities: Array.isArray(parsed.activities) ? parsed.activities.slice(0, 500) : [],
      recoveryItems: Array.isArray(parsed.recoveryItems) ? parsed.recoveryItems.slice(0, 100) : [],
      runningSessions: Array.isArray(parsed.runningSessions) ? parsed.runningSessions.slice(0, 100) : [],
      cleanShutdown: parsed.cleanShutdown !== false,
    });
    if (!workbench.cleanShutdown) {
      const interruptedAt = new Date().toISOString();
      workbench.recoveryItems = workbench.runningSessions.map((item) => ({ ...item, interruptedAt, reason: "应用上次退出时任务仍在运行" }));
      workbench.activities = [...workbench.runningSessions.map((item, index): DesktopActivityItem => ({
        id: `recovery-${Date.now()}-${index}`, ...item, kind: "interrupted", title: "任务因应用退出而中断",
        detail: "可以恢复会话并继续执行", createdAt: interruptedAt, unread: true,
      })), ...workbench.activities].slice(0, 500);
    }
    return normalizePersistedDesktopProjects(parsed);
  } catch {
    return { projects: [] as readonly string[] };
  }
}

async function savePersistedProjects(): Promise<void> {
  await writeFile(statePath(), `${JSON.stringify({ workspace: activeWorkspace, projects: projectOrder, ...workbench })}\n`, { encoding: "utf8", mode: 0o600 });
}

function validRecord(value: unknown): Record<string, never> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, never> : {};
}

async function assertDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error("The selected project is not a directory");
}

async function openWorkspace(path: string) {
  const workspace = resolve(path);
  await assertDirectory(workspace);
  let project = managedProjects.get(workspace);
  if (project === undefined) {
    const nextController = createDesktopController(workspace);
    project = { controller: nextController, snapshot: nextController.snapshot(), tasks: new Set() };
    managedProjects.set(workspace, project);
    projectOrder.unshift(workspace);
    activeWorkspace = workspace;
    controller = nextController;
    project.snapshot = await nextController.openWorkspace(workspace);
  } else {
    activeWorkspace = workspace;
    controller = project.selectedTask?.controller ?? project.controller;
    project.snapshot = await project.controller.refreshSessions();
  }
  await savePersistedProjects();
  return decorateSnapshot(project.selectedTask?.snapshot ?? project.snapshot);
}

function trackTaskTransition(workspace: string, task: ManagedDesktopTask | undefined, previous: DesktopSnapshot | undefined, next: DesktopSnapshot): void {
  const sessionId = task?.sessionId ?? next.activeSession?.sessionId;
  if (sessionId === undefined) return;
  const wasBusy = previous?.activeSession?.busy ?? false;
  const busy = next.activeSession?.busy ?? false;
  const key = sessionMetaKey(workspace, sessionId);
  if (!wasBusy && busy) {
    if (task !== undefined) delete task.terminal;
    workbench.activities = workbench.activities.filter((item) => !(item.workspace === workspace && item.sessionId === sessionId));
    workbench.runningSessions = [...workbench.runningSessions.filter((item) => sessionMetaKey(item.workspace, item.sessionId) !== key), { workspace, sessionId }];
  } else if (wasBusy && !busy) {
    workbench.runningSessions = workbench.runningSessions.filter((item) => sessionMetaKey(item.workspace, item.sessionId) !== key);
    const outcome = task?.terminal ?? "completed";
    addActivity(workspace, sessionId, outcome, outcome === "failed" ? "任务执行失败" : outcome === "interrupted" ? "任务已中断" : "任务已运行完成");
  }
  const needsAttention = next.approval !== undefined || (next.questions?.length ?? 0) > 0;
  const hadAttention = previous?.approval !== undefined || (previous?.questions?.length ?? 0) > 0;
  if (needsAttention && !hadAttention) addActivity(workspace, sessionId, "attention", "任务等待你的确认");
  void savePersistedProjects();
}

function addActivity(workspace: string, sessionId: string | undefined, kind: DesktopActivityItem["kind"], title: string, detail?: string): void {
  const item: DesktopActivityItem = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, workspace, ...(sessionId === undefined ? {} : { sessionId }), kind, title, ...(detail === undefined ? {} : { detail }), createdAt: new Date().toISOString(), unread: true };
  workbench.activities = [item, ...workbench.activities.filter((old) => !(old.workspace === workspace && old.sessionId === sessionId && old.kind === kind))].slice(0, 500);
  if (Notification.isSupported()) {
    const notification = new Notification({ title, body: detail ?? `${workbench.projectMeta[workspace]?.label ?? workspace.split(/[\\/]/).pop() ?? workspace}` });
    notification.on("click", () => { void activateManagedSession(workspace, sessionId); });
    notification.show();
  }
  void savePersistedProjects();
}

async function startManagedSession(resumeSession?: string): Promise<SessionStartedPayload> {
  if (activeWorkspace === undefined) throw new Error("Open a project before starting a session");
  const project = managedProjects.get(activeWorkspace)!;
  if (resumeSession !== undefined) {
    const existing = [...project.tasks].find((task) => task.sessionId === resumeSession);
    if (existing?.payload !== undefined) {
      project.selectedTask = existing; controller = existing.controller;
      return decorateSessionStarted(existing.payload);
    }
  }
  if ([...project.tasks].filter((task) => task.snapshot.activeSession?.busy).length >= 4) throw new Error("每个项目最多同时运行 4 个任务");
  const task = {} as ManagedDesktopTask;
  task.controller = createDesktopController(activeWorkspace, task);
  task.snapshot = task.controller.snapshot();
  project.tasks.add(task); project.selectedTask = task; controller = task.controller;
  await task.controller.openWorkspace(activeWorkspace);
  const payload = await task.controller.startSession(resumeSession);
  task.sessionId = payload.sessionId; task.payload = payload; task.snapshot = payload.snapshot;
  project.snapshot = { ...project.snapshot, sessions: payload.snapshot.sessions };
  await savePersistedProjects();
  return decorateSessionStarted(payload);
}

async function activateManagedSession(workspace: string, sessionId?: string): Promise<SessionStartedPayload | undefined> {
  await openWorkspace(workspace);
  if (sessionId === undefined) return undefined;
  const project = managedProjects.get(workspace)!;
  const task = [...project.tasks].find((item) => item.sessionId === sessionId);
  const payload = task?.payload ?? await startManagedSession(sessionId);
  if (task !== undefined) { project.selectedTask = task; controller = task.controller; }
  workbench.activities = workbench.activities.map((item) => item.workspace === workspace && item.sessionId === sessionId ? { ...item, unread: false } : item);
  mainWindow?.show(); mainWindow?.focus();
  emitDesktopEvent({ type: "session-started", workspace, payload: decorateSessionStarted(payload) });
  await savePersistedProjects();
  return decorateSessionStarted(payload);
}

async function chooseAndOpenWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: "打开 Flavor Code 项目",
    properties: ["openDirectory", "createDirectory"],
  });
  const path = result.filePaths[0];
  return result.canceled || path === undefined ? undefined : openWorkspace(path);
}

// 应用内品牌图标：读取 assets/icon.png 转为 data URL 供渲染进程显示，
// app.getAppPath() 在开发与打包模式下均可定位到资源目录。
let cachedAppIconDataUrl: string | undefined;
function appIconDataUrl(): string | undefined {
  if (cachedAppIconDataUrl !== undefined) return cachedAppIconDataUrl;
  const icon = nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon.png"));
  if (icon.isEmpty()) return undefined;
  cachedAppIconDataUrl = icon.toDataURL();
  return cachedAppIconDataUrl;
}

function installIpcHandlers(): void {
  ipcMain.handle(DESKTOP_CHANNELS.appIcon, () => appIconDataUrl());
  ipcMain.handle(DESKTOP_CHANNELS.bootstrap, async () => {
    const persisted = await loadPersistedProjects();
    workbench.cleanShutdown = false;
    for (const path of [...persisted.projects].reverse()) {
      try { await openWorkspace(path); }
      catch { /* A moved or deleted project must not block the remaining list. */ }
    }
    if (persisted.workspace !== undefined && managedProjects.has(resolve(persisted.workspace))) {
      try { return await openWorkspace(persisted.workspace); }
      catch { /* fall through to the most recently available project */ }
    }
    const fallback = projectOrder[0];
    if (fallback !== undefined) return openWorkspace(fallback);
    return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.chooseWorkspace, chooseAndOpenWorkspace);
  ipcMain.handle(DESKTOP_CHANNELS.openWorkspace, async (_event, value) => {
    const { path } = OpenWorkspaceInputSchema.parse(value);
    return openWorkspace(path);
  });
  ipcMain.handle(DESKTOP_CHANNELS.startSession, async (_event, value) => {
    const { resumeSession } = StartSessionInputSchema.parse(value);
    return startManagedSession(resumeSession);
  });
  ipcMain.handle(DESKTOP_CHANNELS.selectSession, async (_event, value) => {
    const { sessionId } = DeleteSessionInputSchema.parse(value);
    if (activeWorkspace === undefined) throw new Error("请先打开项目");
    return activateManagedSession(activeWorkspace, sessionId);
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteSession, async (_event, value) => {
    const { sessionId } = DeleteSessionInputSchema.parse(value);
    if (activeWorkspace === undefined) return decorateSnapshot(await controller.deleteSession(sessionId));
    const project = managedProjects.get(activeWorkspace)!;
    const task = [...project.tasks].find((item) => item.sessionId === sessionId);
    if (task !== undefined) {
      if (task.snapshot.activeSession?.busy) throw new Error("请先停止正在运行的任务");
      await task.controller.dispose(); project.tasks.delete(task);
      if (project.selectedTask === task) { delete project.selectedTask; controller = project.controller; }
    }
    delete workbench.sessionMeta[sessionMetaKey(activeWorkspace, sessionId)];
    workbench.activities = workbench.activities.filter((item) => !(item.workspace === activeWorkspace && item.sessionId === sessionId));
    project.snapshot = await project.controller.deleteSession(sessionId);
    await savePersistedProjects();
    return decorateSnapshot(project.selectedTask?.snapshot ?? project.snapshot);
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateSession, async (_event, value) => {
    const input = UpdateSessionInputSchema.parse(value);
    if (activeWorkspace === undefined) throw new Error("请先打开项目");
    const key = sessionMetaKey(activeWorkspace, input.sessionId);
    workbench.sessionMeta[key] = { ...workbench.sessionMeta[key], ...(input.title === undefined ? {} : { title: input.title || undefined }), ...(input.pinned === undefined ? {} : { pinned: input.pinned }), ...(input.archived === undefined ? {} : { archived: input.archived }) };
    await savePersistedProjects();
    return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.acknowledgeSession, async (_event, value) => {
    const sessionId = Object.keys(value as object).length === 0 ? undefined : DeleteSessionInputSchema.parse(value).sessionId;
    workbench.activities = workbench.activities.map((item) => item.workspace === activeWorkspace && (sessionId === undefined || item.sessionId === sessionId) ? { ...item, unread: false } : item);
    await savePersistedProjects();
    return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateProject, async (_event, value) => {
    const input = UpdateProjectInputSchema.parse(value); const workspace = resolve(input.workspace);
    if (!managedProjects.has(workspace)) throw new Error("项目未打开");
    workbench.projectMeta[workspace] = { ...workbench.projectMeta[workspace], ...(input.label === undefined ? {} : { label: input.label || undefined }), ...(input.pinned === undefined ? {} : { pinned: input.pinned }) };
    await savePersistedProjects(); return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.closeProject, async (_event, value) => {
    const input = CloseProjectInputSchema.parse(value); const workspace = resolve(input.workspace);
    const project = managedProjects.get(workspace); if (project === undefined) return decorateSnapshot(controller.snapshot());
    if ([...project.tasks].some((task) => task.snapshot.activeSession?.busy) && !input.force) throw new Error("项目中仍有任务运行；确认后再关闭项目");
    await Promise.all([project.controller, ...[...project.tasks].map((task) => task.controller)].map((item) => item.dispose()));
    managedProjects.delete(workspace); projectOrder.splice(projectOrder.indexOf(workspace), 1);
    if (activeWorkspace === workspace) {
      activeWorkspace = projectOrder[0];
      const next = activeWorkspace === undefined ? undefined : managedProjects.get(activeWorkspace);
      controller = next?.selectedTask?.controller ?? next?.controller ?? detachedController;
    }
    await savePersistedProjects(); return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.revealProject, async (_event, value) => {
    const workspace = resolve(ProjectPathInputSchema.parse(value).workspace); await assertDirectory(workspace); await shell.openPath(workspace);
  });
  ipcMain.handle(DESKTOP_CHANNELS.copyProjectPath, async (_event, value) => {
    clipboard.writeText(resolve(ProjectPathInputSchema.parse(value).workspace));
  });
  ipcMain.handle(DESKTOP_CHANNELS.dismissRecovery, async (_event, value) => {
    const { sessionId } = DeleteSessionInputSchema.parse(value);
    workbench.recoveryItems = workbench.recoveryItems.filter((item) => !(item.workspace === activeWorkspace && item.sessionId === sessionId));
    await savePersistedProjects(); return decorateSnapshot(controller.snapshot());
  });
  ipcMain.handle(DESKTOP_CHANNELS.gitStatus, async () => activeWorkspace === undefined ? { repository: false, branch: "", head: "", files: [] } : desktopGitStatus(activeWorkspace));
  ipcMain.handle(DESKTOP_CHANNELS.gitDiff, async (_event, value) => { const input = GitDiffInputSchema.parse(value); if (activeWorkspace === undefined) throw new Error("请先打开项目"); return desktopGitDiff(activeWorkspace, input.path, input.staged); });
  ipcMain.handle(DESKTOP_CHANNELS.gitStage, async (_event, value) => { const { path } = GitPathInputSchema.parse(value); if (activeWorkspace === undefined) throw new Error("请先打开项目"); return desktopGitStage(activeWorkspace, path); });
  ipcMain.handle(DESKTOP_CHANNELS.gitUnstage, async (_event, value) => { const { path } = GitPathInputSchema.parse(value); if (activeWorkspace === undefined) throw new Error("请先打开项目"); return desktopGitUnstage(activeWorkspace, path); });
  ipcMain.handle(DESKTOP_CHANNELS.gitDiscard, async (_event, value) => { const { path } = GitPathInputSchema.parse(value); if (activeWorkspace === undefined) throw new Error("请先打开项目"); return desktopGitDiscard(activeWorkspace, path); });
  ipcMain.handle(DESKTOP_CHANNELS.gitCommit, async (_event, value) => { const { message } = GitCommitInputSchema.parse(value); if (activeWorkspace === undefined) throw new Error("请先打开项目"); return desktopGitCommit(activeWorkspace, message); });
  ipcMain.handle(DESKTOP_CHANNELS.showAppMenu, async (_event, value) => {
    const { menu, x, y } = AppMenuInputSchema.parse(value);
    const window = mainWindow;
    if (window === undefined) return;
    const index = { file: 0, edit: 1, view: 2, help: 3 }[menu];
    appMenu?.items[index]?.submenu?.popup({ window, x, y });
  });
  ipcMain.handle(DESKTOP_CHANNELS.submit, async (_event, value) => {
    const { prompt, delivery, attachments, permissionProfile } = SubmitInputSchema.parse(value);
    void controller.submit(prompt, delivery ?? "prompt", attachments ?? [], permissionProfile).catch(() => undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.finishTask, async () => controller.finishTask());
  ipcMain.handle(DESKTOP_CHANNELS.interrupt, async () => controller.interrupt());
  ipcMain.handle(DESKTOP_CHANNELS.resolveApproval, async (_event, value) => {
    controller.resolveApproval(ResolveApprovalInputSchema.parse(value).decision);
  });
  ipcMain.handle(DESKTOP_CHANNELS.answerQuestions, async (_event, value) => {
    controller.answerQuestions(AnswerQuestionsInputSchema.parse(value).answers);
  });
  ipcMain.handle(DESKTOP_CHANNELS.resolveMemoryReview, async (_event, value) => {
    const input = ResolveMemoryReviewInputSchema.parse(value);
    await controller.resolveMemoryReview(input.id, input.decision);
  });
  ipcMain.handle(DESKTOP_CHANNELS.listFiles, async () => {
    return controller.listWorkspaceFiles();
  });
  ipcMain.handle(DESKTOP_CHANNELS.listSkills, async () => controller.listSkills());
  ipcMain.handle(DESKTOP_CHANNELS.getSkill, async (_event, value) => {
    return controller.getSkill(SkillNameInputSchema.parse(value).name);
  });
  ipcMain.handle(DESKTOP_CHANNELS.createSkill, async (_event, value) => {
    return controller.createSkill(SkillDraftInputSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateSkill, async (_event, value) => {
    const input = UpdateSkillInputSchema.parse(value);
    return controller.updateSkill(input.originalName, input.draft);
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteSkill, async (_event, value) => {
    await controller.deleteSkill(SkillNameInputSchema.parse(value).name);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setSkillEnabled, async (_event, value) => {
    const input = SetSkillEnabledInputSchema.parse(value);
    await controller.setSkillEnabled(input.name, input.enabled);
  });
  ipcMain.handle(DESKTOP_CHANNELS.listMcpServers, async () => controller.listMcpServers());
  ipcMain.handle(DESKTOP_CHANNELS.saveMcpServer, async (_event, value) => {
    const { originalName, draft } = SaveMcpServerInputSchema.parse(value);
    return controller.saveMcpServer(originalName, draft);
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteMcpServer, async (_event, value) => {
    await controller.deleteMcpServer(McpServerNameInputSchema.parse(value).name);
  });
  ipcMain.handle(DESKTOP_CHANNELS.setMcpServerEnabled, async (_event, value) => {
    const { name, enabled } = SetMcpServerEnabledInputSchema.parse(value);
    return controller.setMcpServerEnabled(name, enabled);
  });
  ipcMain.handle(DESKTOP_CHANNELS.listMemory, async () => controller.listMemory());
  ipcMain.handle(DESKTOP_CHANNELS.createMemory, async (_event, value) => {
    return controller.createMemory(MemoryCandidateInputSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_CHANNELS.updateMemory, async (_event, value) => {
    const { id, type, content } = UpdateMemoryInputSchema.parse(value);
    return controller.updateMemory(id, { type, content });
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteMemory, async (_event, value) => {
    return controller.deleteMemory(DeleteMemoryInputSchema.parse(value).id);
  });
  ipcMain.handle(DESKTOP_CHANNELS.switchModel, async (_event, value) => {
    return decorateSnapshot(await controller.switchModel(SwitchDesktopModelInputSchema.parse(value).modelId));
  });
  ipcMain.handle(DESKTOP_CHANNELS.addModel, async (_event, value) => {
    const result = await controller.addModel(AddDesktopModelInputSchema.parse(value));
    return { ...result, snapshot: decorateSnapshot(result.snapshot) };
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cImport, async (_event, value) => {
    const { task } = D2cImportInputSchema.parse(value);
    const choice = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 Pixso 导出的设计稿目录",
      properties: ["openDirectory"],
    });
    const exportDir = choice.filePaths[0];
    if (choice.canceled || exportDir === undefined) return undefined;
    return controller.importD2cDesign(task, exportDir);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cCreateProduct, async (_event, value) => {
    return controller.createD2cProduct(D2cCreateProductInputSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetProduct, async (_event, value) => {
    return controller.getD2cProduct(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cRegeneratePrd, async (_event, value) => {
    const input = D2cPrdRegenerateInputSchema.parse(value);
    return controller.regenerateD2cPrd(input.task, input.query);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cUpdatePrdSection, async (_event, value) => {
    const input = D2cPrdSectionUpdateInputSchema.parse(value);
    return controller.updateD2cPrdSection(input.task, input.sectionId, input.body, input.expectedHash);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cDecideProduct, async (_event, value) => {
    const input = D2cProductDecisionInputSchema.parse(value);
    return controller.decideD2cProduct(input.task, input.stage, input.accepted, input.feedback);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStartProductPreview, async (_event, value) => {
    return controller.startD2cProductPreview(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStopProductPreview, async (_event, value) => {
    return controller.stopD2cProductPreview(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetProductPreviewStatus, async (_event, value) => {
    return controller.getD2cProductPreviewStatus(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cOpenProductPreview, async (_event, value) => {
    const status = controller.getD2cProductPreviewStatus(D2cTaskActionInputSchema.parse(value).task);
    if (status.url === undefined || !isLoopbackPreviewUrl(status.url)) throw new Error("D2C product preview is not running on loopback");
    await shell.openExternal(status.url);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cListReports, async () => controller.listD2cReports());
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetReport, async (_event, value) => {
    const { task, reportId } = D2cGetReportInputSchema.parse(value);
    return controller.getD2cReport(task, reportId);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cUpdateReview, async (_event, value) => {
    const input = D2cReviewInputSchema.parse(value);
    return controller.updateD2cReview(input.task, input.reportId, input.fingerprints, input.decision, input.instruction);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cImportOpenApi, async (_event, value) => {
    const { task } = D2cTaskActionInputSchema.parse(value);
    const choice = await dialog.showOpenDialog(mainWindow!, {
      title: "选择 Swagger / OpenAPI JSON",
      properties: ["openFile"],
      filters: [{ name: "OpenAPI JSON", extensions: ["json"] }],
    });
    const source = choice.filePaths[0];
    if (choice.canceled || source === undefined) return undefined;
    return controller.importD2cOpenApi(task, source);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetIntegration, async (_event, value) => {
    return controller.getD2cIntegration(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cConfirmMapping, async (_event, value) => {
    const input = D2cConfirmMappingInputSchema.parse(value);
    return controller.confirmD2cMapping(input.task, input.moduleId, input.operationKey);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGenerateIntegration, async (_event, value) => {
    return controller.generateD2cIntegration(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStartMock, async (_event, value) => {
    return controller.startD2cMock(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStopMock, async (_event, value) => {
    return controller.stopD2cMock(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetMockStatus, async (_event, value) => {
    return controller.getD2cMockStatus(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStartPreview, async (_event, value) => {
    return controller.startD2cPreview(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cStopPreview, async (_event, value) => {
    return controller.stopD2cPreview(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetPreviewStatus, async (_event, value) => {
    return controller.getD2cPreviewStatus(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cOpenPreview, async (_event, value) => {
    const status = controller.getD2cPreviewStatus(D2cTaskActionInputSchema.parse(value).task);
    if (status.url === undefined || !isLoopbackPreviewUrl(status.url)) throw new Error("D2C preview is not running on loopback");
    await shell.openExternal(status.url);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cRunInteractionTests, async (_event, value) => {
    return controller.runD2cInteractionTests(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cSetManualAcceptance, async (_event, value) => {
    const input = D2cManualAcceptanceInputSchema.parse(value);
    return controller.setD2cManualAcceptance(input.task, input.accepted);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cGetJudgeConfig, async () => controller.getD2cJudgeConfig());
  ipcMain.handle(DESKTOP_CHANNELS.d2cSaveJudgeConfig, async (_event, value) => {
    return controller.saveD2cJudgeConfig(D2cJudgeConfigInputSchema.parse(value));
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cRunQualityJudge, async (_event, value) => {
    return controller.runD2cQualityJudge(D2cTaskActionInputSchema.parse(value).task);
  });
  ipcMain.handle(DESKTOP_CHANNELS.d2cResolveQualityIssue, async (_event, value) => {
    const input = D2cQualityIssueDecisionInputSchema.parse(value);
    return controller.resolveD2cQualityIssue(input.task, input.issueId, input.decision);
  });
  ipcMain.handle(DESKTOP_CHANNELS.e2eGetDeliveryRun, async (_event, value) => {
    return controller.getE2eDeliveryRun(D2cTaskActionInputSchema.parse(value).task);
  });
}

function applicationMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "文件", submenu: [
      { label: "打开项目…", accelerator: "CmdOrCtrl+O", click: () => void chooseAndOpenWorkspace() },
      { type: "separator" }, { role: "quit", label: "退出" },
    ] },
    { label: "编辑", submenu: [
      { role: "undo", label: "撤销" }, { role: "redo", label: "重做" }, { type: "separator" },
      { role: "cut", label: "剪切" }, { role: "copy", label: "复制" }, { role: "paste", label: "粘贴" },
    ] },
    { label: "视图", submenu: [
      { role: "reload", label: "重新加载" }, { role: "toggleDevTools", label: "开发者工具" },
      { type: "separator" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
    ] },
    { label: "帮助", submenu: [
      { label: "Flavor Code 文档", click: () => void shell.openExternal("https://github.com") },
    ] },
  ]);
}

async function createWindow(): Promise<void> {
  const rendererPath = join(app.getAppPath(), "dist", "desktop-renderer", "index.html");
  mainWindow = new BrowserWindow({
    title: "Flavor Code",
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: "#f7f9fc",
    show: false,
    ...desktopWindowChrome(),
    webPreferences: {
      preload: join(moduleDirectory, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });
  // 设置窗口/任务栏图标：开发与打包模式都生效，
  // assets/icon.png 已包含在 electron-builder 的 files 清单中
  const iconPath = join(app.getAppPath(), "assets", "icon.png");
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    mainWindow.setIcon(icon);
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    workbench.cleanShutdown = true;
    const controllers = [detachedController, ...[...managedProjects.values()].flatMap((project) => [project.controller, ...[...project.tasks].map((task) => task.controller)])];
    void savePersistedProjects().catch(() => undefined).then(() => Promise.all(controllers.map((item) => item.dispose()))).finally(() => {
      mainWindow?.destroy();
      app.quit();
    });
  });

  // 加载内容并获取实际渲染 URL，用于导航守卫
  let rendererUrl: string;
  if (developmentUrl) {
    rendererUrl = developmentUrl;
    await mainWindow.loadURL(developmentUrl);
  } else {
    await mainWindow.loadFile(rendererPath);
    rendererUrl = mainWindow.webContents.getURL();
  }

  mainWindow.webContents.on("will-navigate", (event, url) => {
    const current = mainWindow?.webContents.getURL();
    if (!isTrustedNavigation(url, current ?? "", rendererUrl)) {
      event.preventDefault();
      if (isSafeExternalUrl(url)) void shell.openExternal(url);
    }
  });
}

app.whenReady().then(async () => {
  installIpcHandlers();
  appMenu = applicationMenu();
  Menu.setApplicationMenu(appMenu);
  await createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch((error) => {
  dialog.showErrorBox("Flavor Code 无法启动", error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault(); quitting = true; workbench.cleanShutdown = true;
  const controllers = [detachedController, ...[...managedProjects.values()].flatMap((project) => [project.controller, ...[...project.tasks].map((task) => task.controller)])];
  void savePersistedProjects().catch(() => undefined).then(() => Promise.all(controllers.map((item) => item.dispose()))).finally(() => {
    mainWindow?.destroy(); app.quit();
  });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
