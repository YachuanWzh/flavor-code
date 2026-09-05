import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, constants, readFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

import { prepareSpawnInvocation } from "../utils/spawn-executable.js";
import type { ToolDefinition } from "./types.js";
import { waitWithSignal } from "../utils/abort.js";
import { terminateProcessTree } from "../utils/process-tree.js";

// ---------------------------------------------------------------------------
// LSP protocol types (subset used by the tools)
// ---------------------------------------------------------------------------

interface LspLocation {
  uri: string;
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LspHover {
  contents: { kind?: string; language?: string; value: string } | string | Array<string | { language: string; value: string }>;
  range?: { start: { line: number; character: number }; end: { line: number; character: number } };
}

interface LspDiagnostic {
  range: { start: { line: number; character: number }; end: { line: number; character: number } };
  severity: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  message: string;
  source?: string;
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 over stdio
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcServerRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcServerResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

type PendingCall = {
  resolve(value: unknown): void;
  reject(error: Error): void;
};

const LSP_REQUEST_TIMEOUT_MS = 15_000;

class LspConnection {
  readonly #process: ChildProcess;
  readonly #buffer = new LspBuffer();
  readonly #pending = new Map<number, PendingCall>();
  readonly #documents = new Map<string, { text: string; version: number }>();
  readonly #documentSyncs = new Map<string, Promise<void>>();
  #nextId = 1;
  #disposed = false;
  #initError: Error | undefined;
  #shutdownPromise: Promise<void> | undefined;

  constructor(command: string, args: string[], cwd: string) {
    const invocation = prepareSpawnInvocation(command, args, { cwd });
    this.#process = spawn(invocation.command, invocation.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });

    this.#process.on("error", (err) => {
      this.#initError = new Error(`LSP server "${command}" failed to start: ${err.message}`);
      this.#rejectAll(this.#initError);
    });

