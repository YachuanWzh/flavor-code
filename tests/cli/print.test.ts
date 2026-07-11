import { expect, it, vi } from "vitest";
import { runPrint } from "../../src/cli.js";
import type { ProductionRuntime } from "../../src/production.js";

it("returns 2 only for startup failure and redacts credential-shaped errors", async () => {
  const errors: string[] = [];
  const code = await runPrint("hello", {
    createRuntime: async () => { throw new Error("apiKey=sk-super-secret"); },
    stdout: () => {}, stderr: (text) => errors.push(text),
  });
  expect(code).toBe(2); expect(errors.join(" ")).not.toContain("sk-super-secret");
});

it("returns 1 for prompt/Stop failure and always closes and disposes", async () => {
  const close = vi.fn(async () => {}); const dispose = vi.fn(async () => {});
  const runtime = {
    session: { start: async () => {}, submit: async () => { throw new Error("Stop failed"); }, close }, dispose,
  } as unknown as ProductionRuntime;
  const code = await runPrint("hello", { createRuntime: async () => runtime, stdout: () => {}, stderr: () => {} });
  expect(code).toBe(1); expect(close).toHaveBeenCalledOnce(); expect(dispose).toHaveBeenCalledOnce();
});
