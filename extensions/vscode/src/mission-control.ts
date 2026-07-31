import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import * as vscode from "vscode";

import type { DashboardSnapshot, FileFootprint } from "./dashboard-model.js";

export interface SessionTreeNode {
  id: string;
  parentId?: string | null;
  prompt?: string;
  label?: string;
  createdAt?: string | number;
}

export interface MissionControlHost {
  snapshot(): DashboardSnapshot;
  sessionTree(): Promise<SessionTreeNode[]>;
}

export interface FlavorTreeItem {
  kind: "file" | "change" | "checkpoint" | "diagnostic" | "plain";
  path?: string;
  nodeId?: string;
  uri?: vscode.Uri;
}

export class MissionControl implements vscode.Disposable {
  readonly #host: MissionControlHost;
  readonly #mission: MissionProvider;
  readonly #health: HealthProvider;
  readonly #timeline: TimelineProvider;
  readonly #decorations: FootprintDecorations;
  readonly #disposables: vscode.Disposable[];

  constructor(host: MissionControlHost) {
    this.#host = host;
    this.#mission = new MissionProvider(host);
    this.#health = new HealthProvider(host);
    this.#timeline = new TimelineProvider(host);
    this.#decorations = new FootprintDecorations();
    this.#disposables = [
      vscode.window.registerTreeDataProvider("flavor.mission", this.#mission),
      vscode.window.registerTreeDataProvider("flavor.health", this.#health),
      vscode.window.registerTreeDataProvider("flavor.timeline", this.#timeline),
      vscode.window.registerFileDecorationProvider(this.#decorations),
      vscode.languages.onDidChangeDiagnostics(() => this.#health.refresh()),
      vscode.workspace.onDidSaveTextDocument(() => this.#health.refresh()),
    ];
  }

  refresh(): void {
    this.#mission.refresh();
    this.#health.refresh();
    this.#timeline.refresh();
    this.#decorations.update(this.#host.snapshot().footprints);
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#mission.dispose();
    this.#health.dispose();
    this.#timeline.dispose();
    this.#decorations.dispose();
  }
}

abstract class RefreshingProvider implements vscode.TreeDataProvider<TreeEntry>, vscode.Disposable {
  readonly #emitter = new vscode.EventEmitter<TreeEntry | undefined | null | void>();
  readonly onDidChangeTreeData = this.#emitter.event;

  refresh(): void {
    this.#emitter.fire();
  }

  dispose(): void {
    this.#emitter.dispose();
  }

  abstract getTreeItem(element: TreeEntry): vscode.TreeItem;
  abstract getChildren(element?: TreeEntry): vscode.ProviderResult<TreeEntry[]>;
}

class TreeEntry extends vscode.TreeItem {
  children: TreeEntry[] | undefined;
  flavor: FlavorTreeItem | undefined;
}

class MissionProvider extends RefreshingProvider {
  readonly #host: MissionControlHost;

  constructor(host: MissionControlHost) {
    super();
    this.#host = host;
  }

  getTreeItem(element: TreeEntry): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TreeEntry): TreeEntry[] {
    if (element !== undefined) return element.children ?? [];
    const state = this.#host.snapshot();
    const roots: TreeEntry[] = [
      entry({
        label: connectionLabel(state),
        icon: state.connectionMode === "terminal" ? "radio-tower" : state.connected ? phaseIcon(state.phase) : "debug-disconnect",
        description: state.connectionMode === "terminal"
          ? "terminal"
          : state.connectionMode === "both"
            ? `terminal + extension`
            : state.sessionId === undefined
              ? undefined
              : shortId(state.sessionId),
        tooltip: connectionTooltip(state),
        command: state.connected ? undefined : { command: "flavor.start", title: "Start Flavor" },
      }),
    ];
    if (state.currentTool !== undefined) {
      roots.push(entry({ label: state.currentTool, description: "running", icon: "sync~spin" }));
    }
    if (state.loopMessage !== undefined) {
      roots.push(entry({ label: state.loopMessage, icon: "loop", tooltip: state.loopMessage }));
    }
    if (state.tasks.length > 0) {
      roots.push(entry({
        label: "Plan",
        icon: "checklist",
        expanded: true,
        children: state.tasks.map((task) => entry({
          label: task.label,
          description: task.status,
          icon: statusIcon(task.status),
          tooltip: task.detail,
        })),
      }));
    }
    if (state.agents.length > 0) {
      roots.push(entry({
        label: "Agents",
        icon: "organization",
        expanded: true,
        children: state.agents.map((agent) => entry({
          label: agent.label,
          description: agent.status,
          icon: statusIcon(agent.status),
        })),
      }));
    }
    if (state.inputTokens + state.outputTokens > 0) {
      roots.push(entry({
        label: `${formatNumber(state.inputTokens)} in · ${formatNumber(state.outputTokens)} out`,
        description: "tokens",
        icon: "pulse",
      }));
    }
    roots.push(entry({
      label: state.connectionMode === "terminal" ? "Start a separate extension Agent…" : "Ask Flavor…",
      icon: state.connectionMode === "terminal" ? "play" : "sparkle",
      command: {
        command: state.connectionMode === "terminal" ? "flavor.start" : "flavor.ask",
        title: state.connectionMode === "terminal" ? "Start Extension Agent" : "Ask Flavor",
      },
    }));
    return roots;
  }
}

class HealthProvider extends RefreshingProvider {
  readonly #host: MissionControlHost;

  constructor(host: MissionControlHost) {
    super();
    this.#host = host;
  }

  getTreeItem(element: TreeEntry): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeEntry): Promise<TreeEntry[]> {
    if (element !== undefined) return element.children ?? [];
    const diagnostics = workspaceDiagnostics();
    const changes = await gitChanges();
    const footprints = this.#host.snapshot().footprints;
    return [
      entry({
        label: diagnostics.length === 0 ? "No workspace diagnostics" : `${diagnostics.length} workspace diagnostics`,
        description: diagnostics.length === 0 ? "healthy" : undefined,
        icon: diagnostics.length === 0 ? "pass-filled" : "warning",
        children: diagnostics.slice(0, 100).map((item) => diagnosticEntry(item)),
      }),
      entry({
        label: changes.length === 0 ? "Working tree clean" : `${changes.length} changed files`,
        icon: changes.length === 0 ? "git-commit" : "git-compare",
        children: changes.map((change) => fileEntry(change.path, "change", change.status)),
      }),
      entry({
        label: footprints.length === 0 ? "No Agent footprints yet" : `${footprints.length} Agent footprints`,
        icon: "eye",
        children: footprints.slice().reverse().map((item) =>
          fileEntry(item.path, "file", `${item.action} · ${item.tool}`, "flavorFootprint")),
      }),
      entry({
        label: "Fix failing tests",
        icon: "beaker",
        command: { command: "flavor.fixTests", title: "Fix Failing Tests" },
      }),
      entry({
        label: "Review workspace changes",
        icon: "shield",
        command: { command: "flavor.review", title: "Review Workspace Changes" },
      }),
      entry({
        label: "Start adversarial review",
        icon: "organization",
        command: { command: "flavor.bossFight", title: "Start Adversarial Review" },
      }),
    ];
  }
}

class TimelineProvider extends RefreshingProvider {
  readonly #host: MissionControlHost;

  constructor(host: MissionControlHost) {
    super();
    this.#host = host;
  }

  getTreeItem(element: TreeEntry): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TreeEntry): Promise<TreeEntry[]> {
    if (element !== undefined) return element.children ?? [];
    let nodes: SessionTreeNode[];
    try {
      nodes = await this.#host.sessionTree();
    } catch {
      return [entry({
        label: "Start Flavor to load checkpoints",
        icon: "history",
        command: { command: "flavor.start", title: "Start Flavor" },
      })];
    }
    if (nodes.length === 0) {
      return [entry({
        label: "Create the first checkpoint",
        icon: "add",
        command: { command: "flavor.checkpoint", title: "Create Checkpoint" },
      })];
    }
    return nodes.slice().reverse().map((node, index) => {
      const item = entry({
        label: node.label ?? node.prompt?.trim().slice(0, 72) ?? node.id,
        description: index === 0 ? "current" : shortId(node.id),
        icon: index === 0 ? "debug-stackframe-active" : "circle-outline",
        tooltip: node.prompt ?? node.id,
        command: { command: "flavor.tree", title: "Show Session Tree" },
        contextValue: "flavorCheckpoint",
      });
      item.flavor = { kind: "checkpoint", nodeId: node.id };
      return item;
    });
  }
}

class FootprintDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  readonly #emitter = new vscode.EventEmitter<vscode.Uri[]>();
  readonly onDidChangeFileDecorations = this.#emitter.event;
  #items = new Map<string, FileFootprint>();

  update(items: FileFootprint[]): void {
    const previous = [...this.#items.keys()].map((path) => workspaceUri(path)).filter(isDefined);
    this.#items = new Map(items.map((item) => [uriKey(workspaceUri(item.path)), item]));
    const current = [...this.#items.keys()].map((value) => vscode.Uri.parse(value));
    this.#emitter.fire([...previous, ...current]);
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const item = this.#items.get(uriKey(uri));
    if (item === undefined) return undefined;
    return {
      badge: item.action === "changed" ? "M" : item.action === "read" ? "R" : "•",
      tooltip: `Flavor ${item.action} this file with ${item.tool}`,
      color: new vscode.ThemeColor(item.action === "changed"
        ? "gitDecoration.modifiedResourceForeground"
        : "charts.blue"),
      propagate: false,
    };
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

function entry(options: {
  label: string;
  description?: string | undefined;
  tooltip?: string | undefined;
  icon?: string | undefined;
  expanded?: boolean | undefined;
  children?: TreeEntry[] | undefined;
  command?: vscode.Command | undefined;
  contextValue?: string | undefined;
}): TreeEntry {
  const collapsible = options.children === undefined
    ? vscode.TreeItemCollapsibleState.None
    : options.expanded
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed;
  const item = new TreeEntry(options.label, collapsible);
  if (options.description !== undefined) item.description = options.description;
  item.tooltip = options.tooltip ?? options.label;
  if (options.icon !== undefined) item.iconPath = new vscode.ThemeIcon(options.icon);
  item.children = options.children;
  if (options.command !== undefined) item.command = options.command;
  if (options.contextValue !== undefined) item.contextValue = options.contextValue;
  return item;
}

function fileEntry(
  path: string,
  kind: "file" | "change",
  description: string,
  contextValue = kind === "change" ? "flavorChange" : "flavorFile",
): TreeEntry {
  const uri = workspaceUri(path);
  const item = entry({
    label: basename(path),
    description,
    tooltip: path,
    icon: kind === "change" ? "diff" : "file-code",
    contextValue,
    command: uri === undefined ? undefined : {
      command: kind === "change" ? "flavor.openChange" : "flavor.openFile",
      title: kind === "change" ? "Open Change" : "Open File",
      arguments: [{ kind, path, uri } satisfies FlavorTreeItem],
    },
  });
  if (uri !== undefined) item.resourceUri = uri;
  item.flavor = { kind, path, ...(uri === undefined ? {} : { uri }) };
  return item;
}

function diagnosticEntry(input: WorkspaceDiagnostic): TreeEntry {
  const path = workspaceRelative(input.uri);
  const item = entry({
    label: input.diagnostic.message.split("\n")[0]!.slice(0, 120),
    description: `${path}:${input.diagnostic.range.start.line + 1}`,
    tooltip: input.diagnostic.message,
    icon: input.diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning",
    contextValue: "flavorDiagnostic",
    command: {
      command: "vscode.open",
      title: "Open Diagnostic",
      arguments: [input.uri, { selection: input.diagnostic.range }],
    },
  });
  item.flavor = { kind: "diagnostic", path, uri: input.uri };
  return item;
}

interface WorkspaceDiagnostic {
  uri: vscode.Uri;
  diagnostic: vscode.Diagnostic;
}

function workspaceDiagnostics(): WorkspaceDiagnostic[] {
  return vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    diagnostics
      .filter((diagnostic) => diagnostic.severity <= vscode.DiagnosticSeverity.Warning)
      .map((diagnostic) => ({ uri, diagnostic })));
}

async function gitChanges(): Promise<Array<{ path: string; status: string }>> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) return [];
  return new Promise((resolvePromise) => {
    execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: folder.uri.fsPath,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        resolvePromise([]);
        return;
      }
      const records = stdout.split("\0").filter(Boolean);
      const changes: Array<{ path: string; status: string }> = [];
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        const status = record.slice(0, 2).trim() || "M";
        let path = record.slice(3);
        if (/^[RC]/.test(record) && records[index + 1] !== undefined) path = records[++index]!;
        changes.push({ path: path.replaceAll("\\", "/"), status });
      }
      resolvePromise(changes);
    });
  });
}

