import { expect, it, vi } from "vitest";
import type { ProductionRuntime } from "../../src/production.js";
import { shutdownRuntime, submitSafely } from "../../src/ui/app.js";

it("disposes and exits exactly once when SessionEnd fails without leaking secrets", async () => {
  const dispose = vi.fn(async () => { throw new Error("dispose failed"); }); const exit = vi.fn(); const errors: string[] = [];
  const runtime = { session: { close: async () => { throw new Error("token=sk-secret-value"); } }, dispose } as unknown as ProductionRuntime;
  await shutdownRuntime(runtime, exit, (message) => errors.push(message));
  expect(dispose).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce();
  expect(errors.join(" ")).not.toContain("sk-secret-value");
  expect(errors.join(" ")).toContain("dispose failed");
});

it("turns fire-and-forget Stop failures into rendered errors", async () => {
  const errors: string[] = [];
  await submitSafely({ submit: async () => { throw new Error("Stop hook failed"); } }, "hello", (message) => errors.push(message));
  expect(errors).toEqual(["Stop hook failed"]);
});
