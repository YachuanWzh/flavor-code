import { appendFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell } from "electron";

import {
  AnswerQuestionsInputSchema,
  AppMenuInputSchema,
  DeleteSessionInputSchema,
  DESKTOP_CHANNELS,
  OpenWorkspaceInputSchema,
  ResolveApprovalInputSchema,
  StartSessionInputSchema,
  SkillDraftInputSchema,
  SkillNameInputSchema,
  UpdateSkillInputSchema,
  SetSkillEnabledInputSchema,
  SubmitInputSchema,
  type DesktopEvent,
} from "./contracts.js";
import { DesktopRuntimeController } from "./runtime-controller.js";
import { isSafeExternalUrl, isTrustedNavigation, normalizePersistedWorkspace } from "./security.js";
import { desktopWindowChrome } from "./window-options.js";

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

const controller = new DesktopRuntimeController({
  emit(event: DesktopEvent) {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(DESKTOP_CHANNELS.event, event);
    }
  },
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

function installIpcHandlers(): void {
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
    const { prompt } = SubmitInputSchema.parse(value);
    void controller.submit(prompt).catch(() => undefined);
  });
  ipcMain.handle(DESKTOP_CHANNELS.interrupt, async () => controller.interrupt());
  ipcMain.handle(DESKTOP_CHANNELS.resolveApproval, async (_event, value) => {
    controller.resolveApproval(ResolveApprovalInputSchema.parse(value).decision);
  });
  ipcMain.handle(DESKTOP_CHANNELS.answerQuestions, async (_event, value) => {
    controller.answerQuestions(AnswerQuestionsInputSchema.parse(value).answers);
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
  // 设置窗口图标（开发模式）
  if (!app.isPackaged) {
    const iconPath = join(app.getAppPath(), "assets", "icon.png");
    const icon = nativeImage.createFromPath(iconPath);
    console.log("Setting icon from:", iconPath, "isEmpty:", icon.isEmpty());
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
