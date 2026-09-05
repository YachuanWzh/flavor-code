import { afterEach, describe, expect, it, vi } from "vitest";

import { cliMainArguments, needsRelaunch } from "../../src/launcher.js";

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
      .toEqual(["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "--expose-gc", "/opt/flavor/cli-main.js"]);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror"] })).toBe(true);
    // The heap watermarks are GC-verified, so a runtime without --expose-gc still needs a relaunch.
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1"] })).toBe(true);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "--expose-gc"] })).toBe(false);
  });

  it("does not disable Maglev for a heap-OOM report signature", () => {
    expect(cliMainArguments("C:\\flavor\\cli-main.js", ["--resume", "session-1"]))
      .toEqual(["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "--expose-gc", "C:\\flavor\\cli-main.js", "--resume", "session-1"]);
  });

  it("gives a larger heap only on machines with room to spare and no user-pinned heap", () => {
    totalmem.mockReturnValue(16 * GB);
    expect(cliMainArguments("/opt/flavor/cli-main.js", [])).toContain("--max-old-space-size=8192");
    // A user-pinned heap always wins, so we never fight an explicit choice.
    expect(cliMainArguments("/opt/flavor/cli-main.js", ["--max-old-space-size=4096"])).not.toContain("--max-old-space-size=8192");
    // Below the headroom floor the default V8 limit stands.
    totalmem.mockReturnValue(8 * GB);
    expect(cliMainArguments("/opt/flavor/cli-main.js", [])).not.toContain("--max-old-space-size=8192");
  });
});
