import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { relative } from "node:path";
import * as vscode from "vscode";

import { resolveAgentLaunch } from "./agent-launch.js";
import { DashboardModel } from "./dashboard-model.js";
import {
  FlavorCodeActionProvider,
  FlavorCodeLensProvider,
  type DiagnosticCommandInput,
  type SymbolCommandInput,
} from "./editor-actions.js";
import { FlavorIdeBridge } from "./ide-bridge.js";
import {
  MissionControl,
  type FlavorTreeItem,
  type SessionTreeNode,
} from "./mission-control.js";
import {
  diagnosticPrompt,
  diagnosticsPrompt,
  selectionPrompt,
  symbolPrompt,
} from "./prompts.js";
import { FlavorRpcClient } from "./rpc-client.js";

let child: ChildProcessWithoutNullStreams | undefined;
let client: FlavorRpcClient | undefined;
let clientStart: Promise<FlavorRpcClient> | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let ideBridge: FlavorIdeBridge | undefined;
let missionControl: MissionControl | undefined;
let codeLenses: FlavorCodeLensProvider | undefined;
let dashboard = new DashboardModel();
const eventListeners = new Set<(event: Record<string, unknown>) => void>();

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Flavor Code");
  dashboard = new DashboardModel();
  missionControl = new MissionControl({
    snapshot: () => dashboard.snapshot(),
    sessionTree: async () => {
      if (client === undefined) throw new Error("Flavor is not running");
      return asSessionTree(await client.request({ type: "get_tree" }));
    },
  });

  ideBridge = new FlavorIdeBridge(context, output, {
    onExternalEvent: (event) => dispatchEvent(event),
    onSessionsChanged: (sessions) => {
      dashboard.setExternalSessions(sessions);
      missionControl?.refresh();
      syncConnectionUi();
    },
  });
  void ideBridge.start().catch((error: unknown) => {
    output.appendLine(`IDE bridge failed to start: ${errorMessage(error)}`);
  });

  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "flavor.ask";
  status.text = "$(sparkle) Flavor";
  status.tooltip = "Ask Flavor";
  status.show();

  const command = (name: string, handler: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  command("flavor.start", startAgent);
  command("flavor.ask", askFlavor);
  command("flavor.focusTerminal", focusTerminalSession);
  command("flavor.selection", runSelection);
  command("flavor.diagnostics", fixDiagnostics);
  command("flavor.fixDiagnostic", (input: DiagnosticCommandInput) => actOnDiagnostic("fix", input));
  command("flavor.explainDiagnostic", (input: DiagnosticCommandInput) => actOnDiagnostic("explain", input));
  command("flavor.fixTests", fixFailingTests);
  command("flavor.review", reviewWorkspace);
  command("flavor.reviewSymbol", (input: SymbolCommandInput) => actOnSymbol("review", input));
  command("flavor.generateTests", (input: SymbolCommandInput) => actOnSymbol("tests", input));
  command("flavor.codeTour", createCodeTour);
  command("flavor.bossFight", startBossFight);
  command("flavor.steer", () => sendText("steer", "Steer the active Flavor task"));
  command("flavor.followUp", () => sendText("follow_up", "Queue a follow-up Flavor task"));
  command("flavor.stop", stopActiveTask);
  command("flavor.checkpoint", checkpoint);
  command("flavor.tree", showTree);
  command("flavor.rewind", rewind);
  command("flavor.fork", fork);
  command("flavor.unrevert", unrevert);
  command("flavor.refresh", refreshViews);
  command("flavor.openFile", openFile);
  command("flavor.openChange", openChange);

  codeLenses = new FlavorCodeLensProvider();
  context.subscriptions.push(
    output,
    status,
    missionControl,
    codeLenses,
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new FlavorCodeActionProvider(),
      FlavorCodeActionProvider.metadata,
    ),
    vscode.languages.registerCodeLensProvider({ scheme: "file" }, codeLenses),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("flavorCode.codeLens")) codeLenses?.refresh();
    }),
    { dispose: () => void stopClient() },
  );

  registerChatParticipant(context);
  missionControl.refresh();
  syncConnectionUi();
}

