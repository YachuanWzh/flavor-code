import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as vscode from "vscode";

export class FlavorIdeBridge {
  readonly #context: vscode.ExtensionContext;
  readonly #output: vscode.OutputChannel;
  #server: Server | undefined;
  #lockfile: string | undefined;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel) {
    this.#context = context;
    this.#output = output;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return;
    const authToken = randomBytes(32).toString("hex");
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");
      if (request.headers.authorization !== `Bearer ${authToken}`) {
        response.writeHead(401).end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (request.method !== "GET") {
        response.writeHead(405).end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      if (request.url === "/health") {
        response.writeHead(200).end(JSON.stringify({ ok: true, protocolVersion: 1 }));
        return;
      }
      if (request.url === "/context") {
        response.writeHead(200).end(JSON.stringify(editorContext()));
        return;
      }
      response.writeHead(404).end(JSON.stringify({ error: "not_found" }));
    });
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolvePromise();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Flavor IDE bridge did not receive a TCP port");
    }
    this.#server = server;
    const port = address.port;
    const directory = join(homedir(), ".flavor-code", "ide");
    await mkdir(directory, { recursive: true });
    this.#lockfile = join(directory, `${port}.lock`);
    const lock = {
      protocolVersion: 1,
      transport: "http",
      port,
      pid: process.pid,
      ideName: vscode.env.appName,
      workspaceFolders: workspaceFolders(),
      authToken,
    };
    await writeFile(this.#lockfile, JSON.stringify(lock), { encoding: "utf8", mode: 0o600 });
    const environment = this.#context.environmentVariableCollection;
    environment.replace("FLAVOR_CODE_IDE_PORT", String(port));
    environment.replace("FLAVOR_CODE_IDE_TOKEN", authToken);
    environment.replace("FLAVOR_CODE_IDE_NAME", vscode.env.appName);
    environment.description = "Lets Flavor sessions launched in this workspace connect to VS Code.";
    this.#output.appendLine(`IDE bridge listening on 127.0.0.1:${port}.`);
  }

  async dispose(): Promise<void> {
    this.#context.environmentVariableCollection.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
    const lockfile = this.#lockfile;
    this.#lockfile = undefined;
    if (lockfile !== undefined) await unlink(lockfile).catch(() => undefined);
  }
}

function editorContext(): Record<string, unknown> {
  const editor = vscode.window.activeTextEditor;
  const folders = workspaceFolders();
  if (editor === undefined) {
    return {
      ideName: vscode.env.appName,
      workspaceFolders: folders,
      selection: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
        active: { line: 0, character: 0 },
        isEmpty: true,
      },
    };
  }
  const selection = editor.selection;
  return {
    ideName: vscode.env.appName,
    workspaceFolders: folders,
    ...(editor.document.uri.scheme === "file" ? { filePath: editor.document.uri.fsPath } : {}),
    languageId: editor.document.languageId,
    dirty: editor.document.isDirty,
    selection: {
      start: point(selection.start),
      end: point(selection.end),
      active: point(selection.active),
      isEmpty: selection.isEmpty,
    },
    ...(!selection.isEmpty ? { selectedText: editor.document.getText(selection).slice(0, 100_000) } : {}),
  };
}

function point(position: vscode.Position): { line: number; character: number } {
  return { line: position.line, character: position.character };
}

function workspaceFolders(): string[] {
  return vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
}
