import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

import type { RunningProject } from "../d2c/runner.js";

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

function sendNotFound(response: ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function isInside(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

/** Serves an AI-generated design artifact on an ephemeral loopback port for sandboxed review. */
export async function startD2cProductPreview(rootDirectory: string): Promise<RunningProject> {
  const root = await realpath(resolve(rootDirectory));
  const rootInfo = await stat(root);
  if (!rootInfo.isDirectory()) throw new Error("D2C product prototype directory is unavailable");
  const server = createServer(async (request, response) => {
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("content-security-policy", "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'");
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/index.html";
      if (pathname.includes("\0")) return sendNotFound(response);
      const unresolved = resolve(root, `.${pathname}`);
      if (!isInside(root, unresolved)) return sendNotFound(response);
      const target = await realpath(unresolved).catch(() => undefined);
      if (target === undefined || !isInside(root, target)) return sendNotFound(response);
      const info = await stat(target);
      if (!info.isFile()) return sendNotFound(response);
      response.writeHead(200, {
        "content-length": info.size,
        "content-type": MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
      });
      createReadStream(target).on("error", () => response.destroy()).pipe(response);
    } catch { sendNotFound(response); }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("D2C product preview failed to bind a loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    stop: () => new Promise<void>((resolveClose, reject) => server.close((error) => error === undefined ? resolveClose() : reject(error))),
  };
}
