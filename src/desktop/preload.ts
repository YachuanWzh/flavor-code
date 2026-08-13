import { contextBridge, ipcRenderer } from "electron";

import { DESKTOP_CHANNELS } from "./channels.js";
import type { DesktopEvent, FlavorDesktopApi } from "./contracts.js";

const api: FlavorDesktopApi = {
  bootstrap: () => ipcRenderer.invoke(DESKTOP_CHANNELS.bootstrap),
  appIcon: () => ipcRenderer.invoke(DESKTOP_CHANNELS.appIcon),
  chooseWorkspace: () => ipcRenderer.invoke(DESKTOP_CHANNELS.chooseWorkspace),
  openWorkspace: (path) => ipcRenderer.invoke(DESKTOP_CHANNELS.openWorkspace, { path }),
  startSession: (resumeSession) => ipcRenderer.invoke(DESKTOP_CHANNELS.startSession,
    resumeSession === undefined ? {} : { resumeSession }),
  deleteSession: (sessionId) => ipcRenderer.invoke(DESKTOP_CHANNELS.deleteSession, { sessionId }),
  showAppMenu: (menu, x, y) => ipcRenderer.invoke(DESKTOP_CHANNELS.showAppMenu, { menu, x, y }),
  submit: (prompt, delivery = "prompt", attachments = [], permissionProfile) => ipcRenderer.invoke(DESKTOP_CHANNELS.submit, {
    prompt, delivery, ...(attachments.length === 0 ? {} : { attachments }),
    ...(permissionProfile === undefined ? {} : { permissionProfile }),
  }),
  finishTask: () => ipcRenderer.invoke(DESKTOP_CHANNELS.finishTask),
  interrupt: () => ipcRenderer.invoke(DESKTOP_CHANNELS.interrupt),
  resolveApproval: (decision) => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveApproval, { decision }),
  answerQuestions: (answers) => ipcRenderer.invoke(DESKTOP_CHANNELS.answerQuestions, { answers }),
  resolveMemoryReview: (id, decision) => ipcRenderer.invoke(DESKTOP_CHANNELS.resolveMemoryReview, { id, decision }),
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
  listD2cReports: () => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cListReports),
  getD2cReport: (task, reportId) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetReport, {
    task, ...(reportId === undefined ? {} : { reportId }),
  }),
  importD2cDesign: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cImport, { task }),
  createD2cProduct: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cCreateProduct, input),
  getD2cProduct: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetProduct, { task }),
  decideD2cProduct: (task, stage, accepted, feedback) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cDecideProduct, {
    task, stage, accepted, ...(feedback === undefined ? {} : { feedback }),
  }),
  startD2cProductPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStartProductPreview, { task }),
  stopD2cProductPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStopProductPreview, { task }),
  getD2cProductPreviewStatus: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetProductPreviewStatus, { task }),
  openD2cProductPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cOpenProductPreview, { task }),
  updateD2cReview: (task, reportId, fingerprints, decision, instruction) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cUpdateReview, {
    task, reportId, fingerprints, decision, ...(instruction === undefined ? {} : { instruction }),
  }),
  importD2cOpenApi: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cImportOpenApi, { task }),
  getD2cIntegration: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetIntegration, { task }),
  confirmD2cMapping: (task, moduleId, operationKey) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cConfirmMapping, { task, moduleId, operationKey }),
  generateD2cIntegration: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGenerateIntegration, { task }),
  startD2cMock: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStartMock, { task }),
  stopD2cMock: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStopMock, { task }),
  getD2cMockStatus: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetMockStatus, { task }),
  startD2cPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStartPreview, { task }),
  stopD2cPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cStopPreview, { task }),
  getD2cPreviewStatus: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetPreviewStatus, { task }),
  openD2cPreview: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cOpenPreview, { task }),
  runD2cInteractionTests: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cRunInteractionTests, { task }),
  setD2cManualAcceptance: (task, accepted) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cSetManualAcceptance, { task, accepted }),
  getD2cJudgeConfig: () => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cGetJudgeConfig),
  saveD2cJudgeConfig: (input) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cSaveJudgeConfig, input),
  runD2cQualityJudge: (task) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cRunQualityJudge, { task }),
  resolveD2cQualityIssue: (task, issueId, decision) => ipcRenderer.invoke(DESKTOP_CHANNELS.d2cResolveQualityIssue, { task, issueId, decision }),
  onEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: DesktopEvent) => listener(value);
    ipcRenderer.on(DESKTOP_CHANNELS.event, handler);
    return () => ipcRenderer.removeListener(DESKTOP_CHANNELS.event, handler);
  },
};

contextBridge.exposeInMainWorld("flavorDesktop", api);
