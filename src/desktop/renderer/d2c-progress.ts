import type { D2cProgressEvent } from "../../d2c/types.js";
import type { SessionOutput } from "../../ui/session.js";

export type D2cFramework = "vue" | "react";
export type D2cExecutionPhase = "analyzing" | "building" | "evaluating";
export type D2cActivityState = "running" | "completed" | "failed" | "info";

export interface D2cProgressActivity {
  id: string;
  label: string;
  state: D2cActivityState;
  startedAt: number;
  completedAt?: number;
  detail?: string;
}

export interface D2cPendingTask {
  task: string;
  framework: D2cFramework;
  startedAt: number;
  updatedAt: number;
  phase: D2cExecutionPhase;
  comparisonCycle: number;
  activity: readonly D2cProgressActivity[];
}

const MAX_ACTIVITY = 12;

export function createD2cPendingTask(
  task: string,
  framework: D2cFramework,
  now = Date.now(),
): D2cPendingTask {
  return {
    task,
    framework,
    startedAt: now,
    updatedAt: now,
    phase: "analyzing",
    comparisonCycle: 0,
    activity: [{
      id: "import",
      label: "HTML 设计稿已导入",
      state: "completed",
      startedAt: now,
      completedAt: now,
    }],
  };
}

export function applyD2cAgentProgress(
  pending: D2cPendingTask,
  event: SessionOutput,
  now = Date.now(),
): D2cPendingTask {
  if (event.type === "model-start") {
    const label = pending.phase === "analyzing"
      ? "分析设计并规划实现"
      : pending.phase === "building" ? "检查实现并规划下一步" : "分析评测结果";
    return updateActivity(pending, {
      id: `model:${event.id}`, label, state: "running", startedAt: now,
    }, now);
  }
  if (event.type === "model-end") {
    return completeActivity(pending, `model:${event.id}`, "completed", now);
  }
  if (event.type === "tool-start") {
    const phase = phaseForTool(event.name, pending.phase);
    const label = toolActivityLabel(event.name, event.label, event.hint);
    return updateActivity({ ...pending, phase }, {
      id: `tool:${event.id}`,
      label,
      state: "running",
      startedAt: now,
      ...(event.hint === undefined || event.hint === event.label ? {} : { detail: truncate(event.hint, 72) }),
    }, now);
  }
  if (event.type === "tool-end") {
    const state: D2cActivityState = event.result.ok ? "completed" : "failed";
    const existing = pending.activity.find((item) => item.id === `tool:${event.id}`);
    if (existing !== undefined) return completeActivity(pending, existing.id, state, now);
    return updateActivity(pending, {
      id: `tool:${event.id}`,
      label: toolActivityLabel(event.name, event.label, event.hint),
      state,
      startedAt: now,
      completedAt: now,
    }, now);
  }
  if (event.type === "model-retry") {
    return updateActivity(pending, {
      id: `retry:${event.attempt}`,
      label: `模型请求重试 ${event.attempt}/${event.maxAttempts}`,
      detail: `${Math.ceil(event.delayMs / 1_000)} 秒后继续`,
      state: "info",
      startedAt: now,
      completedAt: now,
    }, now);
  }
  if (event.type === "warning") {
    return updateActivity(pending, {
      id: `warning:${now}`,
      label: truncate(event.message, 96),
      state: "info",
      startedAt: now,
      completedAt: now,
    }, now);
  }
  if (event.type === "error") {
    return updateActivity(pending, {
      id: `error:${now}`,
      label: truncate(event.error.message, 96),
      state: "failed",
      startedAt: now,
      completedAt: now,
    }, now);
  }
  return pending;
}

export function applyD2cEngineProgress(
  pending: D2cPendingTask,
  event: D2cProgressEvent,
  now = Date.now(),
): D2cPendingTask {
  if (event.task !== pending.task) return pending;
  const id = `engine:${event.cycle}:${event.stage}`;
  const existing = pending.activity.find((item) => item.id === id);
  return updateActivity({ ...pending, phase: "evaluating", comparisonCycle: event.cycle }, {
    id,
    label: event.message,
    state: event.state,
    startedAt: existing?.startedAt ?? now,
    ...(event.state === "running" ? {} : { completedAt: now }),
    ...(event.cached === true ? { detail: "已复用缓存" } : {}),
  }, now);
}

function phaseForTool(name: string, current: D2cExecutionPhase): D2cExecutionPhase {
  if (name === "D2cCompare") return "evaluating";
  if (["Write", "Edit", "ApplyPatch", "Mkdir", "Copy", "Move", "Shell", "Bash", "Command", "Exec"].includes(name)) {
    return "building";
  }
  return current;
}

function toolActivityLabel(name: string, label?: string, hint?: string): string {
  const target = truncate(label ?? hint ?? "", 60);
  const suffix = target === "" ? "" : ` ${target}`;
  if (["Read", "Glob", "Grep", "Search", "List"].includes(name)) return `读取${suffix || "设计与项目文件"}`;
  if (name === "Write") return `创建${suffix || "前端文件"}`;
  if (name === "Edit" || name === "ApplyPatch") return `调整${suffix || "前端实现"}`;
  if (name === "Mkdir") return `创建${suffix || "项目目录"}`;
  if (["Shell", "Bash", "Command", "Exec"].includes(name)) return `运行${suffix || "项目命令"}`;
  if (name === "D2cCompare") return "启动视觉评测";
  return `${name}${suffix}`;
}

function updateActivity(
  pending: D2cPendingTask,
  activity: D2cProgressActivity,
  now: number,
): D2cPendingTask {
  const existing = pending.activity.findIndex((item) => item.id === activity.id);
  const next = [...pending.activity];
  if (existing < 0) next.push(activity);
  else next[existing] = activity;
  return { ...pending, updatedAt: now, activity: next.slice(-MAX_ACTIVITY) };
}

function completeActivity(
  pending: D2cPendingTask,
  id: string,
  state: "completed" | "failed",
  now: number,
): D2cPendingTask {
  const existing = pending.activity.find((item) => item.id === id);
  if (existing === undefined) return pending;
  return updateActivity(pending, { ...existing, state, completedAt: now }, now);
}

function truncate(value: string, max: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
