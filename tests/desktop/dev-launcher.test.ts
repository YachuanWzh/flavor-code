import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("desktop development launcher", () => {
  it("runs local Vite and Electron JavaScript CLIs through Node", async () => {
    const launcher = await import("../../scripts/desktop-dev.mjs");
    const commands = launcher.createDesktopDevCommands({ cwd: workspace, nodePath: process.execPath, platform: "win32" });

    expect(commands).toEqual({
      vite: {
        command: process.execPath,
        args: [join(workspace, "node_modules", "vite", "bin", "vite.js"), "--config", "vite.desktop.config.ts"],
      },
      electron: {
        command: process.execPath,
        args: [join(workspace, "node_modules", "electron", "cli.js"), "--no-sandbox", "."],
      },
    });

    for (const command of [commands.vite, commands.electron]) {
      const probe = spawnSync(command.command, [command.args[0], "--version"], {
        cwd: workspace,
        encoding: "utf8",
        windowsHide: true,
      });
      expect(probe.error).toBeUndefined();
      expect(probe.status).toBe(0);
    }
  });

  it("keeps the Electron sandbox enabled outside Windows development", async () => {
    const launcher = await import("../../scripts/desktop-dev.mjs");

    const commands = launcher.createDesktopDevCommands({ cwd: workspace, nodePath: process.execPath, platform: "linux" });

    expect(commands.electron.args).toEqual([
      join(workspace, "node_modules", "electron", "cli.js"),
      ".",
    ]);
  });
});
