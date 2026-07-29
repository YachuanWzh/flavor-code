import type { ExecutionEnvironment, ExecutionRequest, ExecutionResult } from "./types.js";
import { DEFAULT_MAX_OUTPUT_BYTES, executeShell } from "../tools/shell.js";

export class LocalExecutionEnvironment implements ExecutionEnvironment {
  readonly kind = "local" as const;

  exec(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult> {
    const cancellation = signal ?? new AbortController().signal;
    return executeShell(request.cwd, {
      command: request.command,
      args: [...request.args],
      cwd: request.cwd,
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    }, cancellation, DEFAULT_MAX_OUTPUT_BYTES);
  }

  async dispose(): Promise<void> {}
}
