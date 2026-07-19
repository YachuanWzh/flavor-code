import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS } from "./channels.js";
import type { DesktopEvent, FlavorDesktopApi } from "./contracts.js";

const api: FlavorDesktopApi = {
  bootstrap: () => ipcRenderer.invoke(DESKTOP_CHANNELS.bootstrap),
  chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseWorkspace),
  openWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspace, { path }),
  startSession: (resumeSession) => ipcRenderer.invoke(DESKTOP_CHANNELS.startSession,
    resumeSession === undefined ? {} : { resumeSession }),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, { sessionId }),
  showAppMenu: (menu, x, y) => ipcRenderer.invoke(DESKTOP_CHANNELS.showAppMenu, { menu, x, y }),
  submit: (prompt) => ipcRenderer.invoke(DESKTOP_CHANNELS.submit, { prompt }),
  interrupt: () => ipcRenderer.invoke(DESKTOP_CHANNELS.interrupt),
  resolveApproval: (decision) => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveApproval, { decision }),
  answerQuestions: (answers) => ipcRenderer.invoke(DESKTOP_CHANNELS.answerQuestions, { answers }),
  listFiles: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listFiles),
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("flavorDesktop", api);
