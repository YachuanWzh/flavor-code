import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { relative } from "node:path";
import * as vscode from "vscode";

import { diagnosticsPrompt, selectionPrompt } from "./prompts.js";
import { FlavorIdeBridge } from "./ide-bridge.js";
import { FlavorRpcClient } from "./rpc-client.js";

let child: ChildProcessWithoutNullStreams | undefined;
let client: FlavorRpcClient | undefined;
let output: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let ideBridge: FlavorIdeBridge | undefined;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Flavor Code");
  ideBridge = new FlavorIdeBridge(context, output);
  void ideBridge.start().catch((error: unknown) => {
    output.appendLine(`IDE bridge failed to start: ${error instanceof Error ? error.message : String(error)}`);
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "flavor.start";
  status.text = "$(sparkle) Flavor";
  status.tooltip = "Start Flavor coding agent";
  status.show();

  const command = (name: string, handler: () => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(name, handler));
  command("flavor.start", () => ensureClient());
  command("flavor.selection", runSelection);
  command("flavor.diagnostics", fixDiagnostics);
  command("flavor.steer", () => sendText("steer", "Steer the active Flavor task"));
  command("flavor.followUp", () => sendText("follow_up", "Queue a follow-up Flavor task"));
  command("flavor.stop", async () => { await (await ensureClient()).request({ type: "abort" }); });
  command("flavor.checkpoint", checkpoint);
  command("flavor.tree", showTree);
  command("flavor.rewind", rewind);
  context.subscriptions.push(output, status, { dispose: () => void stopClient() });
}

export async function deactivate(): Promise<void> {
  await stopClient();
}

async function ensureClient(): Promise<FlavorRpcClient> {
  if (client !== undefined) return client;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("Open a workspace before starting Flavor");
  const executable = vscode.workspace.getConfiguration("flavorCode").get<string>("executable", "flavor");
  child = spawn(executable, ["--mode", "rpc", "--workspace", folder.uri.fsPath], {
    cwd: folder.uri.fsPath,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk) => output.append(chunk.toString()));
  child.once("exit", (code) => {
    output.appendLine(`Flavor process exited (${code ?? "signal"}).`);
    client = undefined;
    child = undefined;
    status.text = "$(circle-slash) Flavor";
  });
  client = new FlavorRpcClient({ input: child.stdout, output: child.stdin });
  client.onEvent(renderEvent);
  status.text = "$(sync~spin) Flavor";
  await client.request({ type: "get_state" });
  status.text = "$(sparkle) Flavor";
  output.show(true);
  return client;
}

async function runSelection(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (editor === undefined || folder === undefined || editor.selection.isEmpty) {
    void vscode.window.showInformationMessage("Select code in a workspace editor first.");
    return;
  }
  const selection = editor.document.getText(editor.selection);
  const prompt = selectionPrompt({
    relativePath: relative(folder.uri.fsPath, editor.document.uri.fsPath).replaceAll("\\", "/"),
    startLine: editor.selection.start.line + 1,
    endLine: editor.selection.end.line + 1,
    selection,
  });
  await (await ensureClient()).request({ type: "prompt", message: prompt });
}

async function fixDiagnostics(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder === undefined) throw new Error("Open a workspace first");
  const diagnostics = vscode.languages.getDiagnostics()
    .flatMap(([uri, entries]) => entries.map((entry) => ({
      relativePath: relative(folder.uri.fsPath, uri.fsPath).replaceAll("\\", "/"),
      line: entry.range.start.line + 1,
      severity: vscode.DiagnosticSeverity[entry.severity] ?? String(entry.severity),
      message: entry.message,
    })));
  if (diagnostics.length === 0) {
    void vscode.window.showInformationMessage("VS Code reports no diagnostics.");
    return;
  }
  await (await ensureClient()).request({ type: "prompt", message: diagnosticsPrompt(diagnostics) });
}

async function sendText(type: "steer" | "follow_up", placeHolder: string): Promise<void> {
  const message = await vscode.window.showInputBox({ placeHolder, ignoreFocusOut: true });
  if (message?.trim()) await (await ensureClient()).request({ type, message });
}

async function checkpoint(): Promise<void> {
  const label = await vscode.window.showInputBox({ placeHolder: "Checkpoint label (optional)" });
  const data = await (await ensureClient()).request({
    type: "checkpoint",
    ...(label?.trim() ? { label: label.trim() } : {}),
  });
  output.appendLine(`Checkpoint: ${JSON.stringify(data)}`);
}

async function showTree(): Promise<void> {
  const tree = await (await ensureClient()).request({ type: "get_tree" });
  output.appendLine(JSON.stringify(tree, null, 2));
  output.show(true);
}

async function rewind(): Promise<void> {
  const tree = await (await ensureClient()).request({ type: "get_tree" }) as Array<{ id: string; prompt?: string }>;
  const item = await vscode.window.showQuickPick(tree.map((node) => ({
    label: node.id,
    description: node.prompt?.slice(0, 100),
    nodeId: node.id,
  })), { placeHolder: "Choose a Flavor session node to restore" });
  if (item !== undefined) await (await ensureClient()).request({ type: "rewind", nodeId: item.nodeId });
}

function renderEvent(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const event = value as Record<string, unknown>;
  if (event.type === "text" && typeof event.text === "string") output.append(event.text);
  else if (event.type === "notice" && typeof event.message === "string") output.appendLine(event.message);
  else if (event.type === "tool-start") output.appendLine(`\n▶ ${String(event.name ?? "tool")}`);
  else if (event.type === "tool-end") output.appendLine(`✓ ${String(event.name ?? "tool")}`);
  else if (event.type === "warning" && typeof event.message === "string") output.appendLine(`Warning: ${event.message}`);
  else if (event.type === "error") output.appendLine(`Error: ${JSON.stringify(event.error)}`);
  else if (event.type === "done") status.text = "$(check) Flavor";
  output.show(true);
}

async function stopClient(): Promise<void> {
  const active = client;
  client = undefined;
  await active?.dispose().catch(() => undefined);
  child?.kill();
  child = undefined;
  await ideBridge?.dispose();
  ideBridge = undefined;
}
