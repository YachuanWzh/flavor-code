import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";

import { terminateProcessTree } from "./runner.js";

export interface D2cRunningMock {
  url: string;
  output(): string;
  stop(): Promise<void>;
}

export interface RunD2cMockOptions {
  installDependencies?: boolean;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }

async function port(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const value = typeof address === "object" && address !== null ? address.port : 0;
      server.close((error) => error ? rejectPromise(error) : resolvePromise(value));
    });
  });
}

function waitForProcess(child: ChildProcessWithoutNullStreams, timeoutMs: number, label: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => { void terminateProcessTree(child, true); rejectPromise(new Error(`${label} timed out`)); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); rejectPromise(error); });
    child.once("exit", (code) => { clearTimeout(timer); code === 0 ? resolvePromise() : rejectPromise(new Error(`${label} failed with exit code ${code}`)); });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const onExit = (): void => { clearTimeout(timer); resolvePromise(true); };
    const timer = setTimeout(() => { child.removeListener("exit", onExit); resolvePromise(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

async function install(projectDir: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const runInstall = async (ignoreUserConfig: boolean): Promise<string> => {
    const nullConfig = process.platform === "win32" ? "NUL" : "/dev/null";
    const npmArgs = ["install", "--prefer-offline", "--no-audit", "--no-fund"];
    const command = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", `npm ${npmArgs.join(" ")}`]
      : npmArgs;
    const env = { ...process.env };
    if (ignoreUserConfig) {
      env.NPM_CONFIG_USERCONFIG = nullConfig;
      for (const key of Object.keys(env)) {
        if (key.toLowerCase() === "npm_config_allow_scripts") delete env[key];
      }
    }
    const child = spawn(command, args, { cwd: projectDir, env, shell: false, windowsHide: true });
    let output = "";
    const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-8_000); };
    child.stdout.on("data", append); child.stderr.on("data", append);
    const abort = (): void => { void terminateProcessTree(child, true); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await waitForProcess(child, 180_000, "D2C mock dependency install");
      return output;
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}${output.trim() ? `\n${output.trim()}` : ""}`);
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  };

  try {
    await runInstall(false);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // npm 11 rejects legacy global `allow-scripts=true` during project installs.
    // Retry without the user's npmrc; the generated mock only needs public runtime dependencies.
    if (!message.includes("EALLOWSCRIPTS")) throw error;
    await runInstall(true);
  }
}

export function parseMockReadyLine(line: string): number | undefined {
  if (line.length > 2_048) return undefined;
  try {
    const value = JSON.parse(line) as { type?: unknown; port?: unknown };
    return value.type === "d2c-mock-ready" && Number.isInteger(value.port) && Number(value.port) >= 1 && Number(value.port) <= 65_535
      ? Number(value.port) : undefined;
  } catch { return undefined; }
}

export async function runD2cMockServer(projectDir: string, options: RunD2cMockOptions = {}): Promise<D2cRunningMock> {
  const serverPath = join(projectDir, "mock", "server.mjs");
  if (!(await exists(serverPath))) throw new Error(`D2C mock server is not generated at ${serverPath}`);
  if (options.installDependencies === false && !(await exists(join(projectDir, "node_modules", "express", "package.json")))) {
    throw new Error("D2C mock server dependencies are not installed");
  }
  if (options.installDependencies !== false) await install(projectDir, options.signal);
  const selectedPort = await port();
  const url = `http://127.0.0.1:${selectedPort}`;
  const child = spawn(process.execPath, [serverPath], {
    cwd: projectDir, windowsHide: true, env: { ...process.env, D2C_MOCK_PORT: String(selectedPort) },
  });
  let output = "";
  let exited = false;
  const append = (chunk: Buffer): void => { output = (output + chunk.toString("utf8")).slice(-65_536); };
  child.stdout.on("data", append); child.stderr.on("data", append);
  child.once("exit", () => { exited = true; });
  const deadline = Date.now() + (options.readyTimeoutMs ?? 30_000);
  try {
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (exited) throw new Error(`D2C mock server exited before readiness\n${output.slice(-4_000)}`);
      try { const response = await fetch(`${url}/_d2c/health`); if (response.ok) break; } catch { /* keep probing */ }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
    if (Date.now() >= deadline) throw new Error(`D2C mock server readiness timed out\n${output.slice(-4_000)}`);
  } catch (error) {
    await terminateProcessTree(child, true);
    throw error;
  }
  let stopped: Promise<void> | undefined;
  return {
    url,
    output: () => output,
    stop: () => stopped ??= (async () => {
      if (exited) return;
      await terminateProcessTree(child, false);
      if (await waitForExit(child, 2_000)) return;
      await terminateProcessTree(child, true);
      await waitForExit(child, 2_000);
    })(),
  };
}
