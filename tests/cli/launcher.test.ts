import { describe, expect, it } from "vitest";

import { cliMainArguments, needsRelaunch, needsWindowsMaglevWorkaround } from "../../src/launcher.js";

describe("CLI runtime launcher", () => {
  it("disables Maglev for affected Node releases on Windows build 26200", () => {
    const runtime = {
      platform: "win32",
      osRelease: "10.0.26200",
      nodeVersion: "24.18.0",
      execArgv: [],
    };
    expect(needsWindowsMaglevWorkaround(runtime)).toBe(true);
    expect(cliMainArguments(runtime, "C:\\flavor\\cli-main.js", ["--resume", "session-1"]))
      .toEqual(["--no-maglev", "--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "C:\\flavor\\cli-main.js", "--resume", "session-1"]);
  });

  it("keeps the protection active for future Node major versions", () => {
    expect(needsWindowsMaglevWorkaround({
      platform: "win32",
      osRelease: "10.0.26200",
      nodeVersion: "30.0.0",
      execArgv: [],
    })).toBe(true);
  });

  it("relaunches any runtime so the fatal-error diagnostic report is active", () => {
    const runtime = {
      platform: "linux",
      osRelease: "6.8.0",
      nodeVersion: "24.18.0",
      execArgv: [] as string[],
    };
    expect(needsRelaunch(runtime)).toBe(true);
    expect(cliMainArguments(runtime, "/opt/flavor/cli-main.js", []))
      .toEqual(["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "/opt/flavor/cli-main.js"]);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror"] })).toBe(true);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1"] })).toBe(false);
  });

  it.each([
    { platform: "win32", osRelease: "10.0.26200", nodeVersion: "22.22.1", execArgv: [] },
    { platform: "win32", osRelease: "10.0.26100", nodeVersion: "24.18.0", execArgv: [] },
    { platform: "linux", osRelease: "6.8.0", nodeVersion: "24.18.0", execArgv: [] },
    { platform: "win32", osRelease: "10.0.26200", nodeVersion: "24.18.0", execArgv: ["--no-maglev"] },
  ])("does not apply the Maglev workaround to an unaffected runtime: %o", (runtime) => {
    expect(needsWindowsMaglevWorkaround(runtime)).toBe(false);
  });
});
