import { appendFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";

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
  DeleteSessionInputSchema,
  DeleteMemoryInputSchema,
  DESKTOP_CHANNELS,
  OpenWorkspaceInputSchema,
  MemoryCandidateInputSchema,
  McpServerNameInputSchema,
  ResolveApprovalInputSchema,
  ResolveMemoryReviewInputSchema,
  StartSessionInputSchema,
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
import { isSafeExternalUrl, isTrustedNavigation, normalizePersistedWorkspace } from "./security.js";
import { desktopWindowChrome } from "./window-options.js";
import { installCrashGuard } from "../utils/crash-guard.js";

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

const controller = new DesktopRuntimeController({
  emit: emitDesktopEvent,
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
        onProgress: (progress) => emitDesktopEvent({ type: "d2c-progress", payload: progress }),
        onReport: (report) => emitDesktopEvent({ type: "d2c-report", payload: report }),
      }),
    }),
  }),
});

function statePath(): string {
  return join(app.getPath("userData"), "desktop-state.json");
}

async function loadPersistedWorkspace(): Promise<string | undefined> {
  try {
    const raw = await readFile(statePath(), "utf8");
    if (raw.length > 40_000) return undefined;
    return normalizePersistedWorkspace(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

async function savePersistedWorkspace(workspace: string): Promise<void> {
  await writeFile(statePath(), `${JSON.stringify({ workspace })}\n`, { encoding: "utf8", mode: 0o600 });
}

async function assertDirectory(path: string): Promise<void> {
  if (!(await stat(path)).isDirectory()) throw new Error("The selected project is not a directory");
}

async function openWorkspace(path: string) {
  await assertDirectory(path);
  const snapshot = await controller.openWorkspace(path);
  await savePersistedWorkspace(path);
  return snapshot;
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
    const workspace = await loadPersistedWorkspace();
    if (workspace === undefined) return controller.snapshot();
    try { return await openWorkspace(workspace); }
    catch { return controller.snapshot(); }
  });
  ipcMain.handle(DESKTOP_CHANNELS.chooseWorkspace, chooseAndOpenWorkspace);
  ipcMain.handle(DESKTOP_CHANNELS.openWorkspace, async (_event, value) => {
    const { path } = OpenWorkspaceInputSchema.parse(value);
    return openWorkspace(path);
  });
  ipcMain.handle(DESKTOP_CHANNELS.startSession, async (_event, value) => {
    const { resumeSession } = StartSessionInputSchema.parse(value);
    return controller.startSession(resumeSession);
  });
  ipcMain.handle(DESKTOP_CHANNELS.deleteSession, async (_event, value) => {
    const { sessionId } = DeleteSessionInputSchema.parse(value);
    return controller.deleteSession(sessionId);
  });
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
    return controller.switchModel(SwitchDesktopModelInputSchema.parse(value).modelId);
  });
  ipcMain.handle(DESKTOP_CHANNELS.addModel, async (_event, value) => {
    return controller.addModel(AddDesktopModelInputSchema.parse(value));
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
    void controller.dispose().finally(() => {
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

app.on("before-quit", () => { quitting = true; });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
