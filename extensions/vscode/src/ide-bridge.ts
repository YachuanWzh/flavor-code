import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import * as vscode from "vscode";

export interface ExternalFlavorSession {
  sessionId: string;
  pid?: number;
  startedAt?: string;
  lastSeenAt: string;
}

export interface FlavorIdeBridgeOptions {
  onExternalEvent?(event: unknown, session: ExternalFlavorSession): void;
  onSessionsChanged?(sessions: ExternalFlavorSession[]): void;
}

export class FlavorIdeBridge {
  readonly #context: vscode.ExtensionContext;
  readonly #output: vscode.OutputChannel;
  readonly #options: FlavorIdeBridgeOptions;
  readonly #sessions = new Map<string, ExternalFlavorSession>();
  #server: Server | undefined;
  #lockfile: string | undefined;

  constructor(context: vscode.ExtensionContext, output: vscode.OutputChannel, options: FlavorIdeBridgeOptions = {}) {
    this.#context = context;
    this.#output = output;
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server !== undefined) return;
    const authToken = randomBytes(32).toString("hex");
    const server = createServer((request, response) => {
      void this.#handle(request, response, authToken);
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
      protocolVersion: 2,
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
    if (this.#sessions.size > 0) {
      this.#sessions.clear();
      this.#notifySessions();
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse, authToken: string): Promise<void> {
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      json(response, 401, { error: "unauthorized" });
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { ok: true, protocolVersion: 2 });
      return;
    }
    if (request.method === "GET" && request.url === "/context") {
      json(response, 200, editorContext());
      return;
    }
    if (request.method === "GET" && request.url === "/sessions") {
      json(response, 200, { sessions: [...this.#sessions.values()] });
      return;
    }
    if (request.method !== "POST"
      || !["/session/start", "/events", "/session/end"].includes(request.url ?? "")) {
      json(response, request.method === "GET" ? 404 : 405, {
        error: request.method === "GET" ? "not_found" : "method_not_allowed",
      });
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = await readJson(request);
    } catch (error) {
      json(response, error instanceof BodyTooLargeError ? 413 : 400, {
        error: error instanceof BodyTooLargeError ? "body_too_large" : "invalid_json",
      });
      return;
    }
    const sessionId = typeof body.sessionId === "string" && body.sessionId.length <= 256
      ? body.sessionId
      : undefined;
    if (sessionId === undefined) {
      json(response, 400, { error: "invalid_session" });
      return;
    }

    if (request.url === "/session/end") {
      if (this.#sessions.delete(sessionId)) this.#notifySessions();
      this.#output.appendLine(`Terminal Flavor session disconnected: ${sessionId}.`);
      json(response, 200, { ok: true });
      return;
    }

    const existing = this.#sessions.get(sessionId);
    const session: ExternalFlavorSession = {
      sessionId,
      ...(typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0
        ? { pid: body.pid }
        : existing?.pid === undefined ? {} : { pid: existing.pid }),
      ...(typeof body.startedAt === "string"
        ? { startedAt: body.startedAt }
        : existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
      lastSeenAt: new Date().toISOString(),
    };
    this.#sessions.set(sessionId, session);
    if (existing === undefined) {
      this.#output.appendLine(`Terminal Flavor session connected: ${sessionId}.`);
      this.#notifySessions();
    }
    if (request.url === "/events" && "event" in body) {
      try {
        this.#options.onExternalEvent?.(body.event, session);
      } catch (error) {
        this.#output.appendLine(`Terminal Flavor event failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    json(response, 200, { ok: true });
  }

  #notifySessions(): void {
    this.#options.onSessionsChanged?.([...this.#sessions.values()]);
  }
}

class BodyTooLargeError extends Error {}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 2 * 1024 * 1024) throw new BodyTooLargeError();
    chunks.push(value);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status).end(JSON.stringify(value));
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
