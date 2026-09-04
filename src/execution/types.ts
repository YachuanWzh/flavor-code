export interface ExecutionRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface ExecutionTruncationMetadata { truncated: boolean; originalBytes: number; limitBytes: number }

export interface ExecutionResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  terminationReason: "timeout" | "cancelled" | null;
  truncated?: boolean;
  truncation?: { stdout: ExecutionTruncationMetadata; stderr: ExecutionTruncationMetadata };
}

export interface ExecutionEnvironment {
  readonly kind: "local" | "docker";
  exec(request: ExecutionRequest, signal?: AbortSignal): Promise<ExecutionResult>;
  dispose(): Promise<void>;
}