export async function deactivate(): Promise<void> {
  await stopClient();
}

async function startAgent(): Promise<void> {
  await ensureClient();
  await vscode.commands.executeCommand("workbench.view.extension.flavor");
}

async function ensureClient(): Promise<FlavorRpcClient> {
  if (client !== undefined && !client.closed) return client;
  if (clientStart !== undefined) return clientStart;
  client = undefined;
  const starting = startClient();
  clientStart = starting;
  try {
    return await starting;
  } finally {
    if (clientStart === starting) clientStart = undefined;
  }
}

async function startClient(): Promise<FlavorRpcClient> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("Open a workspace before starting Flavor");
  const executable = vscode.workspace.getConfiguration("flavorCode").get<string>("executable", "flavor");
  const launch = await resolveAgentLaunch(executable, ["--mode", "rpc", "--workspace", folder.uri.fsPath], {
    cwd: folder.uri.fsPath,
  });
  output.appendLine(`Starting Flavor: ${launch.command} ${launch.args.map(displayArgument).join(" ")}`);
  const spawned = spawn(launch.command, launch.args, {
    cwd: folder.uri.fsPath,
    env: { ...process.env, FLAVOR_CODE_IDE_EVENT_FORWARDING: "0" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child = spawned;
  let stderrTail = "";
  spawned.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderrTail = `${stderrTail}${text}`.slice(-4_000);
    output.append(text);
  });
  try {
    await waitForSpawn(spawned);
  } catch (error) {
    if (child === spawned) child = undefined;
    dashboard.setConnection(false);
    missionControl?.refresh();
    syncConnectionUi();
    throw new Error(`Flavor RPC agent failed to start: ${errorMessage(error)}`);
  }
  const rpc = new FlavorRpcClient({ input: spawned.stdout, output: spawned.stdin });
  client = rpc;
  rpc.onEvent(dispatchEvent);
  spawned.once("error", (error) => {
    output.appendLine(`Flavor failed to start: ${error.message}`);
    if (client === rpc) client = undefined;
    if (child === spawned) child = undefined;
    dashboard.setConnection(false);
    missionControl?.refresh();
    syncConnectionUi();
  });
  spawned.once("exit", (code) => {
    output.appendLine(`Flavor process exited (${code ?? "signal"}).`);
    if (client === rpc) client = undefined;
    if (child === spawned) child = undefined;
    dashboard.setConnection(false);
    missionControl?.refresh();
    syncConnectionUi();
  });
  status.text = "$(sync~spin) Flavor";
  status.tooltip = "Flavor is starting";
  let state: Record<string, unknown>;
  try {
    state = asRecord(await rpc.request({ type: "get_state" }));
  } catch (error) {
    if (client === rpc) client = undefined;
    if (child === spawned) child = undefined;
    spawned.kill();
    dashboard.setConnection(false);
    missionControl?.refresh();
    syncConnectionUi();
    const detail = stderrTail.trim();
    throw new Error(detail.length === 0
      ? `Flavor RPC agent failed to start: ${errorMessage(error)}`
      : `Flavor RPC agent failed to start: ${detail}`);
  }
  dashboard.setConnection(true, typeof state.sessionId === "string" ? state.sessionId : undefined);
  syncConnectionUi();
  output.appendLine(`Flavor session ${String(state.sessionId ?? "started")}.`);
  missionControl?.refresh();
  return rpc;
}

function waitForSpawn(spawned: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const onSpawn = (): void => {
      spawned.off("error", onError);
      resolvePromise();
    };
    const onError = (error: Error): void => {
      spawned.off("spawn", onSpawn);
      reject(error);
    };
    spawned.once("spawn", onSpawn);
    spawned.once("error", onError);
  });
}

