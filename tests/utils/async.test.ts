import { describe, expect, it } from "vitest";
import { withTimeout } from "../../src/utils/async.js";

describe("withTimeout", () => {
  it("resolves with the value when the promise settles before the deadline", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50)).resolves.toEqual({ timedOut: false, value: "ok" });
  });

  it("reports a timeout when the promise never settles", async () => {
    const outcome = await withTimeout(new Promise<string>(() => undefined), 10);
    expect(outcome).toEqual({ timedOut: true, value: undefined });
  });

  it("propagates the promise rejection even before the deadline", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 50)).rejects.toThrow("boom");
  });

  it("ignores a late settlement after the deadline has fired", async () => {
    let resolve!: (value: string) => void;
    const pending = new Promise<string>((r) => { resolve = r; });
    const outcomePromise = withTimeout(pending, 10);
    const outcome = await outcomePromise;
    expect(outcome.timedOut).toBe(true);
    resolve("late");
    await expect(outcomePromise).resolves.toEqual(outcome);
  });
});
