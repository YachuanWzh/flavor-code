import { execFile } from "node:child_process";

export interface ExecFileNoThrowOptions {
  timeout?: number;
  useCwd?: boolean;
  env?: NodeJS.ProcessEnv;
  stdin?: "ignore" | "inherit" | "pipe";
  input?: string;
}

export function execFileNoThrow(
  file: string,
  args: string[],
  options: ExecFileNoThrowOptions = {},
): Promise<{ stdout: string; stderr: string; code: number; error?: string }> {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      timeout: options.timeout,
      cwd: options.useCwd === false ? undefined : process.cwd(),
      env: options.env,
      encoding: "utf8",
    }, (error, stdout, stderr) => {
      resolve({ stdout, stderr, code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
        ...(error === null ? {} : { error: error.message }) });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}