function displayArgument(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

async function askFlavor(): Promise<void> {
  if (dashboard.snapshot().connectionMode === "terminal") {
    await focusTerminalSession();
    return;
  }
  const message = await vscode.window.showInputBox({
    title: "Ask Flavor",
    prompt: "Describe the outcome you want in this workspace",
    placeHolder: "Refactor the parser and keep existing behavior",
    ignoreFocusOut: true,
  });
  if (message?.trim()) await submitPrompt(message.trim());
}

async function focusTerminalSession(): Promise<void> {
  const terminal = vscode.window.activeTerminal
    ?? vscode.window.terminals.find((candidate) => /flavor/i.test(candidate.name));
  if (terminal !== undefined) {
    terminal.show(false);
    return;
  }
  await vscode.commands.executeCommand("workbench.action.terminal.focus");
  void vscode.window.showInformationMessage("Send prompts to the connected Flavor session from its terminal.");
}

async function runSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (editor === undefined || folder === undefined || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select code in a workspace editor first.");
    return;
  }
  const selection = editor.document.getText(editor.selection);
  await submitPrompt(selectionPrompt({
    relativePath: relativePath(folder, editor.document.uri),
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
    selection,
  }));
}

async function fixDiagnostics(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("Open a workspace first");
  const diagnostics = vscode.languages.getDiagnostics()
    .flatMap(([uri, entries]) => entries.map((entry) => ({
      relativePath: relativePath(folder, uri),
      line: entry.range.start.line + 1,
      severity: vscode.DiagnosticSeverity[entry.severity] ?? String(entry.severity),
      message: entry.message,
    })));
  if (diagnostics.length === 0) {
    void vscode.window.showInformationMessage("VS Code reports no diagnostics.");
    return;
  }
  await submitPrompt(diagnosticsPrompt(diagnostics));
}

