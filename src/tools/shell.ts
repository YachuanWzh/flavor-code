import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
const ELLIPSIS = Buffer.from("\u2026");
const TERMINATION_GRACE_MS = 250;
const TERMINATION_FAILURE_MS = 5_000;

const ShellInput = z.object({
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1).nullable().optional(),
  timeoutMs: z.number().int().positive().max(86_400_000).nullable().optional(),
});

export interface ShellToolOptions { maxOutputBytes?: number }
export interface TruncationMetadata { truncated: boolean; originalBytes: number; limitBytes: number }
export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  truncation: { stdout: TruncationMetadata; stderr: TruncationMetadata };
  terminationReason: "timeout" | "cancelled" | null;
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
    paths: (input) => [workingDirectory(root, input.cwd ?? undefined)],
    summarize: (input) => [input.command, ...input.args].join(" "),
    permissions: (input) => ({
      paths: [workingDirectory(root, input.cwd ?? undefined)],
      command: input.command,
      args: input.args,
      cwd: workingDirectory(root, input.cwd ?? undefined),
    }),
    execute: (input, signal) => executeShell(root, input, signal, maxBytes),
  };
}

async function executeShell(
  root: string,
  input: z.infer<typeof ShellInput>,
  cancellation: AbortSignal,
  maxBytes: number,
): Promise<ShellResult> {
  const cwd = workingDirectory(root, input.cwd ?? undefined);
  const stdout = new BoundedOutput(maxBytes);
  const stderr = new BoundedOutput(maxBytes);
  return new Promise((resolvePromise, reject) => {
    if (cancellation.aborted) { reject(cancellation.reason); return; }
    // On Windows, .cmd/.bat files cannot be spawned directly by CreateProcess
    // (they are batch scripts, not executables). shell:true runs via cmd.exe
    // which resolves PATHEXT automatically — no .cmd suffix needed.
    // On Node ≥24, passing an args array with shell:true is deprecated; we
    // build a single command-line string with shell-safe quoting.
    const quoteArg = (s: string) => s.includes(" ") ? `"${s.replace(/"/g, '""')}"` : s;
    const quoted = input.args.map(quoteArg).join(" ");
    const commandLine = quoted.length > 0
      ? `${quoteArg(input.command)} ${quoted}`
      : quoteArg(input.command);
    const child = spawn(commandLine, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let exitObserved = false;
    let settled = false;
    let terminationReason: ShellResult["terminationReason"] = null;
    let termination: Promise<void> | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    const terminate = (reason: Exclude<ShellResult["terminationReason"], null>) => {
      if (termination !== undefined || exitObserved) return;
      terminationReason = reason;
      termination = terminateTree(child.pid);
      terminalTimer = setTimeout(() => finishReject(new Error(`Process did not close after ${reason} termination`)), TERMINATION_FAILURE_MS);
      terminalTimer.unref();
    };
    const timeoutMs = input.timeoutMs ?? undefined;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => terminate("timeout"), timeoutMs);
    timer?.unref();
    const onCancel = () => terminate("cancelled");
    cancellation.addEventListener("abort", onCancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.add(chunk));
    child.once("exit", () => {
      exitObserved = true;
      if (timer !== undefined) clearTimeout(timer);
    });
    child.once("error", (error) => {
      finishReject(error);
    });
    child.once("close", async (exitCode, signal) => {
      if (termination !== undefined) await termination;
      if (settled) return;
      settled = true;
      cleanup();
      resolvePromise({
        exitCode,
        signal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        truncation: { stdout: stdout.metadata(), stderr: stderr.metadata() },
        terminationReason,
      });
    });
    function finishReject(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      if (terminalTimer !== undefined) clearTimeout(terminalTimer);
      cancellation.removeEventListener("abort", onCancel);
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
    return Buffer.concat([utf8Prefix(this.#head), ELLIPSIS, utf8Suffix(this.#tail)]).toString("utf8");
  }
}

function workingDirectory(root: string, cwd = "."): string {
  const candidate = resolve(root, cwd);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Working directory is outside the workspace");
  return candidate;
}

async function terminateTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await waitForProcess(spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true }));
    try { process.kill(pid); } catch { /* The direct child may already have exited. */ }
  } else {
    try { process.kill(-pid, "SIGTERM"); }
    catch { try { process.kill(pid, "SIGTERM"); } catch { /* Already exited. */ } }
    await delay(TERMINATION_GRACE_MS);
    try { process.kill(-pid, "SIGKILL"); }
    catch { try { process.kill(pid, "SIGKILL"); } catch { /* ESRCH: the whole group has exited. */ } }
  }
}

function waitForProcess(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise) => {
    child.once("error", () => resolvePromise());
    child.once("close", () => resolvePromise());
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function utf8Prefix(buffer: Buffer): Buffer {
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 3); end -= 1) {
    const candidate = buffer.subarray(0, end);
    try { new TextDecoder("utf-8", { fatal: true }).decode(candidate); return candidate; } catch { /* trim */ }
  }
  return Buffer.from(buffer.toString("utf8"));
}

function utf8Suffix(buffer: Buffer): Buffer {
  for (let start = 0; start <= Math.min(3, buffer.length); start += 1) {
    const candidate = buffer.subarray(start);
    try { new TextDecoder("utf-8", { fatal: true }).decode(candidate); return candidate; } catch { /* trim */ }
  }
  return Buffer.from(buffer.toString("utf8"));
}
