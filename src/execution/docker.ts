import { spawn } from "node:child_process";
import { relative, resolve, sep, win32 } from "node:path";

import type { ExecutionEnvironment, ExecutionRequest, ExecutionResult } from "./types.js";

export interface DockerInvocation {
  command: "docker";
  args: string[];
}

export interface DockerInvocationOptions {
  workspace: string;
  image: string;
  network?: boolean;
  memory?: string;
  cpus?: number;
  request: ExecutionRequest;
}

export interface DockerExecutionEnvironmentOptions {
  workspace: string;
  image: string;
  network?: boolean;
  memory?: string;
  cpus?: number;
  run?(invocation: DockerInvocation, signal?: AbortSignal, timeoutMs?: number, maxOutputBytes?: number): Promise<ExecutionResult>;
}

export function buildDockerInvocation(options: DockerInvocationOptions): DockerInvocation {
  const workspace = options.workspace;
  const cwd = options.request.cwd;
  const windows = /^[A-Za-z]:[\\/]/.test(workspace);
  const delta = windows ? win32.relative(workspace, cwd) : relative(resolve(workspace), resolve(cwd));
  if (delta === ".." || delta.startsWith(`..${windows ? "\\" : sep}`)) throw new Error("Docker cwd escapes workspace");
  const containerCwd = delta.length === 0 ? "/workspace" : `/workspace/${delta.replaceAll("\\", "/")}`;
  const args = [
    "run", "--rm", "--init",
    ...(options.network === true ? [] : ["--network", "none"]),
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--pids-limit", "256",
    "--memory", options.memory ?? "2g",
    "--cpus", String(options.cpus ?? 2),
    "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
    "--mount", `type=bind,source=${workspace},target=/workspace`,
    "--workdir", containerCwd,
    options.image,
    options.request.command,
    ...options.request.args,
  ];
  return { command: "docker", args };
}

export class DockerExecutionEnvironment implements ExecutionEnvironment {
  readonly kind = "docker" as const;
  readonly #options: DockerExecutionEnvironmentOptions;

  constructor(options: DockerExecutionEnvironmentOptions) { this.#options = options; }

  exec(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const invocation = buildDockerInvocation({ ...this.#options, request });
    return (this.#options.run ?? runDockerInvocation)(invocation, signal, request.timeoutMs, request.maxOutputBytes);
  }

  async dispose(): Promise<void> {}
}

const DEFAULT_DOCKER_MAX_OUTPUT_BYTES = 1_048_576;
const DOCKER_TERMINATION_GRACE_MS = 250;
const DOCKER_TERMINATION_FAILURE_MS = 5_000;

export function runDockerInvocation(
  invocation: { command: string; args: string[] },
  signal?: AbortSignal,
  timeoutMs?: number,
  maxOutputBytes = DEFAULT_DOCKER_MAX_OUTPUT_BYTES,
): Promise<ExecutionResult> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ exitCode: null, signal: null, stdout: "", stderr: "", terminationReason: "cancelled" });
      return;
    }
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, shell: false });
    const stdout = new BoundedUtf8Output(maxOutputBytes);
    const stderr = new BoundedUtf8Output(maxOutputBytes);
    let reason: ExecutionResult["terminationReason"] = null;
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let failureTimer: NodeJS.Timeout | undefined;
    const finish = (result: ExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (failureTimer !== undefined) clearTimeout(failureTimer);
      signal?.removeEventListener("abort", abort);
      resolvePromise(result);
    };
    const collected = (exitCode: number | null, closedSignal: NodeJS.Signals | null): ExecutionResult => ({
      exitCode, signal: closedSignal, stdout: stdout.text(), stderr: stderr.text(), terminationReason: reason,
      truncated: stdout.truncated || stderr.truncated,
      truncation: { stdout: stdout.metadata(), stderr: stderr.metadata() },
    });
    const stop = (next: Exclude<ExecutionResult["terminationReason"], null>) => {
      if (reason !== null || settled) return;
      reason = next;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => child.kill("SIGKILL"), DOCKER_TERMINATION_GRACE_MS);
      forceTimer.unref();
      failureTimer = setTimeout(() => finish(collected(null, null)), DOCKER_TERMINATION_FAILURE_MS);
      failureTimer.unref();
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
    timer?.unref();
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (value: Buffer) => stdout.add(value));
    child.stderr.on("data", (value: Buffer) => stderr.add(value));
    child.once("error", (error) => {
      stderr.add(Buffer.from(error.message));
      finish(collected(127, null));
    });
    child.once("close", (code, closedSignal) => {
      finish(collected(code, closedSignal as NodeJS.Signals | null));
    });
  });
}

class BoundedUtf8Output {
  readonly #limit: number;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = Buffer.alloc(0);
  #tailChunks: Buffer[] = [];
  #tailBytes = 0;
  #complete = Buffer.alloc(0);
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = Number.isSafeInteger(limit) && limit > 0 ? limit : DEFAULT_DOCKER_MAX_OUTPUT_BYTES;
    this.#headLimit = Math.ceil(this.#limit / 2);
    this.#tailLimit = Math.floor(this.#limit / 2);
  }

  get truncated(): boolean { return this.#bytes > this.#limit; }

  add(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#complete.length < this.#limit) {
      this.#complete = Buffer.concat([this.#complete, chunk]).subarray(0, this.#limit);
    }
    if (this.#head.length < this.#headLimit) {
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, this.#headLimit - this.#head.length)]);
    }
    if (this.#tailLimit > 0) {
      this.#tailChunks.push(chunk);
      this.#tailBytes += chunk.length;
      if (this.#tailBytes >= this.#tailLimit * 2) {
        const merged = Buffer.concat(this.#tailChunks).subarray(-this.#tailLimit);
        this.#tailChunks = [merged];
        this.#tailBytes = merged.length;
      }
    }
  }

  metadata(): { truncated: boolean; originalBytes: number; limitBytes: number } {
    return { truncated: this.truncated, originalBytes: this.#bytes, limitBytes: this.#limit };
  }

  text(): string {
    if (!this.truncated) return this.#complete.toString("utf8");
    const tail = Buffer.concat(this.#tailChunks).subarray(-this.#tailLimit);
    return `${decodeUtf8Edge(this.#head, "prefix")}…${decodeUtf8Edge(tail, "suffix")}`;
  }
}

function decodeUtf8Edge(buffer: Buffer, edge: "prefix" | "suffix"): string {
  for (let offset = 0; offset <= Math.min(3, buffer.length); offset += 1) {
    const candidate = edge === "prefix" ? buffer.subarray(0, buffer.length - offset) : buffer.subarray(offset);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(candidate); }
    catch { /* Trim a split UTF-8 code point at the bounded edge. */ }
  }
  return new TextDecoder("utf-8").decode(buffer);
}
