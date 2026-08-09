import type { ExecutionEnvironment } from "../execution/types.js";
import type { SessionOutput } from "../ui/session.js";

const DEFAULT_VERIFICATION_TIMEOUT_MS = 10 * 60_000;

export interface EvaluationSpec {
  name: string;
  workspace: string;
  prompt: string;
  verification: Array<{ command: string; args: string[]; timeoutMs?: number }>;
  maxTokens?: number;
}

export interface EvaluationRuntimeLike {
  session: { start(): Promise<void>; submit(prompt: string): Promise<void>; close(): Promise<void> };
  dispose(): Promise<void>;
}

export interface EvaluationDependencies {
  createRuntime(options: { workspace: string; output(event: SessionOutput): void }): Promise<EvaluationRuntimeLike>;
  executionEnvironment: ExecutionEnvironment;
  now?: () => number;
}

export interface EvaluationReport {
  name: string;
  workspace: string;
  passed: boolean;
  durationMs: number;
  tokens: { input: number; output: number; total: number; withinBudget: boolean };
  verification: Array<{ command: string; exitCode: number | null; passed: boolean; stdout: string; stderr: string }>;
}

export async function runEvaluation(spec: EvaluationSpec, dependencies: EvaluationDependencies): Promise<EvaluationReport> {
  const now = dependencies.now ?? Date.now;
  const started = now();
  let input = 0;
  let output = 0;
  const runtime = await dependencies.createRuntime({
    workspace: spec.workspace,
    output: (event) => {
      if (event.type === "usage") {
        input = event.totalInputTokens;
        output = event.totalOutputTokens;
      } else if (event.type === "done" && input === 0 && output === 0) {
        input = event.usage.inputTokens;
        output = event.usage.outputTokens;
      }
    },
  });
  try {
    await runtime.session.start();
    await runtime.session.submit(spec.prompt);
  } finally {
    await runtime.session.close();
    await runtime.dispose();
  }
  const verification = [];
  for (const check of spec.verification) {
    const result = await dependencies.executionEnvironment.exec({
      command: check.command,
      args: check.args,
      cwd: spec.workspace,
      timeoutMs: check.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
    });
    verification.push({
      command: [check.command, ...check.args].join(" "),
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  const total = input + output;
  const withinBudget = spec.maxTokens === undefined || total <= spec.maxTokens;
  return {
    name: spec.name,
    workspace: spec.workspace,
    passed: withinBudget && verification.every((item) => item.passed),
    durationMs: Math.max(0, now() - started),
    tokens: { input, output, total, withinBudget },
    verification,
  };
}
