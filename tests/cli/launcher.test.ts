import { describe, expect, it } from "vitest";

import { cliMainArguments, needsRelaunch } from "../../src/launcher.js";

describe("CLI runtime launcher", () => {
  it("relaunches any runtime so the fatal-error diagnostic report is active", () => {
    const runtime = {
      execArgv: [] as string[],
    };
    expect(needsRelaunch(runtime)).toBe(true);
    expect(cliMainArguments("/opt/flavor/cli-main.js", []))
      .toEqual(["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "/opt/flavor/cli-main.js"]);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror"] })).toBe(true);
    expect(needsRelaunch({ ...runtime, execArgv: ["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1"] })).toBe(false);
  });

  it("does not disable Maglev for a heap-OOM report signature", () => {
    expect(cliMainArguments("C:\\flavor\\cli-main.js", ["--resume", "session-1"]))
      .toEqual(["--report-on-fatalerror", "--heapsnapshot-near-heap-limit=1", "C:\\flavor\\cli-main.js", "--resume", "session-1"]);
  });
});