    this.#process.once("exit", (code, signal) => {
      const reason = signal !== null
        ? `LSP server "${command}" exited with signal ${signal}`
        : `LSP server "${command}" exited with code ${code}`;
      this.#initError = new Error(reason);
      this.#rejectAll(this.#initError);
    });

    this.#process.stdout!.on("data", (chunk: Buffer) => this.#buffer.feed(chunk, this.#onMessage));
    this.#process.stderr!.resume(); // Servers can log enough to fill the pipe.
    this.#process.stdin!.on("error", (error) => { this.#initError = error; this.#rejectAll(error); });
  }

  async initialize(rootUri: string): Promise<void> {
    if (this.#initError !== undefined) throw this.#initError;

    const initResult = await this.#request("initialize", {
      processId: process.pid,
      rootUri,
      capabilities: {
        textDocument: {
          hover: { contentFormat: ["markdown", "plaintext"] },
          references: {},
          publishDiagnostics: { relatedInformation: true },
        },
        workspace: {
          configuration: true,
          diagnostics: { refreshSupport: true },
        },
      },
    });

    if (initResult === undefined) throw new Error("LSP initialize returned no capabilities");
    this.#notify("initialized", {});
  }

  async findReferences(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspLocation[]> {
    signal?.throwIfAborted();
    await this.#syncDocument(uri);
    const result = await this.#request("textDocument/references", {
      textDocument: { uri },
      position: { line, character },
      context: { includeDeclaration: false },
    }, signal);
    if (result === null || result === undefined) return [];
    if (!Array.isArray(result)) return [];
    return result.filter(isLocation);
  }

  async hover(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspHover | null> {
    signal?.throwIfAborted();
    await this.#syncDocument(uri);
    const result = await this.#request("textDocument/hover", {
      textDocument: { uri },
      position: { line, character },
    }, signal);
    if (result === null || result === undefined) return null;
    if (typeof result === "object" && "contents" in (result as Record<string, unknown>)) {
      return result as LspHover;
    }
    return null;
  }

  async diagnostics(uri: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    signal?.throwIfAborted();
    await this.#syncDocument(uri);
    const result = await this.#request("textDocument/diagnostic", {
      textDocument: { uri },
    }, signal);
    if (result === null || result === undefined) return [];
    const items = (result as Record<string, unknown>)?.items ?? result;
    if (!Array.isArray(items)) return [];
    return items.filter(isDiagnostic);
  }

  shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) return this.#shutdownPromise;
    this.#disposed = true;
    // Dispose must also work for a server that never completed initialization.
    this.#rejectAll(new Error("LSP connection disposed"));
    this.#shutdownPromise = (async () => {
      await terminateProcessTree(this.#process.pid);
      this.#process.stdin!.destroy();
      this.#process.stdout!.destroy();
      this.#process.stderr!.destroy();
    })();
    return this.#shutdownPromise;
  }

  // -- JSON-RPC core -------------------------------------------------------

  async #request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.#disposed) throw new Error("LSP connection disposed");
    if (this.#initError !== undefined) throw this.#initError;
    signal?.throwIfAborted();
    const id = this.#nextId++;
    const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };

    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      timer = setTimeout(() => reject(new Error(`LSP request "${method}" timed out after ${LSP_REQUEST_TIMEOUT_MS}ms`)), LSP_REQUEST_TIMEOUT_MS);
      timer.unref();
      onAbort = () => {
        try { this.#notify("$/cancelRequest", { id }); } catch { /* The server may already have exited. */ }
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try { this.#send(request); return await promise; }
    finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
      this.#pending.delete(id);
    }
  }

  #notify(method: string, params: unknown): void {
    const notification: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.#send(notification);
  }

  #send(message: JsonRpcRequest | JsonRpcNotification | JsonRpcServerResponse): void {
    const body = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    this.#process.stdin!.write(header + body);
  }

  #onMessage = (body: string): void => {
    let parsed: JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;
    try { parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest; }
    catch { return; }
    if (typeof parsed !== "object" || parsed === null) return;
    if ("method" in parsed) {
      if ("id" in parsed) this.#handleServerRequest(parsed);
      return; // notification from server, ignore
    }
    const pending = this.#pending.get(parsed.id);
    if (pending === undefined) return;
    this.#pending.delete(parsed.id);
    if (parsed.error !== undefined) {
      pending.reject(new Error(`LSP error ${parsed.error.code}: ${parsed.error.message}`));
    } else {
      pending.resolve(parsed.result);
    }
  };

  #handleServerRequest(request: JsonRpcServerRequest): void {
    let result: unknown = null;
    if (request.method === "workspace/configuration") {
      const items = (request.params as { items?: unknown[] } | undefined)?.items;
      result = Array.isArray(items) ? items.map(() => null) : [];
    }
    this.#send({ jsonrpc: "2.0", id: request.id, result });
  }

  async #syncDocument(uri: string): Promise<void> {
    const pending = this.#documentSyncs.get(uri);
    if (pending !== undefined) return pending;

    const sync = this.#syncDocumentNow(uri);
    this.#documentSyncs.set(uri, sync);
    try {
      await sync;
    } finally {
      this.#documentSyncs.delete(uri);
    }
  }

  async #syncDocumentNow(uri: string): Promise<void> {
    const url = new URL(uri);
    if (url.protocol !== "file:") return;

    const filePath = fileURLToPath(url);
    const text = await readFile(filePath, "utf8");
    const current = this.#documents.get(uri);
    if (current === undefined) {
      this.#documents.set(uri, { text, version: 1 });
      this.#notify("textDocument/didOpen", {
        textDocument: {
          uri,
          languageId: languageIdForPath(filePath),
          version: 1,
          text,
        },
      });
      return;
    }
    if (current.text === text) return;

    const version = current.version + 1;
    this.#documents.set(uri, { text, version });
    this.#notify("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }

  #rejectAll(error: Error): void {
    for (const [, pending] of this.#pending) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

// ---------------------------------------------------------------------------
// LSP message framing (Content-Length: <N>\r\n\r\n<body>)
// ---------------------------------------------------------------------------

class LspBuffer {
  #data = Buffer.alloc(0);

  feed(chunk: Buffer, onMessage: (body: string) => void): void {
    this.#data = Buffer.concat([this.#data, chunk]);
    while (true) {
      const headerEnd = this.#data.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.#data.toString("utf8", 0, headerEnd);
      const match = header.match(/^Content-Length:\s*(\d+)/im);
      if (match === null) {
        this.#data = this.#data.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.#data.length < bodyStart + length) return;
      const body = this.#data.toString("utf8", bodyStart, bodyStart + length);
      this.#data = this.#data.subarray(bodyStart + length);
      onMessage(body);
    }
  }
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

interface LanguageServerConfig {
  language: string;
  extensions: string[];
  command: string;
  args: string[];
  rootFiles: string[];
}

const TYPESCRIPT_CLI = resolve(
  dirname(fileURLToPath(import.meta.resolve("typescript/package.json"))),
  "lib",
  "tsc.js",
);

const KNOWN_SERVERS: LanguageServerConfig[] = [
  {
    language: "typescript",
    extensions: [".ts", ".tsx", ".mts", ".cts"],
    command: process.execPath,
    args: [TYPESCRIPT_CLI, "--lsp", "--stdio"],
    rootFiles: ["tsconfig.json", "jsconfig.json"],
  },
  {
    language: "python",
    extensions: [".py", ".pyi", ".pyx"],
    command: "pyright-langserver",
    args: ["--stdio"],
    rootFiles: ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json"],
  },
  {
    language: "rust",
    extensions: [".rs"],
    command: "rust-analyzer",
    args: [],
    rootFiles: ["Cargo.toml"],
  },
  {
    language: "go",
    extensions: [".go"],
    command: "gopls",
    args: [],
    rootFiles: ["go.mod", "go.work"],
  },
];

export interface LspManager {
  findReferences(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspLocation[]>;
  hover(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspHover | null>;
  diagnostics(uri: string, signal?: AbortSignal): Promise<LspDiagnostic[]>;
  dispose(): void | Promise<void>;
}

export class RealLspManager implements LspManager {
  #disposed = false;
  #disposal: Promise<void> | undefined;
  readonly #workspace: string;
  readonly #connections = new Map<string, LspConnection>();
  readonly #pendingStarts = new Map<string, Promise<LspConnection>>();
  readonly #serverConfigs: LanguageServerConfig[];
  readonly #onStatus: ((message: string) => void) | undefined;

  constructor(options: { workspace: string; serverConfigs?: LanguageServerConfig[]; onStatus?: ((message: string) => void) | undefined }) {
    this.#workspace = resolve(options.workspace);
    this.#serverConfigs = options.serverConfigs ?? KNOWN_SERVERS;
    this.#onStatus = options.onStatus;
  }

  dispose(): Promise<void> {
    if (this.#disposal !== undefined) return this.#disposal;
    this.#disposed = true;
    const shutdowns = [...this.#connections.values()].map((connection) => connection.shutdown());
    // Starts already in flight observe #disposed and shut themselves down.
    shutdowns.push(...[...this.#pendingStarts.values()].map(async (start) => { const connection = await start; await connection.shutdown(); }));
    this.#connections.clear();
    this.#pendingStarts.clear();
    this.#disposal = Promise.allSettled(shutdowns).then(() => undefined);
    return this.#disposal;
  }

  async findReferences(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspLocation[]> {
    signal?.throwIfAborted();
    const connection = await waitWithSignal(this.#getConnection(uri), signal);
    return connection.findReferences(uri, line, character, signal);
  }

  async hover(uri: string, line: number, character: number, signal?: AbortSignal): Promise<LspHover | null> {
    signal?.throwIfAborted();
    const connection = await waitWithSignal(this.#getConnection(uri), signal);
    return connection.hover(uri, line, character, signal);
  }

  async diagnostics(uri: string, signal?: AbortSignal): Promise<LspDiagnostic[]> {
    signal?.throwIfAborted();
    const connection = await waitWithSignal(this.#getConnection(uri), signal);
    return connection.diagnostics(uri, signal);
  }

  #languageForUri(uri: string): string | undefined {
    try {
      const url = new URL(uri);
      const filePath = url.protocol === "file:" ? decodeURIComponent(url.pathname) : uri;
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      for (const config of this.#serverConfigs) {
        if (config.extensions.includes(ext)) return config.language;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async #getConnection(uri: string): Promise<LspConnection> {
    if (this.#disposed) throw new Error("LSP manager is disposed");
    const language = this.#languageForUri(uri);
    if (language === undefined) throw new Error(`No language server configured for ${uri}; use Read/Grep or the project compiler`);
    const existing = this.#connections.get(language);
    if (existing !== undefined) return existing;
    const pending = this.#pendingStarts.get(language);
    if (pending !== undefined) return pending;

    const config = this.#serverConfigs.find((c) => c.language === language);
    if (config === undefined) throw new Error(`No language server configured for ${language}`);

    // Only start if the project has the root file for this language
    const hasRoot = config.rootFiles.some((file) => existsSync(resolve(this.#workspace, file)));
    if (!hasRoot) throw new Error(`Cannot start ${language} language server: workspace needs ${config.rootFiles.join(" or ")}`);

    const startPromise = this.#startServer(config);
    this.#pendingStarts.set(language, startPromise);
    try {
      const connection = await startPromise;
      if (this.#disposed) { await connection.shutdown(); throw new Error("LSP manager is disposed"); }
      this.#connections.set(language, connection);
      return connection;
    } finally {
      this.#pendingStarts.delete(language);
    }
  }

  async #startServer(config: LanguageServerConfig): Promise<LspConnection> {
    // Verify the server binary exists (best-effort)
    try { await access(config.command, constants.X_OK); }
    catch { /* PATH resolution will happen in spawn; if it fails, spawn errors surface */ }

    const connection = new LspConnection(config.command, config.args, this.#workspace);
    const rootUri = pathToFileURL(this.#workspace).href;
    try {
      await connection.initialize(rootUri);
      this.#onStatus?.(`${config.language} Language Server ready (${config.command})`);
    } catch (error) {
      await connection.shutdown();
      this.#onStatus?.(`${config.language} Language Server failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    return connection;
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const LspFindRefsInput = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().nonnegative().describe("Zero-based line number (first line is 0)."),
  character: z.coerce.number().int().nonnegative().describe("Zero-based UTF-16 character offset."),
});

const LspHoverInput = z.object({
  file: z.string().min(1),
  line: z.coerce.number().int().nonnegative().describe("Zero-based line number (first line is 0)."),
  character: z.coerce.number().int().nonnegative().describe("Zero-based UTF-16 character offset."),
});

const LspDiagnosticsInput = z.object({
  file: z.string().min(1),
});

export interface LspToolOptions {
  manager?: LspManager;
  onStatus?: (message: string) => void;
}

export function createLspTools(workspace: string, options: LspToolOptions = {}): ToolDefinition<unknown>[] {
  const root = resolve(workspace);
  const manager = options.manager ?? new RealLspManager({ workspace: root, onStatus: options.onStatus });

  const guard = (input: string): string => {
    const candidate = resolve(root, input);
    if (!isWithin(root, candidate)) throw new Error("Path is outside the workspace");
    return candidate;
  };

  const toUri = (filePath: string): string => pathToFileURL(filePath).href;

  const langTag = (file: string): string => {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const map: Record<string, string> = { '.ts':'ts','.tsx':'tsx','.mts':'ts','.cts':'ts','.py':'py','.pyi':'py','.pyx':'py','.rs':'rs','.go':'go' };
    const tag = map[ext];
    return tag === undefined ? '' : ' [' + tag + ']';
  };

  const findRefs: ToolDefinition<z.infer<typeof LspFindRefsInput>> = {
    name: "LspFindRefs",
    description: "Find all references to a symbol at a file position using the Language Server Protocol",
    inputSchema: LspFindRefsInput,
    paths: (input) => [guard(input.file)],
    summarize: (input) => `${basename(input.file)}:${input.line}:${input.character}${langTag(input.file)}`,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const path = guard(input.file);
      const uri = toUri(path);
      const refs = await waitWithSignal(manager.findReferences(uri, input.line, input.character, signal), signal);
      if (refs.length === 0) return `No references found at ${input.file}:${input.line}:${input.character}`;
      return refs.map((loc) => {
        const filePath = uriToPath(loc.uri);
        return `${filePath}:${loc.range.start.line}:${loc.range.start.character}`;
      }).join("\n");
    },
  };

  const hover: ToolDefinition<z.infer<typeof LspHoverInput>> = {
    name: "LspHover",
    description: "Get type information and documentation for a symbol at a file position using LSP",
    inputSchema: LspHoverInput,
    paths: (input) => [guard(input.file)],
    summarize: (input) => `${basename(input.file)}:${input.line}:${input.character}${langTag(input.file)}`,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const path = guard(input.file);
      const uri = toUri(path);
      const info = await waitWithSignal(manager.hover(uri, input.line, input.character, signal), signal);
      if (info === null) return `No hover information at ${input.file}:${input.line}:${input.character}`;
      const parts = Array.isArray(info.contents) ? info.contents : [info.contents];
      const contents = parts.map((part) => typeof part === "string" ? part : part.value).join("\n\n");
      return contents;
    },
  };

  const diagnostics: ToolDefinition<z.infer<typeof LspDiagnosticsInput>> = {
    name: "LspDiagnostics",
    description: "Read compiler and linter diagnostics for a file using LSP",
    inputSchema: LspDiagnosticsInput,
    paths: (input) => [guard(input.file)],
    summarize: (input) => `${basename(input.file)}${langTag(input.file)}`,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const path = guard(input.file);
      const uri = toUri(path);
      const diags = await waitWithSignal(manager.diagnostics(uri, signal), signal);
      if (diags.length === 0) return `No diagnostics for ${input.file}`;
      return diags.map((d) => {
        const severity = severityLabel(d.severity);
        const source = d.source !== undefined ? ` (${d.source})` : "";
        return `[${severity}] line ${d.range.start.line}:${d.range.start.character}${source}: ${d.message}`;
      }).join("\n");
    },
  };

  return [findRefs, hover, diagnostics];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function languageIdForPath(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".tsx": return "typescriptreact";
    case ".mts": return "typescript";
    case ".cts": return "typescript";
    case ".py": case ".pyi": case ".pyx": return "python";
    case ".rs": return "rust";
    case ".go": return "go";
    default: return "typescript";
  }
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function uriToPath(uri: string): string {
  try {
    const url = new URL(uri);
    if (url.protocol === "file:") return fileURLToPath(url);
  } catch { /* fall through */ }
  return uri;
}

function isLocation(value: unknown): value is LspLocation {
  return typeof value === "object" && value !== null
    && "uri" in value && "range" in value;
}

function isDiagnostic(value: unknown): value is LspDiagnostic {
  return typeof value === "object" && value !== null
    && "message" in value && "range" in value;
}

function severityLabel(severity: number): string {
  switch (severity) {
    case 1: return "ERROR";
    case 2: return "WARNING";
    case 3: return "INFO";
    case 4: return "HINT";
    default: return "UNKNOWN";
  }
}
