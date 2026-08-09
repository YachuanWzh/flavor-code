import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, readFile } from "node:fs/promises";
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

export type D2cFetchFn = (url: string) => Promise<{ status: number }>;

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

function assertInsideWorkspace(workspace: string, projectDir: string): string {
  const resolved = resolve(projectDir);
  const delta = relative(resolve(workspace), resolved);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new Error(`D2C project directory must be inside the workspace: ${projectDir}`);
  }
  return resolved;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnFn("npm", ["install"], { cwd: projectDir, shell: process.platform === "win32" });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error(`D2C dependency install timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`D2C dependency install failed with exit code ${code}`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`D2C dependency install could not start: ${error.message}`));
    });
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
  const probe = options.fetch ?? ((url: string) => fetch(url));
  const installTimeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  const resolved = assertInsideWorkspace(options.workspace, projectDir);
  await assertViteProject(resolved);

  const viteBin = join(resolved, "node_modules", "vite", "bin", "vite.js");
  if (!(await fileExists(viteBin))) {
    await runNpmInstall(spawnFn, resolved, installTimeoutMs);
  }
  if (!(await fileExists(viteBin))) {
    throw new Error("D2C could not locate node_modules/vite/bin/vite.js after installing dependencies");
  }

  const child = spawnFn(process.execPath, [viteBin], { cwd: resolved });
  let output = "";
  let exited = false;
  let exitCode: number | null = null;
  const exitPromise = new Promise<void>((resolvePromise) => {
    child.on("exit", (code) => {
      exited = true;
      exitCode = code;
      resolvePromise();
    });
  });
  const append = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-65_536);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const stop = async (): Promise<void> => {
    if (exited) return;
    exited = true;
    child.kill("SIGTERM");
    const grace = new Promise<void>((resolvePromise) => setTimeout(resolvePromise, STOP_GRACE_MS));
    await Promise.race([exitPromise, grace]);
    if (exitCode === null) child.kill("SIGKILL");
  };

  try {
    const deadline = Date.now() + readyTimeoutMs;
    let url: string | undefined;
    while (url === undefined) {
      if (exited) {
        throw new Error(`D2C dev server exited with code ${exitCode} before reporting a URL`);
      }
      url = parseDevServerUrl(output);
      if (url === undefined) {
        if (Date.now() > deadline) {
          throw new Error(`D2C dev server did not report a localhost URL within ${readyTimeoutMs} ms`);
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
      }
    }
    while (true) {
      try {
        const response = await probe(url);
        if (response.status < 500) return { url, stop };
      } catch {
        // Server not accepting connections yet; keep probing.
      }
      if (exited) {
        throw new Error(`D2C dev server exited with code ${exitCode} before becoming ready`);
      }
      if (Date.now() > deadline) {
        throw new Error(`D2C dev server was not ready within ${readyTimeoutMs} ms: ${url}`);
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollIntervalMs));
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
