import { createHash, randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server, type Socket } from "node:net";

const MAX_REQUEST_BYTES = 64 * 1024;
const SOCKET_TIMEOUT_MS = 10_000;

export interface IslandControllableSession {
  steer(message: string): void;
  followUp(message: string): void;
  interrupt(): "cancelled" | "exit";
}

export interface IslandControlServerOptions {
  sessionId: string;
  session: IslandControllableSession;
  focus?: () => void | Promise<void>;
  endpoint?: string;
  token?: string;
  platform?: NodeJS.Platform;
}

export interface IslandControlServer {
  readonly endpoint: string;
  readonly token: string;
  readonly capabilities: readonly ("abort" | "steer" | "follow_up" | "focus")[];
  close(): Promise<void>;
}

export function islandControlEndpoint(
  sessionId: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const digest = createHash("sha256").update(`${process.pid}\0${sessionId}`).digest("hex").slice(0, 20);
  if (platform === "win32") return `\\\\.\\pipe\\flavor-island-control-${digest}`;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `flavor-island-control-${uid}-${digest}.sock`);
}

export async function createIslandControlServer(options: IslandControlServerOptions): Promise<IslandControlServer> {
  const platform = options.platform ?? process.platform;
  const endpoint = options.endpoint ?? islandControlEndpoint(options.sessionId, platform);
  const token = options.token ?? randomUUID();
  const capabilities: IslandControlServer["capabilities"] = [
    "abort", "steer", "follow_up", ...(options.focus === undefined ? [] : ["focus" as const]),
  ];
  if (platform !== "win32") await unlink(endpoint).catch(() => undefined);

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let buffer = Buffer.alloc(0);
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      if (buffer.length + bytes.length > MAX_REQUEST_BYTES) {
        handled = true;
        write(socket, { ok: false, error: "request_too_large" });
        return;
      }
      buffer = Buffer.concat([buffer, bytes]);
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      handled = true;
      const line = buffer.subarray(0, newline).toString("utf8");
      void dispatch(line, socket, options, token);
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
    const onListening = () => { server.removeListener("error", onError); resolve(); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
  if (platform !== "win32") await chmod(endpoint, 0o600).catch(() => undefined);

  let closed = false;
  return {
    endpoint,
    token,
    capabilities,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await closeServer(server);
      if (platform !== "win32") await unlink(endpoint).catch(() => undefined);
    },
  };
}

async function dispatch(
  line: string,
  socket: Socket,
  options: IslandControlServerOptions,
  token: string,
): Promise<void> {
  let request: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("invalid request");
    request = parsed as Record<string, unknown>;
  } catch {
    write(socket, { ok: false, error: "invalid_json" });
    return;
  }
  if (request.token !== token) { write(socket, { ok: false, error: "unauthorized" }); return; }
  const command = request.command;
  try {
    if (command === "abort") {
      write(socket, { ok: true, result: options.session.interrupt() });
    } else if (command === "steer" || command === "follow_up") {
      const message = typeof request.message === "string" ? request.message.trim() : "";
      if (!message || message.length > 100_000) { write(socket, { ok: false, error: "invalid_message" }); return; }
      if (command === "steer") options.session.steer(message);
      else options.session.followUp(message);
      write(socket, { ok: true });
    } else if (command === "focus") {
      if (options.focus === undefined) { write(socket, { ok: false, error: "focus_unavailable" }); return; }
      await options.focus();
      write(socket, { ok: true });
    } else {
      write(socket, { ok: false, error: "unknown_command" });
    }
  } catch (error) {
    write(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function write(socket: Socket, payload: unknown): void {
  try { socket.end(`${JSON.stringify(payload)}\n`); }
  catch { socket.destroy(); }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    try { server.close(() => resolve()); }
    catch { resolve(); }
  });
}
