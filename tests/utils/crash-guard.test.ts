import { describe, expect, it } from "vitest";

import { registerCrashCleanup, runCrashCleanups } from "../../src/utils/crash-guard.js";

describe("crash cleanup registry", () => {
  it("runs every currently registered cleanup and supports unregistering", async () => {
    const calls: string[] = [];
    const removeFirst = registerCrashCleanup(async () => { calls.push("first"); });
    const removeSecond = registerCrashCleanup(() => { calls.push("second"); });
    removeSecond();

    await runCrashCleanups(100);
    removeFirst();

    expect(calls).toEqual(["first"]);
  });

  it("bounds a cleanup that does not settle", async () => {
    const remove = registerCrashCleanup(() => new Promise<void>(() => undefined));
    const started = Date.now();
    await runCrashCleanups(10);
    remove();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
