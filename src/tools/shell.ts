import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const ELLIPSIS = Buffer.from("…");

const ShellInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
});

export interface ShellToolOptions { maxOutputBytes?: number }
export interface TruncationMetadata { truncated: boolean; originalBytes: number; limitBytes: number }
export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

type ShellTool = Omit<ToolDefinition<z.infer<typeof ShellInput>>, "execute"> & {
  execute(input: z.infer<typeof ShellInput>, signal: AbortSignal): Promise<ShellResult>;
};

export function createShellTool(
  workspace: string,
  options: ShellToolOptions = {},
): ShellTool {
  const root = resolve(workspace);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxOutputBytes must be a positive integer");
  return {
    name: "Shell",
    description: "Run a command with an argument array inside the workspace",
    inputSchema: ShellInput,
    paths: (input) => [workingDirectory(root, input.cwd)],
    execute: (input, signal) => executeShell(root, input, signal, maxBytes),
  };
}

async function executeShell(
  root: string,
  input: z.infer<typeof ShellInput>,
  cancellation: AbortSignal,
  maxBytes: number,
): Promise<ShellResult> {
  const cwd = workingDirectory(root, input.cwd);
  const stdout = new BoundedOutput(maxBytes);
  const stderr = new BoundedOutput(maxBytes);
  return new Promise((resolvePromise, reject) => {
    if (cancellation.aborted) { reject(cancellation.reason); return; }
    const child = spawn(input.command, input.args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let terminationRequested = false;
    const terminate = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      killTree(child.pid);
    };
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(terminate, input.timeoutMs);
    timer?.unref();
    cancellation.addEventListener("abort", terminate, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (exitCode, signal) => {
      cleanup();
      resolvePromise({
        exitCode: terminationRequested ? null : exitCode,
        signal: signal ?? (terminationRequested ? "SIGTERM" : null),
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
      });
    });
    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      cancellation.removeEventListener("abort", terminate);
    }
  });
}

class BoundedOutput {
  readonly #limit: number;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = Buffer.alloc(0);
  #tail = Buffer.alloc(0);
  #complete = Buffer.alloc(0);
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
    this.#headLimit = Math.ceil(limit / 2);
    this.#tailLimit = Math.floor(limit / 2);
  }

  get truncated(): boolean { return this.#bytes > this.#limit; }

  add(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#complete.length < this.#limit) {
      this.#complete = Buffer.concat([this.#complete, chunk]).subarray(0, this.#limit);
    }
    if (this.#head.length < this.#headLimit) {
      const count = Math.min(this.#headLimit - this.#head.length, chunk.length);
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, count)]);
    }
    if (this.#tailLimit > 0) this.#tail = Buffer.concat([this.#tail, chunk]).subarray(-this.#tailLimit);
  }

  metadata(): TruncationMetadata {
    return { truncated: this.truncated, originalBytes: this.#bytes, limitBytes: this.#limit };
  }

  text(): string {
    if (!this.truncated) return this.#complete.toString("utf8");
    return Buffer.concat([this.#head, ELLIPSIS, this.#tail]).toString("utf8");
  }
}

function workingDirectory(root: string, cwd = "."): string {
  const candidate = resolve(root, cwd);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Working directory is outside the workspace");
  return candidate;
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true });
    killer.on("error", () => { /* The child may already have exited. */ });
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ } }
  }
}