async function actOnDiagnostic(action: "fix" | "explain", input: DiagnosticCommandInput | undefined): Promise<void> {
  if (input?.uri === undefined || input.diagnostic === undefined) {
    await fixDiagnostics();
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(input.uri);
  const severity = vscode.DiagnosticSeverity[input.diagnostic.severity] ?? "Diagnostic";
  await submitPrompt(diagnosticPrompt({
    action,
    relativePath: folder === undefined ? input.uri.fsPath : relativePath(folder, input.uri),
    line: input.diagnostic.range.start.line + 1,
    severity,
    message: input.diagnostic.message,
  }), { autoCheckpoint: action === "fix" });
}

async function actOnSymbol(action: "review" | "tests", input: SymbolCommandInput | undefined): Promise<void> {
  const editor = await editorForInput(input);
  if (editor === undefined) return;
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const line = input?.range.start.line ?? editor.selection.active.line;
  await submitPrompt(symbolPrompt({
    action,
    relativePath: folder === undefined ? editor.document.uri.fsPath : relativePath(folder, editor.document.uri),
    line: line + 1,
  }), { autoCheckpoint: action === "tests" });
}

async function fixFailingTests(testItem?: vscode.TestItem): Promise<void> {
  const location = testItem?.uri === undefined
    ? undefined
    : `${vscode.workspace.asRelativePath(testItem.uri, false)}${testItem.range === undefined ? "" : `:${testItem.range.start.line + 1}`}`;
  await submitPrompt([
    testItem === undefined ? "Fix the currently failing tests in this workspace." : `Fix the selected test: ${testItem.label}${location === undefined ? "" : ` (${location})`}.`,
    "Inspect the repository test configuration and the most relevant recent changes, run the narrowest useful failing test scope, fix root causes rather than weakening assertions, then rerun focused verification.",
    "If no tests currently fail, report that clearly and do not make speculative edits.",
  ].join("\n"));
}

async function reviewWorkspace(): Promise<void> {
  await submitPrompt([
    "Review the current uncommitted workspace changes.",
    "Inspect the actual diff and surrounding code. Prioritize correctness, regressions, security, and missing tests.",
    "Report findings with file and line references. Do not edit files unless I explicitly ask for fixes.",
  ].join("\n"), { autoCheckpoint: false });
}

async function createCodeTour(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage("Open the code you want Flavor to tour.");
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const path = folder === undefined ? editor.document.uri.fsPath : relativePath(folder, editor.document.uri);
  const line = editor.selection.active.line + 1;
  await submitPrompt([
    `Create an executable code tour starting at ${path}:${line}.`,
    "Trace the important control and data flow through the repository.",
    "Return a concise ordered tour with clickable file:line references, explain why each stop matters, and include failure paths.",
    "Do not edit files.",
  ].join("\n"), { autoCheckpoint: false });
}

async function startBossFight(): Promise<void> {
  const objective = await vscode.window.showInputBox({
    title: "Adversarial review",
    prompt: "What should the agents challenge?",
    value: "Review the current workspace changes for correctness, regressions, security risks, and missing tests",
    ignoreFocusOut: true,
  });
  if (!objective?.trim()) return;
  await submitPrompt(`/goal ${objective.trim()}`, { autoCheckpoint: false });
}

async function submitPrompt(
  message: string,
  options: { autoCheckpoint?: boolean; waitForDone?: boolean } = {},
): Promise<void> {
  const rpc = await ensureClient();
  const autoCheckpoint = options.autoCheckpoint
    ?? vscode.workspace.getConfiguration("flavorCode").get<boolean>("autoCheckpoint", true);
  if (autoCheckpoint) {
    await rpc.request({ type: "checkpoint", label: `Before: ${singleLine(message).slice(0, 96)}` })
      .catch((error: unknown) => output.appendLine(`Checkpoint skipped: ${errorMessage(error)}`));
  }
  dashboard.resetRun();
  missionControl?.refresh();
  status.text = "$(sync~spin) Flavor";
  status.tooltip = "Flavor is working";
  const terminal = options.waitForDone ? waitForTerminal() : undefined;
  await rpc.request({ type: "prompt", message });
  if (terminal !== undefined) await terminal;
}

async function sendText(type: "steer" | "follow_up", placeHolder: string): Promise<void> {
  const message = await vscode.window.showInputBox({ placeHolder, ignoreFocusOut: true });
  if (message?.trim()) await (await ensureClient()).request({ type, message: message.trim() });
}

async function stopActiveTask(): Promise<void> {
  await (await ensureClient()).request({ type: "abort" });
}

async function checkpoint(): Promise<void> {
  const label = await vscode.window.showInputBox({ placeHolder: "Checkpoint label (optional)" });
  const data = await (await ensureClient()).request({
    type: "checkpoint",
    ...(label?.trim() ? { label: label.trim() } : {}),
  });
  output.appendLine(`Checkpoint: ${JSON.stringify(data)}`);
  missionControl?.refresh();
}

async function showTree(): Promise<void> {
  const nodes = asSessionTree(await (await ensureClient()).request({ type: "get_tree" }));
  const item = await pickSessionNode(nodes, "Choose a Flavor session node");
  if (item !== undefined) {
    output.appendLine(JSON.stringify(item, null, 2));
    output.show(true);
  }
}

async function rewind(argument?: unknown): Promise<void> {
  const rpc = await ensureClient();
  const requested = treeItemData(argument)?.nodeId;
  const nodeId = requested ?? (await pickSessionNode(
    asSessionTree(await rpc.request({ type: "get_tree" })),
    "Restore files and context from a checkpoint",
  ))?.id;
  if (nodeId === undefined) return;
  const answer = await vscode.window.showWarningMessage(
    "Rewind restores workspace files and Flavor context. A pre-rewind recovery point will be kept.",
    { modal: true },
    "Rewind",
  );
  if (answer !== "Rewind") return;
  await rpc.request({ type: "rewind", nodeId });
  missionControl?.refresh();
  void vscode.window.showInformationMessage("Flavor restored the selected checkpoint.", "Undo Rewind")
    .then((choice) => choice === "Undo Rewind" ? unrevert() : undefined);
}

async function fork(argument?: unknown): Promise<void> {
  const rpc = await ensureClient();
  const requested = treeItemData(argument)?.nodeId;
  const nodeId = requested ?? (await pickSessionNode(
    asSessionTree(await rpc.request({ type: "get_tree" })),
    "Fork Flavor context from a checkpoint without changing files",
  ))?.id;
  if (nodeId === undefined) return;
  await rpc.request({ type: "fork", nodeId });
  missionControl?.refresh();
  void vscode.window.showInformationMessage("Flavor forked a new context branch.");
}

async function unrevert(): Promise<void> {
  await (await ensureClient()).request({ type: "unrevert" });
  missionControl?.refresh();
  void vscode.window.showInformationMessage("The last Flavor rewind was undone.");
}

async function refreshViews(): Promise<void> {
  missionControl?.refresh();
}

async function openFile(argument?: unknown): Promise<void> {
  const data = treeItemData(argument);
  const uri = data?.uri ?? (data?.path === undefined ? undefined : workspaceUri(data.path));
  if (uri !== undefined) await vscode.window.showTextDocument(uri);
}

async function openChange(argument?: unknown): Promise<void> {
  const data = treeItemData(argument);
  const uri = data?.uri ?? (data?.path === undefined ? undefined : workspaceUri(data.path));
  if (uri === undefined) return;
  try {
    await vscode.commands.executeCommand("git.openChange", uri);
  } catch {
    await vscode.window.showTextDocument(uri);
  }
}

function registerChatParticipant(context: vscode.ExtensionContext): void {
  if (vscode.chat?.createChatParticipant === undefined) return;
  const participant = vscode.chat.createChatParticipant("flavor-code.agent", async (request, _chatContext, stream, token) => {
    if (dashboard.snapshot().connectionMode === "terminal") {
      stream.markdown("A terminal-started Flavor session is connected. Continue that session in its terminal, or start a separate extension Agent.");
      stream.button({ command: "flavor.focusTerminal", title: "Focus Flavor terminal" });
      stream.button({ command: "flavor.start", title: "Start extension Agent" });
      return {};
    }
    const referenced = new Set<string>();
    const removeListener = onAgentEvent((event) => {
      if (event.type === "text" && typeof event.text === "string") {
        stream.markdown(event.text);
      } else if (event.type === "tool-start") {
        stream.progress(toolLabel(event));
      } else if (event.type === "loop-progress" && typeof event.message === "string") {
        stream.progress(event.message);
      } else if (event.type === "tool-end") {
        for (const path of dashboard.snapshot().footprints.map((item) => item.path)) {
          if (referenced.has(path)) continue;
          const uri = workspaceUri(path);
          if (uri !== undefined) {
            referenced.add(path);
            stream.reference(uri);
          }
        }
      } else if (event.type === "warning" && typeof event.message === "string") {
        stream.markdown(`\n\n> ${event.message}\n`);
      }
    });
    const cancel = token.onCancellationRequested(() => void stopActiveTask());
    try {
      await submitPrompt(request.prompt, { waitForDone: true });
      stream.button({ command: "flavor.review", title: "Review workspace changes" });
      stream.button({ command: "flavor.checkpoint", title: "Create checkpoint" });
      return {};
    } catch (error) {
      stream.markdown(`\n\n**Flavor stopped:** ${errorMessage(error)}`);
      return { errorDetails: { message: errorMessage(error) } };
    } finally {
      removeListener();
      cancel.dispose();
    }
  });
  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "flavor.png");
  context.subscriptions.push(participant);
}

