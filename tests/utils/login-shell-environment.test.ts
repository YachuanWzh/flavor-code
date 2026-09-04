import { delimiter } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loginShellEnvironment } from "../../src/utils/login-shell-environment.js";

describe("loginShellEnvironment", () => {
  it("keeps non-macOS environments unchanged without starting a shell", async () => {
    const execute = vi.fn();
    await expect(loginShellEnvironment({ PATH: "/usr/bin" }, "win32", { execute })).resolves.toEqual({ PATH: "/usr/bin" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("merges a bounded macOS login-shell PATH ahead of the GUI PATH", async () => {
    const execute = vi.fn(async () => ({
      code: 0,
      stdout: `startup banner\nPATH=/opt/homebrew/bin${delimiter}/Users/test/.local/bin${delimiter}/usr/bin\n`,
      stderr: "",
    }));
    const result = await loginShellEnvironment({ SHELL: "/bin/zsh", PATH: `/usr/bin${delimiter}/bin` }, "darwin", { execute });

    expect(result.PATH).toBe([
      "/opt/homebrew/bin", "/Users/test/.local/bin", "/usr/bin", "/bin",
    ].join(delimiter));
    expect(execute).toHaveBeenCalledWith("/bin/zsh", ["-l", "-c", "command env"], expect.objectContaining({ timeout: 2_000 }));
  });

  it("falls back unchanged when the login shell fails", async () => {
    const execute = vi.fn(async () => ({ code: 1, stdout: "", stderr: "bad shell", error: "failed" }));
    await expect(loginShellEnvironment({ SHELL: "/bin/zsh", PATH: "/usr/bin" }, "darwin", { execute }))
      .resolves.toEqual({ SHELL: "/bin/zsh", PATH: "/usr/bin" });
  });
});
