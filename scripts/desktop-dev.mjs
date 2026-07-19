import { spawn } from "node:child_process";
import http from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const rendererUrl = "http://127.0.0.1:5177";

export function createDesktopDevCommands({
  cwd = process.cwd(),
  nodePath = process.execPath,
  platform = process.platform,
} = {}) {
  const electronArgs = [join(cwd, "node_modules", "electron", "cli.js")];
  if (platform === "win32") electronArgs.push("--no-sandbox");
  electronArgs.push(".");

  return {
    vite: {
      command: nodePath,
      args: [join(cwd, "node_modules", "vite", "bin", "vite.js"), "--config", "vite.desktop.config.ts"],
    },
    electron: {
      command: nodePath,
      args: electronArgs,
    },
  };
}

async function waitForRenderer(vite) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (vite.exitCode !== null) throw new Error("Vite exited before the desktop renderer was ready");
    const ready = await new Promise((resolveReady) => {
      const request = http.get(rendererUrl, (response) => {
        response.resume();
        resolveReady(response.statusCode === 200);
      });
      request.on("error", () => resolveReady(false));
      request.setTimeout(400, () => {
        request.destroy();
        resolveReady(false);
      });
    });
    if (ready) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
  }
  throw new Error("Timed out waiting for the desktop renderer");
}

export async function runDesktopDev() {
  const commands = createDesktopDevCommands();
  const vite = spawn(commands.vite.command, commands.vite.args, { stdio: "inherit" });

  try {
    await waitForRenderer(vite);
    const electron = spawn(commands.electron.command, commands.electron.args, {
      stdio: "inherit",
      env: { ...process.env, FLAVOR_DESKTOP_DEV_URL: rendererUrl },
    });
    const stopVite = () => { if (!vite.killed) vite.kill(); };
    process.on("SIGINT", () => { electron.kill(); stopVite(); });
    process.on("SIGTERM", () => { electron.kill(); stopVite(); });
    const code = await new Promise((resolveExit) => electron.once("exit", (value) => resolveExit(value ?? 0)));
    stopVite();
    process.exitCode = code;
  } catch (error) {
    vite.kill();
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runDesktopDev();
}
