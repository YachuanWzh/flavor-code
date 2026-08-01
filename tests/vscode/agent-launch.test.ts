import { describe, expect, it } from "vitest";

import { resolveAgentLaunch } from "../../extensions/vscode/src/agent-launch.js";

describe("resolveAgentLaunch", () => {
  it("launches the JS target behind a Windows npm shim without a shell", async () => {
    const files = new Set([
      String.raw`C:\Program Files\nodejs\flavor.cmd`.toLowerCase(),
      String.raw`C:\Program Files\nodejs\node.exe`.toLowerCase(),
      String.raw`C:\Program Files\nodejs\node_modules\flavor-code\dist\cli.js`.toLowerCase(),
    ]);
    const launch = await resolveAgentLaunch("flavor", ["--mode", "rpc", "--workspace", String.raw`C:\repo`], {
      platform: "win32",
      env: { Path: String.raw`C:\Program Files\nodejs`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      fileExists: async (path) => files.has(path.toLowerCase()),
    });

    expect(launch).toEqual({
      command: String.raw`C:\Program Files\nodejs\node.exe`,
      args: [
        String.raw`C:\Program Files\nodejs\node_modules\flavor-code\dist\cli.js`,
        "--mode",
        "rpc",
        "--workspace",
        String.raw`C:\repo`,
      ],
    });
  });

  it("returns an actionable error when the configured CLI is missing", async () => {
    await expect(resolveAgentLaunch("flavor", [], {
      platform: "win32",
      env: { Path: String.raw`C:\empty` },
      fileExists: async () => false,
    })).rejects.toThrow(/was not found.*flavorCode\.executable/i);
  });

  it("keeps direct executable launches unchanged on non-Windows platforms", async () => {
    await expect(resolveAgentLaunch("flavor", ["--mode", "rpc"], { platform: "linux" }))
      .resolves.toEqual({ command: "flavor", args: ["--mode", "rpc"] });
  });
});
