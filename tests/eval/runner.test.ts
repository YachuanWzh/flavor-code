import { describe, expect, it, vi } from "vitest";

import { runEvaluation, runPairedEvaluation } from "../../src/eval/runner.js";

describe("runEvaluation", () => {
  it("runs one case in isolated baseline and candidate workspaces and reports the difference", async () => {
    const workspaces: string[] = [];
    const report = await runPairedEvaluation({ name: "parser", baselineWorkspace: "/baseline",
      candidateWorkspace: "/candidate", prompt: "fix parser",
      verification: [{ command: "npm", args: ["test"] }] }, {
      createRuntime: async ({ workspace, output }) => {
        workspaces.push(workspace);
        output({ type: "usage", inputTokens: 4, outputTokens: 3, totalInputTokens: 4, totalOutputTokens: 3 });
        return { session: { start: async () => undefined, submit: async () => undefined,
          close: async () => undefined }, dispose: async () => undefined };
      },
      executionEnvironment: { kind: "local", dispose: async () => undefined,
        exec: async ({ cwd }) => ({ exitCode: cwd === "/candidate" ? 0 : 1, signal: null,
          stdout: "", stderr: "", terminationReason: null }) },
    });
    expect(workspaces).toEqual(["/baseline", "/candidate"]);
    expect(report.verdict).toBe("improved");
    expect(report.passed).toBe(true);
    expect(report.baseline.passed).toBe(false);
    expect(report.candidate.passed).toBe(true);
  });

  it("treats an agent error or lost verification as a regression", async () => {
    const report = await runPairedEvaluation({ name: "safe change", baselineWorkspace: "/baseline",
      candidateWorkspace: "/candidate", prompt: "fix parser",
      verification: [{ command: "npm", args: ["test"] }] }, {
      createRuntime: async ({ workspace, output }) => {
        if (workspace === "/candidate") output({ type: "error", error: { code: "unknown", message: "failed" } });
        return { session: { start: async () => undefined, submit: async () => undefined,
          close: async () => undefined }, dispose: async () => undefined };
      },
      executionEnvironment: { kind: "local", dispose: async () => undefined,
        exec: async () => ({ exitCode: 0, signal: null, stdout: "", stderr: "", terminationReason: null }) },
    });
    expect(report.verdict).toBe("regressed");
    expect(report.candidate.agentError).toBe(true);
    expect(report.passed).toBe(false);
  });

  it("reports verification and token-budget outcomes with injected dependencies", async () => {
    const submit = vi.fn(async () => undefined);
    const exec = vi.fn(async () => ({
      exitCode: 0, signal: null, stdout: "ok", stderr: "", terminationReason: null as null,
    }));
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
        exec,
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
    expect(exec).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 600_000 }));
  });
});
