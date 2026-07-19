import type { PermissionMode } from "../../config/schema.js";
import type { DesktopSessionSummary } from "../contracts.js";
import { transcriptReducer, type TranscriptState } from "../../ui/transcript.js";
import type { SessionOutput } from "../../ui/session.js";

export interface SessionGroup {
  label: "今天" | "昨天" | "更早";
  sessions: readonly DesktopSessionSummary[];
}

export const STARTER_PROMPTS = ["梳理项目并给出改进方向", "帮我排查一个问题", "实现一个新功能"] as const;

export function groupSessions(sessions: readonly DesktopSessionSummary[], now = new Date()): SessionGroup[] {
  const day = (value: Date) => Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
  const today = day(now);
  const buckets: Record<SessionGroup["label"], DesktopSessionSummary[]> = { 今天: [], 昨天: [], 更早: [] };
  for (const session of [...sessions].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))) {
    const value = day(new Date(session.updatedAt));
    const label = value === today ? "今天" : value === today - 86_400_000 ? "昨天" : "更早";
    buckets[label].push(session);
  }
  return (["今天", "昨天", "更早"] as const)
    .filter((label) => buckets[label].length > 0)
    .map((label) => ({ label, sessions: buckets[label] }));
}

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: "按需确认",
  acceptEdits: "自动编辑",
  plan: "只读规划",
  bypassPermissions: "完全访问",
  auto: "智能判断",
  bubble: "向上确认",
};

export function permissionLabel(mode: PermissionMode): string {
  return PERMISSION_LABELS[mode];
}

export function sessionTitle(session: DesktopSessionSummary): string {
  const preview = session.preview?.trim();
  if (preview) return preview.length > 38 ? `${preview.slice(0, 38)}…` : preview;
  const time = new Date(session.updatedAt);
  return Number.isNaN(time.getTime()) ? session.sessionId : `会话 · ${time.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
}

export function workspaceName(path: string | undefined): string {
  if (path === undefined) return "Flavor Code";
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || path;
}

export function applyDesktopOutput(state: TranscriptState, event: SessionOutput): TranscriptState {
  return transcriptReducer(state, { type: "session", event });
}
