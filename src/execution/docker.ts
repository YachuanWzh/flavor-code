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
  run?(invocation: DockerInvocation, signal?: AbortSignal, timeoutMs?: number): Promise<ExecutionResult>;
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
    return (this.#options.run ?? runInvocation)(invocation, signal, request.timeoutMs);
  }

  async dispose(): Promise<void> {}
}

function runInvocation(invocation: DockerInvocation, signal?: AbortSignal, timeoutMs?: number): Promise<ExecutionResult> {
  return new Promise((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise({ exitCode: null, signal: null, stdout: "", stderr: "", terminationReason: "cancelled" });
      return;
    }
    const child = spawn(invocation.command, invocation.args, { windowsHide: true, shell: false });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let reason: ExecutionResult["terminationReason"] = null;
    let settled = false;
    const finish = (result: ExecutionResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolvePromise(result);
    };
    const stop = (next: Exclude<ExecutionResult["terminationReason"], null>) => {
      reason = next;
      child.kill();
    };
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => stop("timeout"), timeoutMs);
    timer?.unref();
    const abort = () => stop("cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (value: Buffer) => stdout.push(value));
    child.stderr.on("data", (value: Buffer) => stderr.push(value));
    child.once("error", (error) => {
      finish({ exitCode: 127, signal: null, stdout: "", stderr: error.message, terminationReason: reason });
    });
    child.once("close", (code, closedSignal) => {
      finish({
        exitCode: code,
        signal: closedSignal as NodeJS.Signals | null,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        terminationReason: reason,
      });
    });
  });
}
