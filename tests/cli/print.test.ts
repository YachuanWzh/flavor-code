import { expect, it, vi } from "vitest";
import { runPrint } from "../../src/cli.js";
import type { ProductionRuntime } from "../../src/production.js";
import type { ProductionRuntimeOptions } from "../../src/production.js";

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

it("prints task snapshots as static progress without animation", async () => {
  const output: string[] = [];
  const createRuntime = async (options: ProductionRuntimeOptions) => ({
    session: {
      start: async () => {},
      submit: async () => {
        options.output({ type: "tasks", snapshot: {
          plan: { tasks: [{
            id: "test", subject: "Run tests", activeForm: "Running tests",
            status: "in_progress", dependencies: [],
          }] },
          subagents: { states: {} },
          foregroundTaskId: "test",
        } });
      },
      close: async () => {},
    },
    dispose: async () => {},
  } as unknown as ProductionRuntime);

  const code = await runPrint("test", { createRuntime, stdout: (text) => output.push(text), stderr: () => {} });

  expect(code).toBe(0);
  expect(output.join("")).toContain("· Running tests · running");
  expect(output.join("")).not.toMatch(/[⠋⠙⠹⠸]/u);
});
