import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EvolveStore } from "../../src/evolve/store.js";
import { runEvaluationFile } from "../../src/eval/cli.js";

vi.mock("../../src/production.js", () => ({
  createProductionRuntime: async ({ output }: { output: (event: unknown) => void }) => ({
    session: { start: async () => undefined, submit: async () => {
      output({ type: "usage", inputTokens: 4, outputTokens: 3, totalInputTokens: 4, totalOutputTokens: 3 });
    }, close: async () => undefined },
    dispose: async () => undefined,
  }),
}));

vi.mock("../../src/execution/local.js", () => ({
  LocalExecutionEnvironment: class {
    kind = "local";
    async exec({ cwd }: { cwd: string }) {
      return { exitCode: cwd.endsWith("candidate") ? 0 : 1, signal: null, stdout: "", stderr: "", terminationReason: null };
    }
    async dispose() { /* no process to close */ }
  },
}));

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("flavor eval --baseline", () => {
  it("writes a full user report and a compact local comparison record", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-eval-compare-"));
    roots.push(root);
    const baseline = join(root, "baseline");
    const candidate = join(root, "candidate");
    await Promise.all([mkdir(baseline), mkdir(candidate)]);
    const spec = join(root, "case.json");
    const output = join(root, "report.json");
    await writeFile(spec, JSON.stringify({ name: "parser", workspace: "candidate", prompt: "fix parser",
      verification: [{ command: "test", args: [] }] }));
    expect(await runEvaluationFile(spec, output, baseline)).toBe(0);
    expect(JSON.parse(await readFile(output, "utf8"))).toMatchObject({ verdict: "improved", passed: true });
    expect((await new EvolveStore({ workspace: candidate }).comparisons())[0])
      .toMatchObject({ caseName: "parser", verdict: "improved", baseline: { checksPassed: 0 }, candidate: { checksPassed: 1 } });
    await expect(runEvaluationFile(spec, output, candidate)).rejects.toThrow(/separate, non-nested/);
  });
});
