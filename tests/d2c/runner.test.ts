import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import { parseDevServerUrl, runFrontendProject, type RunFrontendProjectOptions } from "../../src/d2c/runner.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-runner-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface SpawnCall {
  command: string;
  args: readonly string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  windowsHide?: boolean;
}

interface FakeChild {
  stdout: PassThrough;
  stderr: PassThrough;
  signals: string[];
  exitCode: number | null;
  kill(signal?: string): boolean;
  emitExit(code: number): void;
  emitError(error: Error): void;
}

function createFakeChild(): FakeChild {
  const emitter = new EventEmitter();
  let terminated = false;
  const child = {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    signals: [] as string[],
    exitCode: null as number | null,
    kill(signal = "SIGTERM"): boolean {
      this.signals.push(signal);
      if (!terminated) {
        terminated = true;
        setTimeout(() => this.emitExit(143), 0);
      }
      return true;
    },
    emitExit(code: number): void {
      this.exitCode = code;
      emitter.emit("exit", code, null);
    },
    emitError(error: Error): void {
      emitter.emit("error", error);
    },
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    off: emitter.off.bind(emitter),
  } as FakeChild & { on: unknown; once: unknown; off: unknown };
  return child;
}

interface FakeSpawn {
  calls: SpawnCall[];
  spawn: (command: string, args: readonly string[], options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    windowsHide?: boolean;
  }) => ChildProcessWithoutNullStreams;
}

function fakeSpawn(children: FakeChild[]): FakeSpawn {
  const calls: SpawnCall[] = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({
        command,
        args: [...args],
        cwd: options.cwd,
        ...(options.env === undefined ? {} : { env: options.env }),
        ...(options.shell === undefined ? {} : { shell: options.shell }),
        ...(options.windowsHide === undefined ? {} : { windowsHide: options.windowsHide }),
      });
      const child = children[calls.length - 1] ?? createFakeChild();
      return child as unknown as ChildProcessWithoutNullStreams;
    },
  };
}

