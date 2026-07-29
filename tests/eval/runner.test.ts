import { describe, expect, it, vi } from "vitest";

import { runEvaluation } from "../../src/eval/runner.js";

describe("runEvaluation", () => {
  it("reports verification and token-budget outcomes with injected dependencies", async () => {
    const submit = vi.fn(async () => undefined);
    const report = await runEvaluation({
      name: "parser",
      workspace: "/fixture",
      prompt: "fix parser",
      maxTokens: 10,
      verification: [{ command: "npm", args: ["test"] }],
    }, {
      createRuntime: async ({ output }) => {
        output({ type: "usage", inputTokens: 4, outputTokens: 3, totalInputTokens: 4, totalOutputTokens: 3 });
        return {
          session: { start: async () => undefined, submit, close: async () => undefined },
          dispose: async () => undefined,
        };
      },
      executionEnvironment: {
        kind: "local",
        exec: async () => ({ exitCode: 0, signal: null, stdout: "ok", stderr: "", terminationReason: null }),
        dispose: async () => undefined,
      },
      now: (() => {
        let value = 100;
        return () => value += 10;
      })(),
    });

    expect(submit).toHaveBeenCalledWith("fix parser");
    expect(report.passed).toBe(true);
    expect(report.tokens).toEqual({ input: 4, output: 3, total: 7, withinBudget: true });
    expect(report.verification[0]).toEqual(expect.objectContaining({ passed: true, exitCode: 0 }));
  });
});
