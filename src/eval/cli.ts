import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { createProductionRuntime } from "../production.js";
import { createExecutionEnvironment } from "../execution/factory.js";
import { LocalExecutionEnvironment } from "../execution/local.js";
import { EvaluationSpecSchema } from "./schema.js";
import { runEvaluation } from "./runner.js";

export async function runEvaluationFile(path: string, outputPath?: string): Promise<number> {
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
  let report;
  try {
    report = await runEvaluation(spec, {
      createRuntime: (options) => createProductionRuntime({
        ...options,
        home: process.env.USERPROFILE ?? process.env.HOME ?? workspace,
        approvalPolicy: "deny",
      }),
      executionEnvironment: environment,
    });
  } finally {
    await environment.dispose();
  }
  const body = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath === undefined) process.stdout.write(body);
  else await writeFile(resolve(outputPath), body, "utf8");
  return report.passed ? 0 : 1;
}