async function until(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function viteProject(workspace: string, name = "app"): Promise<string> {
  const projectDir = join(workspace, name);
  await mkdir(projectDir, { recursive: true });
  await writeFile(
    join(projectDir, "package.json"),
    JSON.stringify({ name, private: true, devDependencies: { vite: "^5.0.0" } }),
  );
  return projectDir;
}

async function installViteBin(projectDir: string): Promise<string> {
  const viteBin = join(projectDir, "node_modules", "vite", "bin", "vite.js");
  await mkdir(join(projectDir, "node_modules", "vite", "bin"), { recursive: true });
  await writeFile(viteBin, "// fake vite");
  return viteBin;
}

const readyOptions: Pick<RunFrontendProjectOptions, "readyTimeoutMs" | "pollIntervalMs"> = {
  readyTimeoutMs: 2000,
  pollIntervalMs: 5,
};

describe("parseDevServerUrl", () => {
  it("parses the vite local URL", () => {
    expect(parseDevServerUrl("  ➜  Local:   http://localhost:5173/\n")).toBe("http://localhost:5173/");
    expect(parseDevServerUrl("VITE ready http://127.0.0.1:4173/base/ now")).toBe("http://127.0.0.1:4173/base/");
  });

  it("ignores ansi escapes after the url", () => {
    expect(parseDevServerUrl("\x1b[36mhttp://localhost:5173/\x1b[39m")).toBe("http://localhost:5173/");
  });

  it("returns undefined without a localhost url", () => {
    expect(parseDevServerUrl("no url here")).toBeUndefined();
    expect(parseDevServerUrl("http://example.com:5173/")).toBeUndefined();
  });
});

describe("runFrontendProject", () => {
  it("starts an actual Node-hosted dev server instead of the Electron executable", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace, "real-node-app");
    const viteBin = await installViteBin(projectDir);
    await writeFile(viteBin, [
      "const http = require('node:http');",
      "const server = http.createServer((_req, res) => { res.statusCode = 200; res.end('ok'); });",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      "server.listen(port, '127.0.0.1');",
      "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
    ].join("\n"));
    const running = await runFrontendProject(projectDir, {
      workspace,
      readyTimeoutMs: 5_000,
      pollIntervalMs: 10,
    });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    await running.stop();
  });

  it("rejects when the directory is outside the workspace", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(await tempDir());
    await expect(runFrontendProject(projectDir, { workspace, ...readyOptions })).rejects.toThrow(/workspace/i);
  });

  it("rejects when package.json is missing", async () => {
    const workspace = await tempDir();
    const projectDir = join(workspace, "empty");
    await mkdir(projectDir, { recursive: true });
    await expect(runFrontendProject(projectDir, { workspace, ...readyOptions })).rejects.toThrow(/package\.json/i);
  });

  it("rejects when the project has no vite dependency", async () => {
    const workspace = await tempDir();
    const projectDir = join(workspace, "app");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "package.json"), JSON.stringify({ dependencies: { vue: "^3.0.0" } }));
    await expect(runFrontendProject(projectDir, { workspace, ...readyOptions })).rejects.toThrow(/vite/i);
  });

  it("starts vite, resolves the url and stops the server", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    const viteBin = await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);
    const fetches: string[] = [];

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      port: 43123,
      spawn: spawn.spawn,
      fetch: async (url) => {
        fetches.push(url);
        return { status: 200 };
      },
    });
    await until(() => spawn.calls.length === 1);
    server.stdout.write("  VITE v5.0.0  ready\n  ➜  Local:   http://localhost:5173/\n");

    const running = await pending;
    expect(running.url).toBe("http://127.0.0.1:43123/");
    expect(spawn.calls).toHaveLength(1);
    expect(spawn.calls[0]?.command).toBe("node");
    expect(spawn.calls[0]?.args).toEqual([viteBin, "--host", "127.0.0.1", "--port", "43123", "--strictPort"]);
    expect(spawn.calls[0]?.cwd).toBe(projectDir);
    expect(spawn.calls[0]?.windowsHide).toBe(true);
    expect(fetches.length).toBeGreaterThan(0);
    expect(fetches[0]).toBe("http://127.0.0.1:43123/");

    await Promise.all([running.stop(), running.stop()]);
    expect(server.signals).toContain("SIGTERM");
    await running.stop(); // idempotent
    expect(server.signals.filter((signal) => signal === "SIGTERM")).toHaveLength(1);
  });

  it("runs npm install first when node_modules is missing", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    const installer = createFakeChild();
    const server = createFakeChild();
    const spawn = fakeSpawn([installer, server]);

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      installTimeoutMs: 2000,
      port: 43124,
      spawn: spawn.spawn,
      fetch: async () => ({ status: 200 }),
    });
    await until(() => spawn.calls.length === 1);
    expect(spawn.calls[0]?.command).toBe("npm");
    expect(spawn.calls[0]?.args).toEqual(["install", "--prefer-offline", "--no-audit", "--no-fund"]);
    expect(spawn.calls[0]?.windowsHide).toBe(true);

    await installViteBin(projectDir);
    installer.emitExit(0);
    await until(() => spawn.calls.length === 2);
    server.stdout.write("http://localhost:5173/");
    const running = await pending;
    expect(running.url).toBe("http://127.0.0.1:43124/");
    await running.stop();
  });

  it("sanitizes an inherited npm allow-scripts flag and reports install diagnostics inline", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    const installer = createFakeChild();
    const spawn = fakeSpawn([installer]);

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      environment: { PATH: "test-path", npm_config_allow_scripts: "true", NPM_CONFIG_ALLOW_SCRIPTS: "vite" },
      spawn: spawn.spawn,
      fetch: async () => ({ status: 200 }),
    });
    await until(() => spawn.calls.length === 1);
    expect(spawn.calls[0]?.env).toEqual({ PATH: "test-path" });
    installer.stderr.write("npm error code EALLOWSCRIPTS\ninvalid inherited allow-scripts policy\n");
    installer.emitExit(1);
    await expect(pending).rejects.toThrow(/EALLOWSCRIPTS/);
  });

  it("rejects and kills the server when the explicit loopback URL never becomes ready", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);

    await expect(
      runFrontendProject(projectDir, {
        workspace,
        readyTimeoutMs: 60,
        pollIntervalMs: 5,
        port: 43125,
        spawn: spawn.spawn,
        fetch: async () => { throw new Error("connection refused"); },
      }),
    ).rejects.toThrow(/not ready|dev server/i);
    expect(server.signals.length).toBeGreaterThan(0);
  });

  it("keeps probing until the server answers without a 5xx status", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);
    const statuses = [500, 200];

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      port: 43126,
      spawn: spawn.spawn,
      fetch: async () => {
        const status = statuses.shift() ?? 200;
        return { status };
      },
    });
    await until(() => spawn.calls.length === 1);
    server.stdout.write("http://localhost:5173/");
    const running = await pending;
    expect(running.url).toBe("http://127.0.0.1:43126/");
    await running.stop();
  });

  it("rejects when the server process exits early", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      port: 43127,
      spawn: spawn.spawn,
      fetch: async () => { throw new Error("connection refused"); },
    });
    await until(() => spawn.calls.length === 1);
    server.stderr.write("failed to load config: missing plugin\n");
    server.emitExit(1);
    await expect(pending).rejects.toThrow(/missing plugin/i);
  });

  it("rejects cleanly when the server process emits an error", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      spawn: spawn.spawn,
      fetch: async () => { throw new Error("connection refused"); },
    });
    await until(() => spawn.calls.length === 1);
    server.emitError(new Error("spawn denied"));
    await expect(pending).rejects.toThrow(/spawn denied|could not start/i);
  });

  it("aborts startup and terminates the server", async () => {
    const workspace = await tempDir();
    const projectDir = await viteProject(workspace);
    await installViteBin(projectDir);
    const server = createFakeChild();
    const spawn = fakeSpawn([server]);
    const controller = new AbortController();

    const pending = runFrontendProject(projectDir, {
      workspace,
      ...readyOptions,
      port: 43128,
      signal: controller.signal,
      spawn: spawn.spawn,
      fetch: async () => new Promise(() => undefined),
    });
    await until(() => spawn.calls.length === 1);
    server.stdout.write("http://localhost:5173/");
    controller.abort(new Error("cancelled by test"));
    await expect(pending).rejects.toThrow(/cancelled by test/);
    expect(server.signals.length).toBeGreaterThan(0);
  });

  it("rejects a project whose real path escapes through a symlink", async () => {
    const workspace = await tempDir();
    const outside = await viteProject(await tempDir());
    const link = join(workspace, "linked-app");
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, link, "junction");
    await expect(runFrontendProject(link, { workspace, ...readyOptions })).rejects.toThrow(/workspace/i);
  });
});
