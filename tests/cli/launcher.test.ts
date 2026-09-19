import { afterEach, describe, expect, it, vi } from "vitest";

import { cliMainArguments, isLightCommand, isStaticUsageError, needsRelaunch } from "../../src/launcher.js";

const GB = 1024 * 1024 * 1024;
const totalmem = vi.hoisted(() => vi.fn(() => 8 * 1024 * 1024 * 1024));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, totalmem };
});

afterEach(() => { totalmem.mockReturnValue(8 * GB); });

describe("CLI runtime launcher", () => {
  it("relaunches any runtime so the fatal-error diagnostic report and gc verification are active", () => {
    const runtime = {
      execArgv: [] as string[],
    };
    expect(needsRelaunch(runtime)).toBe(true);
    expect(cliMainArguments("/opt/flavor/cli-main.js", []))
      .toEqual([
        "--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1",
        "--heap-prof", "--heap-prof-interval=1048576", "--expose-gc",
        "/opt/flavor/cli-main.js",
      ]);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror"] })).toBe(true);
    // The heap watermarks are GC-verified, so a runtime without --expose-gc still needs a relaunch.
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1"] })).toBe(true);
    expect(needsRelaunch({ ...runtime, execArgv: [
      "--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "--heap-prof", "--expose-gc",
    ] })).toBe(false);
  });

  it("does not disable Maglev for a heap-OOM report signature", () => {
    expect(cliMainArguments("C:\\flavor\\cli-main.js", ["--resume", "session-1"]))
      .toEqual([
        "--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1",
        "--heap-prof", "--heap-prof-interval=1048576", "--expose-gc",
        "C:\\flavor\\cli-main.js", "--resume", "session-1",
      ]);
  });

  it("writes sparse allocation profiles to an explicit diagnostic target", () => {
    expect(cliMainArguments("/opt/flavor/cli-main.js", [], { directory: "/work/.flavor/tmp", name: "rotation.heapprofile" }))
      .toEqual(expect.arrayContaining([
        "--heap-prof-dir=/work/.flavor/tmp",
        "--heap-prof-name=rotation.heapprofile",
      ]));
  });

  it("gives a larger heap only on machines with room to spare and no user-pinned heap", () => {
    totalmem.mockReturnValue(16 * GB);
    expect(cliMainArguments("/opt/flavor/cli-main.js", [])).toContain("--max-old-space-size=8192");
    // A user-pinned heap always wins, so we never fight an explicit choice.
    const pinned = cliMainArguments("/opt/flavor/cli-main.js", ["--max-old-space-size=4096"]);
    expect(pinned).not.toContain("--max-old-space-size=8192");
    expect(pinned.filter((argument) => argument === "--max-old-space-size=4096")).toHaveLength(1);
    expect(pinned.indexOf("--max-old-space-size=4096")).toBeLessThan(pinned.indexOf("/opt/flavor/cli-main.js"));
    // Below the headroom floor the default V8 limit stands.
    totalmem.mockReturnValue(8 * GB);
    expect(cliMainArguments("/opt/flavor/cli-main.js", [])).not.toContain("--max-old-space-size=8192");
  });
});

describe("light command detection", () => {
  it("skips the relaunch for short-lived subcommands that never create a runtime", () => {
    for (const argv of [
      ["--version"], ["-v"], ["--help"], ["-h"], ["help"],
      ["doctor"], ["doctor", "--json", "C:\\work"], ["init"], ["init", "subdir"],
      ["update"], ["skills"], ["skills", "list"], ["memory", "list"], ["mcp", "list"],
      ["sessions", "list"], ["config", "list"], ["usage"],
      ["eval", "spec.json"], ["completion", "bash"],
    ]) {
      expect(isLightCommand(argv), argv.join(" ")).toBe(true);
    }
  });

  it("keeps the full diagnostic relaunch for runtime-bearing invocations", () => {
    for (const argv of [
      [], ["--print", "hello"], ["-p"], ["--resume", "session-1"], ["--mode", "rpc"],
      ["--pal-name", "buddy"], ["--pals-broker", "\\\\.\\pipe\\flavor-code-pals-u-0123456789abcdef-v1"],
      ["unknown-command"],
    ]) {
      expect(isLightCommand(argv), argv.join(" ")).toBe(false);
    }
  });

  it("detects static --print usage errors so they never pay for the relaunch", () => {
    expect(isStaticUsageError(["--print", "hi", "--output-format", "bogus"])).toBe(true);
    expect(isStaticUsageError(["-p", "hi", "--output-format=xml"])).toBe(true);
    expect(isStaticUsageError(["-p", "hi", "--permission-mode", "yolo"])).toBe(true);
    expect(isStaticUsageError(["-p", "hi", "--output-format", "json"])).toBe(false);
    expect(isStaticUsageError(["-p", "hi", "--permission-mode", "acceptEdits"])).toBe(false);
    expect(isStaticUsageError(["--print", "hi"])).toBe(false);
    expect(isStaticUsageError([])).toBe(false);
  });
});
