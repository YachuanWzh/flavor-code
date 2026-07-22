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
  listSkills: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listSkills),
  getSkill: (name) => ipcRenderer.invoke(DESKTOP_CHANNELS.getSkill, { name }),
  createSkill: (draft) => ipcRenderer.invoke(DESKTOP_CHANNELS.createSkill, draft),
  updateSkill: (originalName, draft) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateSkill, { originalName, draft }),
  deleteSkill: (name) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSkill, { name }),
  setSkillEnabled: (name, enabled) => ipcRenderer.invoke(DESKTOP_CHANNELS.setSkillEnabled, { name, enabled }),
  listMcpServers: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listMcpServers),
  saveMcpServer: (originalName, draft) => ipcRenderer.invoke(DESKTOP_CHANNELS.saveMcpServer, {
    ...(originalName === undefined ? {} : { originalName }), draft,
  }),
  deleteMcpServer: (name) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteMcpServer, { name }),
  setMcpServerEnabled: (name, enabled) => ipcRenderer.invoke(DESKTOP_CHANNELS.setMcpServerEnabled, { name, enabled }),
  listMemory: () => ipcRenderer.invoke(DESKTOP_CHANNELS.listMemory),
  createMemory: (candidate) => ipcRenderer.invoke(DESKTOP_CHANNELS.createMemory, candidate),
  updateMemory: (id, candidate) => ipcRenderer.invoke(DESKTOP_CHANNELS.updateMemory, { id, ...candidate }),
  deleteMemory: (id) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteMemory, { id }),
  switchModel: (modelId) => ipcRenderer.invoke(DESKTOP_CHANNELS.switchModel, { modelId }),
  addModel: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.addModel, input),
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("flavorDesktop", api);
