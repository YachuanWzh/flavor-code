import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** Extracts the first localhost dev server URL from process output. */
export function parseDevServerUrl(output: string): string | undefined {
  const match = /http:\/\/(?:localhost|127\.0\.0\.1):\d+(?:\/[^\s"'`\x1b\x07]*)?/.exec(output);
  return match === null ? undefined : match[0];
}

export type D2cSpawnFn = (
  command: string,
  args: readonly string[],
  options: { cwd: string; shell?: boolean },
) => ChildProcessWithoutNullStreams;

export type D2cFetchFn = (url: string, signal?: AbortSignal) => Promise<{ status: number }>;

export interface RunFrontendProjectOptions {
  /** Workspace root; the project directory must live inside it. */
  workspace: string;
  /** Injectable process launcher (tests only). */
  spawn?: D2cSpawnFn;
  /** Injectable readiness probe (tests only). */
  fetch?: D2cFetchFn;
  /** Timeout for the one-shot `npm install`, default 8 minutes. */
  installTimeoutMs?: number;
  /** Timeout waiting for the dev server url and readiness, default 60 seconds. */
  readyTimeoutMs?: number;
  /** Readiness probe interval, default 500 ms. */
  pollIntervalMs?: number;
  /** Cancels dependency installation, startup and readiness probes. */
  signal?: AbortSignal;
  /** Node executable used for Vite; defaults to `node` resolved from PATH. */
  nodeCommand?: string;
}

export interface RunningProject {
  url: string;
  /** Stops the dev server; safe to call multiple times. */
  stop(): Promise<void>;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 8 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 500;
const STOP_GRACE_MS = 3_000;
const PROBE_TIMEOUT_MS = 5_000;

function assertContained(workspace: string, resolved: string, original: string): string {
  const delta = relative(workspace, resolved);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new Error(`D2C project directory must be inside the workspace: ${original}`);
  }
  return resolved;
}

async function resolveInsideWorkspace(workspace: string, projectDir: string): Promise<string> {
  const [workspaceReal, projectReal] = await Promise.all([
    realpath(resolve(workspace)),
    realpath(resolve(projectDir)).catch(() => undefined),
  ]);
  if (projectReal === undefined) throw new Error(`D2C project directory does not exist: ${projectDir}`);
  return assertContained(workspaceReal, projectReal, projectDir);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcessTree(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void> {
  if (process.platform !== "win32" || child.pid === undefined) {
    child.kill(force ? "SIGKILL" : "SIGTERM");
    return;
  }
  await new Promise<void>((resolvePromise) => {
    const killer = nodeSpawn(
      "taskkill",
      ["/pid", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      { windowsHide: true, stdio: "ignore" },
    );
    killer.once("exit", () => resolvePromise());
    killer.once("error", () => {
      child.kill(force ? "SIGKILL" : "SIGTERM");
      resolvePromise();
    });
  });
}

async function assertViteProject(projectDir: string): Promise<void> {
  const packagePath = join(projectDir, "package.json");
  let raw: string;
  try {
    raw = await readFile(packagePath, "utf8");
  } catch {
    throw new Error(`D2C cannot run this project: missing package.json at ${packagePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`D2C cannot run this project: invalid package.json at ${packagePath}`);
  }
  const manifest = parsed as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  const hasVite = manifest.dependencies?.vite !== undefined || manifest.devDependencies?.vite !== undefined;
  if (!hasVite) {
    throw new Error("D2C can only run Vite-based projects (Vue or React): no vite dependency in package.json");
  }
}

function runNpmInstall(
  spawnFn: D2cSpawnFn,
  projectDir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn("npm", ["install"], { cwd: projectDir, shell: process.platform === "win32" });
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => {
      void terminateProcessTree(child, true);
      finish(() => rejectPromise(signal?.reason ?? new Error("D2C dependency install cancelled")));
    };
    const timer = setTimeout(() => {
      void terminateProcessTree(child, true);
      finish(() => rejectPromise(new Error(`D2C dependency install timed out after ${timeoutMs} ms`)));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("exit", (code) => {
      finish(() => {
        if (code === 0) resolvePromise();
        else rejectPromise(new Error(`D2C dependency install failed with exit code ${code}`));
      });
    });
    child.on("error", (error) => {
      finish(() => rejectPromise(new Error(`D2C dependency install could not start: ${error.message}`)));
    });
  });
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      rejectPromise(signal?.reason ?? new Error("D2C startup cancelled"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolvePromise, rejectPromise) => {
    const onAbort = (): void => rejectPromise(signal.reason ?? new Error("D2C probe cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolvePromise(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); rejectPromise(error); },
    );
  });
}

/**
 * Runs a Vite-based frontend project (Vue or React) for D2C comparison:
 * installs dependencies when missing, starts the dev server, waits until it
 * answers, and returns the served URL plus a stop function.
 */
export async function runFrontendProject(
  projectDir: string,
  options: RunFrontendProjectOptions,
): Promise<RunningProject> {
  const spawnFn = options.spawn ?? nodeSpawn;
  const probe = options.fetch ?? ((url: string, signal?: AbortSignal) => fetch(url, signal === undefined ? {} : { signal }));
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  options.signal?.throwIfAborted();
  const resolved = await resolveInsideWorkspace(options.workspace, projectDir);
  await assertViteProject(resolved);

  const viteBin = join(resolved, "node_modules", "vite", "bin", "vite.js");
  if (!(await fileExists(viteBin))) {
    await runNpmInstall(spawnFn, resolved, installTimeoutMs, options.signal);
  }
  if (!(await fileExists(viteBin))) {
    throw new Error("D2C could not locate node_modules/vite/bin/vite.js after installing dependencies");
  }

  const viteReal = await realpath(viteBin);
  assertContained(resolved, viteReal, viteBin);
  const child = spawnFn(options.nodeCommand ?? "node", [viteReal, "--host", "127.0.0.1"], { cwd: resolved });
  let output = "";
  let exited = false;
  let stopping = false;
  let exitCode: number | null = null;
  let processError: Error | undefined;
  const exitPromise = new Promise<void>((resolvePromise) => {
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolvePromise();
    });
    child.on("error", (error) => {
      processError = error;
      exited = true;
      resolvePromise();
    });
  });
  const append = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-65_536);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const stop = async (): Promise<void> => {
    if (exited || stopping) return;
    stopping = true;
    await terminateProcessTree(child, false);
    const grace = wait(STOP_GRACE_MS);
    await Promise.race([exitPromise, grace]);
    if (exitCode === null) await terminateProcessTree(child, true);
  };

  try {
    const deadline = Date.now() + readyTimeoutMs;
    let url: string | undefined;
    while (url === undefined) {
      if (exited) {
        if (processError !== undefined) throw new Error(`D2C dev server could not start: ${processError.message}`);
        throw new Error(`D2C dev server exited with code ${exitCode} before reporting a URL`);
      }
      url = parseDevServerUrl(output);
      if (url === undefined) {
        if (Date.now() > deadline) {
          throw new Error(`D2C dev server did not report a localhost URL within ${readyTimeoutMs} ms`);
        }
        await wait(pollIntervalMs, options.signal);
      }
    }
    while (true) {
      try {
        const remaining = Math.max(1, deadline - Date.now());
        const timeoutSignal = AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, remaining));
        const probeSignal = options.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([options.signal, timeoutSignal]);
        const response = await awaitWithSignal(probe(url, probeSignal), probeSignal);
        if (response.status < 500) return { url, stop };
      } catch (cause) {
        if (options.signal?.aborted === true) throw options.signal.reason;
        // Server not accepting connections yet; keep probing.
      }
      if (exited) {
        if (processError !== undefined) throw new Error(`D2C dev server could not start: ${processError.message}`);
        throw new Error(`D2C dev server exited with code ${exitCode} before becoming ready`);
      }
      if (Date.now() > deadline) {
        throw new Error(`D2C dev server was not ready within ${readyTimeoutMs} ms: ${url}`);
      }
      await wait(pollIntervalMs, options.signal);
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
