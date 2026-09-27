import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { EvolveStore } from "../evolve/store.js";
import { createProductionRuntime } from "../production.js";
import { createExecutionEnvironment } from "../execution/factory.js";
import { LocalExecutionEnvironment } from "../execution/local.js";
import type { ExecutionEnvironment } from "../execution/types.js";
import { EvaluationSpecSchema } from "./schema.js";
import { runEvaluation, runPairedEvaluation, type EvaluationDependencies, type EvaluationReport, type PairedEvaluationReport } from "./runner.js";

export async function runEvaluationFile(path: string, outputPath?: string, baselinePath?: string): Promise<number> {
  const specPath = resolve(path);
  const parsed = EvaluationSpecSchema.parse(JSON.parse(await readFile(specPath, "utf8")));
  const workspace = resolve(dirname(specPath), parsed.workspace);
  const spec = {
    name: parsed.name,
    prompt: parsed.prompt,
    workspace,
    verification: parsed.verification.map((step) => ({
      command: step.command,
      args: step.args,
      ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    })),
    ...(parsed.maxTokens === undefined ? {} : { maxTokens: parsed.maxTokens }),
  };
  const configured = await import("../config/load.js").then(({ loadConfig }) =>
    loadConfig({ cwd: workspace, home: process.env.USERPROFILE ?? process.env.HOME ?? workspace }));
  const environment = createExecutionEnvironment(workspace, configured.config.execution)
    ?? new LocalExecutionEnvironment();
  let baselineEnvironment: ExecutionEnvironment | undefined;
  let report: EvaluationReport | PairedEvaluationReport;
  try {
    const dependencies: EvaluationDependencies = {
      createRuntime: (options) => createProductionRuntime({
        ...options,
        home: process.env.USERPROFILE ?? process.env.HOME ?? workspace,
        approvalPolicy: "deny",
      }),
      executionEnvironment: environment,
    };
    if (baselinePath === undefined) report = await runEvaluation(spec, dependencies);
    else {
      const baselineWorkspace = resolve(baselinePath);
      if (!(await stat(baselineWorkspace)).isDirectory()) throw new Error("Baseline workspace is not a directory");
      const [realBaseline, realCandidate] = await Promise.all([realpath(baselineWorkspace), realpath(workspace)]);
      const nested = (parent: string, child: string): boolean => {
        const path = relative(parent, child);
        return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
      };
      if (nested(realBaseline, realCandidate) || nested(realCandidate, realBaseline)) {
        throw new Error("Baseline and candidate workspaces must be separate, non-nested directories");
      }
      const baselineConfigured = await import("../config/load.js").then(({ loadConfig }) =>
        loadConfig({ cwd: baselineWorkspace, home: process.env.USERPROFILE ?? process.env.HOME ?? baselineWorkspace }));
      baselineEnvironment = createExecutionEnvironment(baselineWorkspace, baselineConfigured.config.execution)
        ?? new LocalExecutionEnvironment();
      const paired = await runPairedEvaluation({ ...spec, baselineWorkspace, candidateWorkspace: workspace }, {
        ...dependencies, baselineExecutionEnvironment: baselineEnvironment,
      });
      report = paired;
      const compact = (side: EvaluationReport) => ({
        passed: side.passed, durationMs: side.durationMs, tokens: side.tokens.total,
        checksPassed: side.verification.filter((check) => check.passed).length,
        checksTotal: side.verification.length,
      });
      await new EvolveStore({ workspace }).appendComparison({
        caseName: spec.name, baseline: compact(paired.baseline), candidate: compact(paired.candidate), verdict: paired.verdict,
      });
    }
  } finally {
    await Promise.all([baselineEnvironment?.dispose(), environment.dispose()]);
  }
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath === undefined) process.stdout.write(body);
  else await writeFile(resolve(outputPath), body, "utf8");
  return report.passed ? 0 : 1;
}
