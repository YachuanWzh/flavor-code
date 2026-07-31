export type RunPhase = "idle" | "thinking" | "working" | "done" | "error";

export interface DashboardTask {
  id: string;
  label: string;
  status: string;
  detail?: string;
}

export interface DashboardAgent {
  id: string;
  label: string;
  status: string;
}

export interface FileFootprint {
  path: string;
  action: "read" | "changed" | "inspected";
  tool: string;
}

export interface DashboardSnapshot {
  connected: boolean;
  connectionMode: "none" | "extension" | "terminal" | "both";
  externalSessionCount: number;
  phase: RunPhase;
  sessionId?: string;
  currentTool?: string;
  loopMessage?: string;
  inputTokens: number;
  outputTokens: number;
  tasks: DashboardTask[];
  agents: DashboardAgent[];
  footprints: FileFootprint[];
}

export class DashboardModel {
  #snapshot: DashboardSnapshot = emptySnapshot();
  #rpcConnected = false;
  #rpcSessionId: string | undefined;
  #externalSessionIds: string[] = [];

  snapshot(): DashboardSnapshot {
    return structuredClone(this.#snapshot);
  }

  setConnection(connected: boolean, sessionId?: string): void {
    this.#rpcConnected = connected;
    if (sessionId !== undefined) this.#rpcSessionId = sessionId;
    if (!connected) this.#rpcSessionId = undefined;
    this.#refreshConnection();
    if (!this.#snapshot.connected) {
      this.#snapshot.phase = "idle";
      delete this.#snapshot.currentTool;
    }
  }

  setExternalSessions(sessions: readonly { sessionId: string }[]): void {
    this.#externalSessionIds = sessions.map((session) => session.sessionId);
    this.#refreshConnection();
    if (!this.#snapshot.connected) {
      this.#snapshot.phase = "idle";
      delete this.#snapshot.currentTool;
    }
  }

  resetRun(): void {
    this.#snapshot.phase = "thinking";
    this.#snapshot.tasks = [];
    this.#snapshot.agents = [];
    this.#snapshot.footprints = [];
    delete this.#snapshot.currentTool;
    delete this.#snapshot.loopMessage;
  }

  accept(value: unknown): void {
    if (!isRecord(value) || typeof value.type !== "string") return;
    if (value.type === "model-start") {
      this.#snapshot.phase = "thinking";
    } else if (value.type === "tool-start") {
      this.#snapshot.phase = "working";
      this.#snapshot.currentTool = labelForTool(value);
      this.#recordFootprints(value);
    } else if (value.type === "tool-end") {
      delete this.#snapshot.currentTool;
      this.#recordFootprints(value);
    } else if (value.type === "tasks") {
      this.#acceptTasks(value.snapshot);
    } else if (value.type === "tasks-cleared") {
      this.#snapshot.tasks = [];
      this.#snapshot.agents = [];
    } else if (value.type === "usage") {
      if (typeof value.totalInputTokens === "number") this.#snapshot.inputTokens = value.totalInputTokens;
      if (typeof value.totalOutputTokens === "number") this.#snapshot.outputTokens = value.totalOutputTokens;
    } else if (value.type === "loop-progress") {
      if (typeof value.message === "string") this.#snapshot.loopMessage = value.message;
      this.#snapshot.phase = value.state === "failed" ? "error" : value.state === "running" ? "working" : this.#snapshot.phase;
    } else if (value.type === "done") {
      this.#snapshot.phase = "done";
      delete this.#snapshot.currentTool;
    } else if (value.type === "error") {
      this.#snapshot.phase = "error";
      delete this.#snapshot.currentTool;
    }
  }

  #acceptTasks(value: unknown): void {
    if (!isRecord(value)) return;
    const plan = isRecord(value.plan) && Array.isArray(value.plan.tasks) ? value.plan.tasks : [];
    this.#snapshot.tasks = plan.flatMap((candidate): DashboardTask[] => {
      if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.subject !== "string") return [];
      return [{
        id: candidate.id,
        label: candidate.status === "in_progress" && typeof candidate.activeForm === "string"
          ? candidate.activeForm
          : candidate.subject,
        status: typeof candidate.status === "string" ? candidate.status : "pending",
        ...(typeof candidate.result === "string" ? { detail: candidate.result } : {}),
      }];
    });

    const subagents = isRecord(value.subagents) ? value.subagents : undefined;
    const states = subagents !== undefined && isRecord(subagents.states) ? subagents.states : {};
    const graph = subagents !== undefined && isRecord(subagents.graph) && Array.isArray(subagents.graph.nodes)
      ? subagents.graph.nodes
      : [];
    const labels = new Map<string, string>();
    for (const node of graph) {
      if (isRecord(node) && typeof node.id === "string" && typeof node.description === "string") {
        labels.set(node.id, node.description);
      }
    }
    this.#snapshot.agents = Object.entries(states).map(([id, status]) => ({
      id,
      label: labels.get(id) ?? id,
      status: typeof status === "string" ? status : "pending",
    }));
  }

  #recordFootprints(event: Record<string, unknown>): void {
    const tool = typeof event.name === "string" ? event.name : "tool";
    const source = event.type === "tool-start" ? event.input : event.result;
    const action = footprintAction(tool);
    for (const path of extractFileReferences(source)) {
      const next: FileFootprint = { path, action, tool };
      const index = this.#snapshot.footprints.findIndex((item) => item.path === path);
      if (index >= 0) this.#snapshot.footprints[index] = next;
      else this.#snapshot.footprints.push(next);
    }
    this.#snapshot.footprints = this.#snapshot.footprints.slice(-40);
  }

  #refreshConnection(): void {
    const terminal = this.#externalSessionIds.length > 0;
    this.#snapshot.connected = this.#rpcConnected || terminal;
    this.#snapshot.connectionMode = this.#rpcConnected && terminal
      ? "both"
      : this.#rpcConnected
        ? "extension"
        : terminal
          ? "terminal"
          : "none";
    this.#snapshot.externalSessionCount = this.#externalSessionIds.length;
    const sessionId = this.#rpcSessionId ?? this.#externalSessionIds[0];
    if (sessionId === undefined) delete this.#snapshot.sessionId;
    else this.#snapshot.sessionId = sessionId;
  }
}

