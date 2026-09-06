import { performance } from "node:perf_hooks";
import { PassThrough } from "node:stream";

import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUiUserTimingEntries, installUiUserTimingSweeper } from "../../src/ui/user-timing.js";

afterEach(() => clearUiUserTimingEntries());

describe("Ink User Timing retention guard", () => {
  it("clears marks and measures created by a development renderer", () => {
    performance.mark("flavor-test-start");
    performance.measure("flavor-test-measure", "flavor-test-start");
    expect(performance.getEntriesByType("measure")).not.toHaveLength(0);
    clearUiUserTimingEntries();
    expect(performance.getEntriesByType("measure")).toHaveLength(0);
    expect(performance.getEntriesByType("mark")).toHaveLength(0);
  });

  it("keeps actual Ink component commits bounded in a long-lived source/dev TUI", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousTimeStamp = console.timeStamp;
    process.env.NODE_ENV = "development";
    Object.assign(console, { timeStamp: (): void => undefined });
    vi.resetModules();
    const { Text, renderSync } = await import("../../src/claude-ink/index.js");
    const frame = (value: number): React.ReactElement => React.createElement(Text, null, `frame ${value}`);
    const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => undefined });
    const stderr = new PassThrough();
    stdout.resume();
    stderr.resume();
    let stopSweeper = (): void => undefined;
    const instance = renderSync(frame(0), {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      exitOnCtrlC: false,
      patchConsole: false,
    });
    try {
      for (let value = 1; value <= 100; value += 1) instance.rerender(frame(value));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(performance.getEntriesByType("measure").length).toBeGreaterThan(100);

      clearUiUserTimingEntries();
      stopSweeper = installUiUserTimingSweeper(5);
      for (let value = 1; value <= 10_000; value += 1) {
        instance.rerender(frame(value));
        if (value % 25 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(performance.getEntriesByType("measure").length).toBeLessThan(100);
      expect(performance.getEntriesByType("mark").length).toBeLessThan(100);
    } finally {
      instance.unmount();
      instance.cleanup();
      stopSweeper();
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      Object.assign(console, { timeStamp: previousTimeStamp });
    }
  }, 60_000);
});
