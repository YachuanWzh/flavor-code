import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";

export interface IdePosition {
  line: number;
  character: number;
}

export interface IdeEditorContext {
  ideName: string;
  workspaceFolders: string[];
  filePath?: string;
  languageId?: string;
  dirty?: boolean;
  selection: {
    start: IdePosition;
    end: IdePosition;
    active: IdePosition;
    isEmpty: boolean;
  };
  selectedText?: string;
}

interface IdeLockfile {
  port: number;
  pid?: number;
  ideName: string;
  workspaceFolders: string[];
  authToken: string;
  transport: "http";
}

export interface FlavorIdeClientOptions {
  workspace: string;
  home: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export class FlavorIdeClient {
  readonly #workspace: string;
  readonly #home: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: typeof fetch;
  #connection: IdeLockfile | undefined;
  #lastDiscoveryAt = 0;
  #sessionId: string | undefined;
  #eventTail: Promise<void> = Promise.resolve();

  constructor(options: FlavorIdeClientOptions) {
    this.#workspace = resolve(options.workspace);
    this.#home = resolve(options.home);
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? fetch;
  }

  async initialize(): Promise<void> {
    this.#connection = await this.#discover();
    this.#lastDiscoveryAt = Date.now();
  }

  async status(): Promise<string> {
    const result = await this.#editorContextResult();
    if (result === undefined) {
      return "No matching Flavor IDE extension detected. Open this workspace in VS Code with the Flavor Code extension enabled.";
    }
    const { connection, context } = result;
    if (context === undefined) {
      return `Detected ${connection.ideName}, but its IDE bridge is not responding.`;
    }
    if (context.filePath === undefined) return `Connected to ${connection.ideName}. No file editor is active.`;
    const cursor = context.selection.active;
    const selected = context.selection.isEmpty
      ? ""
      : `; selected lines ${context.selection.start.line + 1}-${context.selection.end.line + 1}`;
    return `Connected to ${connection.ideName}: ${relativeDisplay(this.#workspace, context.filePath)}:${cursor.line + 1}:${cursor.character + 1}${selected}.`;
  }

  async editorContext(): Promise<IdeEditorContext | undefined> {
    return (await this.#editorContextResult())?.context;
  }

  async promptContext(): Promise<string | undefined> {
    const context = await this.editorContext();
    if (context?.filePath === undefined || !isWithin(this.#workspace, context.filePath)) return undefined;
    const path = relativeDisplay(this.#workspace, context.filePath);
    const cursor = context.selection.active;
    if (context.selection.isEmpty || !context.selectedText) {
      return `<ide_opened_file path=${JSON.stringify(path)} cursor_line="${cursor.line + 1}" cursor_column="${cursor.character + 1}" />`;
    }
    const selectedText = context.selectedText.slice(0, 100_000);
    const endLine = context.selection.end.character === 0
      && context.selection.end.line > context.selection.start.line
      ? context.selection.end.line
      : context.selection.end.line + 1;
    return [
      `<ide_selection path=${JSON.stringify(path)} start_line="${context.selection.start.line + 1}" end_line="${endLine}">`,
      selectedText,
      "</ide_selection>",
    ].join("\n");
  }

  async startSession(sessionId: string): Promise<void> {
    this.#sessionId = sessionId;
    if (!this.#eventForwardingEnabled()) return;
    await this.#post("/session/start", {
      sessionId,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
  }

  publishEvent(sessionId: string, event: unknown): void {
    if (!this.#eventForwardingEnabled()) return;
    this.#sessionId = sessionId;
    this.#eventTail = this.#eventTail
      .catch(() => undefined)
      .then(() => this.#post("/events", { sessionId, pid: process.pid, event }));
  }

  async endSession(sessionId = this.#sessionId): Promise<void> {
    if (sessionId === undefined || !this.#eventForwardingEnabled()) return;
    await this.#eventTail.catch(() => undefined);
    await this.#post("/session/end", { sessionId, pid: process.pid });
    if (this.#sessionId === sessionId) this.#sessionId = undefined;
  }

  async #getConnection(): Promise<IdeLockfile | undefined> {
    if (Date.now() - this.#lastDiscoveryAt < 1_000) return this.#connection;
    await this.initialize();
    return this.#connection;
  }

  async #editorContextResult(): Promise<{
    connection: IdeLockfile;
    context: IdeEditorContext | undefined;
  } | undefined> {
    const connection = await this.#getConnection();
    if (connection === undefined) return undefined;
    return { connection, context: await this.#requestContext(connection) };
  }

  async #discover(): Promise<IdeLockfile | undefined> {
    const configuredPort = parsePort(this.#environment.FLAVOR_CODE_IDE_PORT);
    const configuredToken = this.#environment.FLAVOR_CODE_IDE_TOKEN;
    if (configuredPort !== undefined && configuredToken) {
      const configured: IdeLockfile = {
        port: configuredPort,
        ideName: this.#environment.FLAVOR_CODE_IDE_NAME ?? "VS Code",
        workspaceFolders: [this.#workspace],
        authToken: configuredToken,
        transport: "http",
      };
      if (await this.#healthy(configured)) return configured;
    }

    const directory = join(this.#home, ".flavor-code", "ide");
    let entries: string[];
    try {
      entries = (await readdir(directory)).filter((name) => name.endsWith(".lock"));
    } catch {
      return undefined;
    }
    const candidates = (await Promise.all(entries.map(async (name) => {
      const path = join(directory, name);
      try {
        const [contents, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        const lock = parseLockfile(contents);
        return lock === undefined ? undefined : { lock, modified: info.mtimeMs };
      } catch {
        return undefined;
      }
    })))
      .filter((item): item is { lock: IdeLockfile; modified: number } => item !== undefined)
      .filter(({ lock }) => lock.workspaceFolders.some((folder) => isWithin(folder, this.#workspace)))
      .sort((left, right) => right.modified - left.modified);

    for (const { lock } of candidates) {
      if (await this.#healthy(lock)) return lock;
    }
    return undefined;
  }

  async #healthy(connection: IdeLockfile): Promise<boolean> {
    try {
      const response = await this.#fetch(`http://127.0.0.1:${connection.port}/health`, {
        headers: { authorization: `Bearer ${connection.authToken}` },
        signal: AbortSignal.timeout(750),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async #requestContext(connection: IdeLockfile): Promise<IdeEditorContext | undefined> {
    try {
      const response = await this.#fetch(`http://127.0.0.1:${connection.port}/context`, {
        headers: { authorization: `Bearer ${connection.authToken}` },
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return undefined;
      return parseEditorContext(await response.json());
    } catch {
      return undefined;
    }
  }

  async #post(path: string, body: unknown): Promise<void> {
    const connection = await this.#getConnection();
    if (connection === undefined) return;
    try {
      await this.#fetch(`http://127.0.0.1:${connection.port}${path}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${connection.authToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(1_500),
      });
    } catch {
      // IDE event forwarding is best-effort and must never interrupt the agent.
    }
  }

  #eventForwardingEnabled(): boolean {
    return this.#environment.FLAVOR_CODE_IDE_EVENT_FORWARDING !== "0";
  }
}

function parseLockfile(contents: string): IdeLockfile | undefined {
  try {
    const value = JSON.parse(contents) as Record<string, unknown>;
    const port = typeof value.port === "number" ? value.port : undefined;
    const ideName = typeof value.ideName === "string" ? value.ideName : undefined;
    const workspaceFolders = Array.isArray(value.workspaceFolders)
      ? value.workspaceFolders.filter((item): item is string => typeof item === "string")
      : [];
    const authToken = typeof value.authToken === "string" ? value.authToken : undefined;
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65_535
      || ideName === undefined || authToken === undefined || workspaceFolders.length === 0
      || value.transport !== "http") return undefined;
    return { port, ideName, workspaceFolders, authToken, transport: "http" };
  } catch {
    return undefined;
  }
}

function parseEditorContext(value: unknown): IdeEditorContext | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.ideName !== "string" || !Array.isArray(input.workspaceFolders)
    || typeof input.selection !== "object" || input.selection === null) return undefined;
  const selection = input.selection as Record<string, unknown>;
  const start = position(selection.start);
  const end = position(selection.end);
  const active = position(selection.active);
  if (start === undefined || end === undefined || active === undefined || typeof selection.isEmpty !== "boolean") {
    return undefined;
  }
  const workspaceFolders = input.workspaceFolders.filter((item): item is string => typeof item === "string");
  return {
    ideName: input.ideName,
    workspaceFolders,
    selection: { start, end, active, isEmpty: selection.isEmpty },
    ...(typeof input.filePath === "string" ? { filePath: input.filePath } : {}),
    ...(typeof input.languageId === "string" ? { languageId: input.languageId } : {}),
    ...(typeof input.dirty === "boolean" ? { dirty: input.dirty } : {}),
    ...(typeof input.selectedText === "string" ? { selectedText: input.selectedText } : {}),
  };
}

function position(value: unknown): IdePosition | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const input = value as Record<string, unknown>;
  if (typeof input.line !== "number" || !Number.isInteger(input.line) || input.line < 0
    || typeof input.character !== "number" || !Number.isInteger(input.character) || input.character < 0) {
    return undefined;
  }
  return { line: input.line, character: input.character };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function isWithin(parent: string, child: string): boolean {
  const base = normalize(resolve(parent));
  const target = normalize(resolve(child));
  return target === base || target.startsWith(`${base}${sep}`);
}

function normalize(path: string): string {
  const normalized = path.normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function relativeDisplay(workspace: string, filePath: string): string {
  const path = relative(workspace, filePath).replaceAll("\\", "/");
  return path && !path.startsWith("../") ? path : basename(filePath);
}