function dispatchEvent(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const event = value as Record<string, unknown>;
  dashboard.accept(event);
  renderEvent(event);
  missionControl?.refresh();
  for (const listener of eventListeners) listener(event);
}

function renderEvent(event: Record<string, unknown>): void {
  if (event.type === "text" && typeof event.text === "string") output.append(event.text);
  else if (event.type === "notice" && typeof event.message === "string") output.appendLine(event.message);
  else if (event.type === "tool-start") output.appendLine(`\n▶ ${toolLabel(event)}`);
  else if (event.type === "tool-end") output.appendLine(`✓ ${String(event.name ?? "tool")}`);
  else if (event.type === "warning" && typeof event.message === "string") output.appendLine(`Warning: ${event.message}`);
  else if (event.type === "error") {
    output.appendLine(`Error: ${JSON.stringify(event.error)}`);
    status.text = "$(error) Flavor";
    status.tooltip = "Flavor needs attention";
  } else if (event.type === "done") {
    status.text = "$(check) Flavor";
    status.tooltip = "Flavor task completed";
    const changed = dashboard.snapshot().footprints.some((item) => item.action === "changed");
    if (changed) {
      void vscode.window.showInformationMessage("Flavor completed the task.", "Review changes", "Create checkpoint")
        .then((choice) => {
          if (choice === "Review changes") return vscode.commands.executeCommand("flavor.review");
          if (choice === "Create checkpoint") return vscode.commands.executeCommand("flavor.checkpoint");
          return undefined;
        });
    }
  }
}

