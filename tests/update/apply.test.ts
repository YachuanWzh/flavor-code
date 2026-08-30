import { describe, expect, it, vi } from "vitest";

import { npmExecutable, runUpdate, type InstallRunner } from "../../src/update/apply.js";
import type { RegistryFetch } from "../../src/update/check.js";

function respondWith(ok: boolean, body: unknown): RegistryFetch {
  return async () => ({ ok, json: async () => body });
}

describe("npmExecutable", () => {
  it("picks the cmd shim on Windows and plain npm elsewhere", () => {
    expect(npmExecutable("win32")).toBe("npm.cmd");
    expect(npmExecutable("linux")).toBe("npm");
    expect(npmExecutable("darwin")).toBe("npm");
  });
});

describe("runUpdate", () => {
  it("reports up-to-date without installing when the registry has no newer version", async () => {
    const install = vi.fn<InstallRunner>(async () => 0);
    const outcome = await runUpdate({
      current: "1.3.17",
      fetchImpl: respondWith(true, { version: "1.3.17" }),
      install,
    });

    expect(outcome).toEqual({ status: "up-to-date", current: "1.3.17", latest: "1.3.17" });
    expect(install).not.toHaveBeenCalled();
  });

  it("installs the latest release globally when a newer version exists", async () => {
    const install = vi.fn<InstallRunner>(async () => 0);
    const outcome = await runUpdate({
      current: "1.3.17",
      platform: "linux",
      fetchImpl: respondWith(true, { version: "1.3.18" }),
      install,
    });

    expect(outcome).toEqual({ status: "updated", current: "1.3.17", latest: "1.3.18" });
    expect(install).toHaveBeenCalledWith("npm", ["install", "-g", "flavor-code@1.3.18"]);
  });

  it("spawns npm.cmd on Windows", async () => {
    const install = vi.fn<InstallRunner>(async () => 0);
    await runUpdate({
      current: "1.0.0",
      platform: "win32",
      fetchImpl: respondWith(true, { version: "2.0.0" }),
      install,
    });

    expect(install).toHaveBeenCalledWith("npm.cmd", ["install", "-g", "flavor-code@2.0.0"]);
  });

  it("reports check-failed without installing when the registry is unreachable", async () => {
    const install = vi.fn<InstallRunner>(async () => 0);
    const outcome = await runUpdate({
      current: "1.3.17",
      fetchImpl: respondWith(false, {}),
      install,
    });

    expect(outcome).toEqual({ status: "check-failed", current: "1.3.17" });
    expect(install).not.toHaveBeenCalled();
  });

  it("reports install-failed with the exit code when npm exits non-zero", async () => {
    const outcome = await runUpdate({
      current: "1.0.0",
      platform: "linux",
      fetchImpl: respondWith(true, { version: "2.0.0" }),
      install: async () => 1,
    });

    expect(outcome).toEqual({ status: "install-failed", current: "1.0.0", latest: "2.0.0", exitCode: 1 });
  });

  it("reports install-failed with a null exit code when npm cannot be spawned", async () => {
    const outcome = await runUpdate({
      current: "1.0.0",
      fetchImpl: respondWith(true, { version: "2.0.0" }),
      install: async () => {
        throw new Error("spawn npm ENOENT");
      },
    });

    expect(outcome).toMatchObject({ status: "install-failed", exitCode: null });
  });
});