export function extractFileReferences(value: unknown): string[] {
  const found = new Set<string>();
  visit(value, found, 0);
  return [...found];
}

function visit(value: unknown, found: Set<string>, depth: number): void {
  if (depth > 5 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) visit(item, found, depth + 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, candidate] of Object.entries(value)) {
    if (typeof candidate === "string" && /^(?:file|filePath|path|relativePath)$/i.test(key) && looksLikeFile(candidate)) {
      found.add(candidate.replaceAll("\\", "/"));
    } else if (typeof candidate === "object") {
      visit(candidate, found, depth + 1);
    }
  }
}

function looksLikeFile(value: string): boolean {
  if (value.length === 0 || value.length > 1_000 || value.includes("\n")) return false;
  return /[\\/]/.test(value) || /\.[A-Za-z0-9]{1,12}(?::\d+)?$/.test(value);
}

function footprintAction(tool: string): FileFootprint["action"] {
  if (/edit|write|patch|create/i.test(tool)) return "changed";
  if (/read|glob|grep|search/i.test(tool)) return "read";
  return "inspected";
}

function labelForTool(event: Record<string, unknown>): string {
  const name = typeof event.name === "string" ? event.name : "tool";
  const label = typeof event.label === "string" ? event.label : undefined;
  return label === undefined ? name : `${name}: ${label}`;
}

function emptySnapshot(): DashboardSnapshot {
  return {
    connected: false,
    connectionMode: "none",
    externalSessionCount: 0,
    phase: "idle",
    inputTokens: 0,
    outputTokens: 0,
    tasks: [],
    agents: [],
    footprints: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