function waitForTerminal(): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const remove = onAgentEvent((event) => {
      if (event.type === "done") {
        remove();
        resolvePromise();
      } else if (event.type === "error") {
        remove();
        reject(new Error(errorMessage(event.error)));
      }
    });
  });
}

function onAgentEvent(listener: (event: Record<string, unknown>) => void): () => void {
  eventListeners.add(listener);
  return () => eventListeners.delete(listener);
}

async function editorForInput(input: SymbolCommandInput | undefined): Promise<vscode.TextEditor | undefined> {
  if (input?.uri !== undefined) return vscode.window.showTextDocument(input.uri, { selection: input.range, preserveFocus: true });
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) void vscode.window.showInformationMessage("Open a source file first.");
  return editor;
}

async function pickSessionNode(nodes: SessionTreeNode[], placeHolder: string): Promise<SessionTreeNode | undefined> {
  const item = await vscode.window.showQuickPick(nodes.map((node) => ({
    label: node.label ?? node.prompt?.slice(0, 100) ?? node.id,
    description: node.id,
    node,
  })), { placeHolder });
  return item?.node;
}

function asSessionTree(value: unknown): SessionTreeNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): SessionTreeNode[] => {
    if (typeof candidate !== "object" || candidate === null || !("id" in candidate) || typeof candidate.id !== "string") return [];
    return [candidate as SessionTreeNode];
  });
}

function treeItemData(value: unknown): FlavorTreeItem | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  if ("flavor" in value && typeof value.flavor === "object" && value.flavor !== null) {
    return value.flavor as FlavorTreeItem;
  }
  if ("kind" in value) return value as FlavorTreeItem;
  return undefined;
}

function relativePath(folder: vscode.WorkspaceFolder, uri: vscode.Uri): string {
  return relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/");
}

function workspaceUri(path: string): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) return undefined;
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith("/")) return vscode.Uri.file(path);
  return vscode.Uri.joinPath(folder.uri, path.replace(/:\d+(?::\d+)?$/, ""));
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

function toolLabel(event: Record<string, unknown>): string {
  const name = String(event.name ?? "tool");
  return typeof event.label === "string" ? `${name}: ${event.label}` : name;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function syncConnectionUi(): void {
  const state = dashboard.snapshot();
  void vscode.commands.executeCommand("setContext", "flavor.connectionMode", state.connectionMode);
  if (state.connectionMode === "terminal") {
    status.command = "flavor.focusTerminal";
    status.text = "$(terminal) Flavor";
    status.tooltip = "Focus the connected terminal Flavor session";
  } else if (state.connectionMode === "none") {
    status.command = "flavor.start";
    status.text = "$(circle-slash) Flavor";
    status.tooltip = "Start Flavor";
  } else {
    status.command = "flavor.ask";
    status.text = "$(sparkle) Flavor";
    status.tooltip = state.connectionMode === "both" ? "Ask the extension Agent; a terminal session is also connected" : "Ask Flavor";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

async function stopClient(): Promise<void> {
  const active = client;
  client = undefined;
  await active?.dispose().catch(() => undefined);
  child?.kill();
  child = undefined;
  await ideBridge?.dispose();
  ideBridge = undefined;
  dashboard.setConnection(false);
  missionControl?.refresh();
  syncConnectionUi();
}