function workspaceUri(path: string): vscode.Uri | undefined {
  if (path.length === 0) return undefined;
  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (isAbsolute(withoutLocation)) return vscode.Uri.file(withoutLocation);
  if (folder === undefined) return undefined;
  return vscode.Uri.file(resolve(folder.uri.fsPath, withoutLocation));
}

function workspaceRelative(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder === undefined ? uri.fsPath : relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function uriKey(uri: vscode.Uri | undefined): string {
  return uri?.toString() ?? "";
}

function basename(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-1) ?? path;
}

function phaseLabel(phase: DashboardSnapshot["phase"]): string {
  if (phase === "thinking") return "Flavor is thinking";
  if (phase === "working") return "Flavor is working";
  if (phase === "done") return "Task completed";
  if (phase === "error") return "Task needs attention";
  return "Flavor is ready";
}

function connectionLabel(state: DashboardSnapshot): string {
  if (state.connectionMode === "terminal") {
    return state.phase === "idle" ? "Terminal Flavor connected" : phaseLabel(state.phase);
  }
  if (state.connectionMode === "both") return `${phaseLabel(state.phase)} · terminal connected`;
  if (state.connectionMode === "extension") return phaseLabel(state.phase);
  return "Agent not started";
}

function connectionTooltip(state: DashboardSnapshot): string {
  if (state.connectionMode === "terminal") {
    return "Listening to the Flavor session started in the terminal. Send prompts and control it from that terminal.";
  }
  if (state.connectionMode === "both") {
    return "The extension Agent and a terminal-started Flavor session are both connected.";
  }
  if (state.connectionMode === "extension") return state.sessionId ?? "Flavor extension Agent";
  return "Start an extension Agent, or run flavor in a terminal opened for this workspace.";
}

function phaseIcon(phase: DashboardSnapshot["phase"]): string {
  if (phase === "thinking" || phase === "working") return "sync~spin";
  if (phase === "done") return "pass-filled";
  if (phase === "error") return "error";
  return "sparkle";
}

function statusIcon(status: string): string {
  if (status === "completed") return "pass-filled";
  if (status === "in_progress" || status === "running") return "sync~spin";
  if (status === "failed" || status === "blocked") return "error";
  if (status === "cancelled") return "circle-slash";
  return "circle-outline";
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(-12);
}

function formatNumber(value: number): string {
  return Intl.NumberFormat(undefined, { notation: value >= 10_000 ? "compact" : "standard" }).format(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
