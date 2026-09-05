import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import type { JobToolPresentation, ToolDefinition } from "./types.js";
import type { ExecutionEnvironment } from "../execution/types.js";
import type { JobRegistry } from "../jobs/registry.js";
import { prepareSpawnInvocation, resolveExecutablePath } from "../utils/spawn-executable.js";
import { owner } from "./jobs.js";
import { terminateProcessTree } from "../utils/process-tree.js";

export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_SHELL_TIMEOUT_MS = 10 * 60_000;
const ELLIPSIS = "\u2026";
const TERMINATION_FAILURE_MS = 5_000;
const STREAM_CLOSE_GRACE_MS = 500;

const ShellInput = z.object({
  command: z.string().trim().min(1).refine((value) => !value.includes("\0"), "command cannot contain a null byte")
    .describe("Executable name or path. Put each argument in args; use a shell expression here only for pipes, redirects, or other shell syntax."),
  args: z.array(z.string().refine((value) => !value.includes("\0"), "argument cannot contain a null byte")
    .describe("One logical argument without surrounding shell quotes.")),
  cwd: z.string().min(1).nullable().optional(),
  timeoutMs: z.coerce.number().int().positive().max(86_400_000).nullable().optional(),
  // Accepts booleans and their string forms (weak-typed models emit "true");
  // kept transform-free so the schema converts to JSON Schema for providers.
  background: z.union([z.boolean(), z.string().refine((value) => value === "true" || value === "false")]).optional(),
});

export interface ShellToolOptions {
  maxOutputBytes?: number;
  defaultTimeoutMs?: number;
  executionEnvironment?: ExecutionEnvironment;
  jobs?: JobRegistry;
  environment?: NodeJS.ProcessEnv;
}
export interface TruncationMetadata { truncated: boolean; originalBytes: number; limitBytes: number }
export interface ShellDiagnostic {
  kind: "command-not-found" | "path-not-found" | "permission-denied" | "shell-syntax" | "timeout" | "cancelled" | "non-zero-exit";
  message: string;
  hint?: string;
}
export interface ShellResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  truncation: { stdout: TruncationMetadata; stderr: TruncationMetadata };
  terminationReason: "timeout" | "cancelled" | null;
  diagnostic?: ShellDiagnostic;
}
export interface ShellBackgroundResult extends ShellResult { jobId: string; state: "running"; command: string }

type ShellTool = Omit<ToolDefinition<z.infer<typeof ShellInput>, ShellResult | ShellBackgroundResult>, "execute"> & {
  execute(input: z.infer<typeof ShellInput>, signal: AbortSignal, context?: import("./types.js").ToolContext): Promise<ShellResult | ShellBackgroundResult>;
};

/**
 * Normalize weak model calls that stuff a whole command line into `command`
 * (e.g. `command: "git log --oneline"`). Splits only when the first token is a
 * bare command name (no path separators), so explicit paths with spaces —
 * `command: "C:\\Program Files\\node.exe"` — are left untouched.
 */
export function normalizeShellCommand(input: { command: string; args: readonly string[] }): { command: string; args: string[] } {
  const command = unquoteToken(input.command.trim());
  const args = [...input.args];
  const executable = basename(command).toLowerCase();
  if ((executable === "cmd" || executable === "cmd.exe") && /^\/[ck]$/iu.test(args[0] ?? "")) {
    return { command, args: [args[0]!, ...args.slice(1).map(unquoteToken)] };
  }
  // Script arguments are already logical values. Their leading/trailing quotes
  // can be executable syntax (e.g. PowerShell 'literal'), not transport quoting.
  if (!/\s/u.test(command) || containsShellSyntax(command)) return { command, args };
  const tokens = tokenizeCommandLine(command);
  if (tokens.length <= 1) return { command, args };
  const head = unquoteToken(tokens[0]!);
  // An unquoted executable path with spaces is ambiguous, so keep it whole.
  if (head.includes("/") || head.includes("\\")) return { command, args };
  return { command: head, args: [...tokens.slice(1).map(unquoteToken), ...args] };
}

function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\" && quote === "\"" && command[index + 1] !== undefined) {
      current += `${char}${command[index + 1]!}`;
      index += 1;
    } else if (char === "\"" || char === "'") {
      if (quote === undefined) quote = char;
      else if (quote === char) quote = undefined;
      current += char;
    } else if (/\s/u.test(char) && quote === undefined) {
      if (current !== "") {
        tokens.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current !== "") tokens.push(current);
  return tokens;
}

function unquoteToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  return (first === "\"" || first === "'") && trimmed.endsWith(first) ? trimmed.slice(1, -1) : trimmed;
}

function serializeCmdCommand(args: readonly string[]): string {
  return args.map((arg) => {
    const value = unquoteToken(arg);
    return /[\s&|<>^()]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
  }).join(" ");
}

function serializeCmdPayload(args: readonly string[]): string {
  if (args.length === 1) return unquoteToken(args[0]!);
  return args.map((arg) => /^(?:&&|\|\||[|&<>])$/u.test(arg) ? arg : serializeCmdCommand([arg])).join(" ");
}

function containsShellSyntax(command: string, platform: NodeJS.Platform | string = process.platform): boolean {
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"") index += 1;
      else if (char === "$" && quote === "\"") return true;
      continue;
    }
    if (char === "\\" && platform !== "win32") { index += 1; continue; }
    if (char === "\"" || char === "'") { quote = char; continue; }
    if (/[|&;<>`$*?()\n\r]/u.test(char)) return true;
    if (char === "[" && command.indexOf("]", index + 1) > index) return true;
    if (char === "~" && (index === 0 || /\s/u.test(command[index - 1]!)) && /[\\/]/u.test(command[index + 1] ?? "")) return true;
    if (platform === "win32" && char === "%" && /^%[A-Za-z_][A-Za-z0-9_]*%/u.test(command.slice(index))) return true;
  }
  return quote !== undefined;
}

function hasUnmatchedShellQuote(command: string): boolean {
  let quote: "\"" | "'" | undefined;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (char === "\\" && quote !== "'") { index += 1; continue; }
    if (char !== "\"" && char !== "'") continue;
    if (quote === undefined) quote = char;
    else if (quote === char) quote = undefined;
  }
  return quote !== undefined;
}

export type RuntimeShell =
  | { kind: "pwsh" | "powershell" | "cmd"; command: string }
  | { kind: "posix"; command: string };

/** The shell reported to the model, checked by doctor, and used for fallbacks. */
export function resolveRuntimeShell(
  platform: NodeJS.Platform | string = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
): RuntimeShell | undefined {
  if (platform === "win32") {
    for (const candidate of ["pwsh", "powershell"] as const) {
      const command = resolveExecutablePath(candidate, { platform: "win32", env: environment });
      if (command !== undefined) return { kind: candidate, command };
    }
    const configured = environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe";
    const command = resolveExecutablePath(configured, { platform: "win32", env: environment });
    return command === undefined ? undefined : { kind: "cmd", command };
  }
  for (const candidate of [environment.SHELL, "/bin/sh"]) {
    if (!candidate) continue;
    const command = resolveExecutablePath(candidate, { platform: platform as NodeJS.Platform, env: environment });
    if (command !== undefined) return { kind: "posix", command };
  }
  return undefined;
}

/** Quote one token as a PowerShell single-quoted string (doubling embedded quotes). */
function psQuote(token: string): string {
  return `'${token.replace(/'/g, "''")}'`;
}

interface ShellInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

function shellInvocation(input: { command: string; args: readonly string[] }, cwd: string, environment: NodeJS.ProcessEnv): ShellInvocation {
  const resolved = resolveExecutablePath(input.command, { cwd, env: environment });
  if (resolved !== undefined) {
    const executable = basename(resolved).toLowerCase();
    if (process.platform === "win32" && (executable === "cmd" || executable === "cmd.exe")) {
      const commandFlag = input.args.findIndex((arg) => /^\/[ck]$/iu.test(arg));
      if (commandFlag >= 0 && input.args[commandFlag + 1] !== undefined) {
        const payload = serializeCmdPayload(input.args.slice(commandFlag + 1));
        return {
          command: resolved,
          args: [...input.args.slice(0, commandFlag + 1), `chcp 65001>nul & ${payload}`],
          windowsVerbatimArguments: true,
        };
      }
    }
    return prepareSpawnInvocation(resolved, input.args, { cwd, env: environment });
  }
  const isScript = containsShellSyntax(input.command);

  // An explicit missing path is an input error, not a shell expression. Let
  // spawn report it directly instead of asking a shell to reinterpret it.
  if (!isScript && (isAbsolute(input.command) || /[\\/]/u.test(input.command))) {
    return { command: input.command, args: [...input.args] };
  }

  const shell = resolveRuntimeShell(process.platform, environment);
  if (shell === undefined) return { command: input.command, args: [...input.args] };
  const script = isScript
    ? appendShellArguments(shell, input.command, input.args)
    : structuredShellScript(shell, input.command, input.args);
  if (shell.kind === "posix") return { command: shell.command, args: ["-c", script] };
  if (shell.kind === "cmd") return {
    command: shell.command,
    args: ["/d", "/s", "/c", `chcp 65001>nul & ${script}`],
    windowsVerbatimArguments: true,
  };
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return {
    command: shell.command,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
  };
}

function appendShellArguments(shell: RuntimeShell, script: string, args: readonly string[]): string {
  if (args.length === 0) return script;
  if (shell.kind === "posix") return `${script} ${args.map(posixQuote).join(" ")}`;
  if (shell.kind === "cmd") return `${script} ${serializeCmdCommand(args)}`;
  return `${script} ${args.map(psQuote).join(" ")}`;
}

const POSIX_SHELL_BUILTINS = new Set([".", ":", "alias", "cd", "command", "eval", "exec", "export", "read", "set", "source", "trap", "type", "ulimit", "umask", "unalias", "unset", "wait"]);

function executionEnvironmentCommand(
  environment: ExecutionEnvironment,
  command: string,
  args: readonly string[],
): { command: string; args: string[] } {
  if (environment.kind !== "docker") return { command, args: [...args] };
  const script = containsShellSyntax(command, "linux")
    ? appendShellArguments({ kind: "posix", command: "/bin/sh" }, command, args)
    : POSIX_SHELL_BUILTINS.has(command)
      ? structuredShellScript({ kind: "posix", command: "/bin/sh" }, command, args)
      : undefined;
  return script === undefined ? { command, args: [...args] } : { command: "/bin/sh", args: ["-c", script] };
}

function structuredShellScript(shell: RuntimeShell, command: string, args: readonly string[]): string {
  if (shell.kind === "posix") return [command, ...args].map(posixQuote).join(" ");
  if (shell.kind === "cmd") return serializeCmdCommand([command, ...args]);
  // Quoted '-Name' values become positional strings for cmdlets. Bare, strictly
  // validated parameter names must remain syntax; values stay literal strings.
  const invocation = `& ${psQuote(command)}${args.length > 0 ? ` ${args.map((arg) => /^-[A-Za-z][A-Za-z0-9-]*$/u.test(arg) ? arg : psQuote(arg)).join(" ")}` : ""}`;
  return `$ErrorActionPreference='Stop'; try { ${invocation}; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE } else { exit 0 } } catch { [Console]::Error.WriteLine($_.Exception.Message); if ($_.Exception -is [System.Management.Automation.CommandNotFoundException]) { exit 127 } else { exit 1 } }`;
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function withShellDiagnostic<T extends Omit<ShellResult, "diagnostic"> & { diagnostic?: ShellDiagnostic }>(
  result: T,
  command: string,
  spawnError?: Error,
): T {
  const diagnostic = classifyShellFailure(result, command, spawnError);
  if (diagnostic === undefined) return result;
  return { ...result, diagnostic };
}

function classifyShellFailure(
  result: Pick<ShellResult, "exitCode" | "signal" | "stderr" | "terminationReason">,
  command: string,
  spawnError?: Error,
): ShellDiagnostic | undefined {
  if (result.terminationReason === "timeout") return {
    kind: "timeout", message: `Command exceeded its timeout and was terminated.`,
    hint: "Increase timeoutMs only if this command is expected to take longer.",
  };
  if (result.terminationReason === "cancelled") return { kind: "cancelled", message: "Command was cancelled." };
  if (result.exitCode === 0 && result.signal === null && spawnError === undefined) return undefined;
  if (hasUnmatchedShellQuote(command)) return {
    kind: "shell-syntax", message: "The command contains an unmatched shell quote.",
    hint: "Close the quoted value, or pass it as one unquoted args item when shell expansion is not required.",
  };

  const detail = `${spawnError?.message ?? ""}\n${result.stderr}`;
  const code = errorCode(spawnError);
  if (code === "ENOENT" && (isAbsolute(command) || /[\\/]/u.test(command))) {
    return { kind: "path-not-found", message: `Executable path "${command}" does not exist.` };
  }
  if (code === "ENOENT" || /(?:not recognized as (?:an internal|(?:a|the) name)|command not found|not found\s*$|无法将.+识别为|不是内部或外部命令)/imu.test(detail)) {
    return {
      kind: "command-not-found",
      message: `Executable "${command}" was not found by the selected runtime shell.`,
      hint: "Use a command available on PATH, or pass an existing executable path without surrounding quotes. For an unavailable PowerShell cmdlet, check Get-Command and its module in the selected shell; do not keep retrying the same command.",
    };
  }
  if (code === "EACCES" || /(?:permission denied|access is denied|拒绝访问)/iu.test(detail)) {
    return { kind: "permission-denied", message: `Command "${command}" could not be executed because access was denied.` };
  }
  if (/(?:no such file or directory|cannot find (?:the )?path|system cannot find|系统找不到指定的路径)/iu.test(detail)) {
    return { kind: "path-not-found", message: "The command referenced a path that does not exist." };
  }
  if (/(?:syntax\s*error|unexpected token|parsererror|unterminated (?:regexp|string)|语法错误)/iu.test(detail)) {
    return {
      kind: "shell-syntax", message: "The command or interpreter rejected the syntax.",
      hint: 'Pass normal arguments through args. For JavaScript use command="node", args=["-e", "<complete script>"] without an extra shell or surrounding quotes. Legacy Windows PowerShell can strip quotes when forwarding native arguments.',
    };
  }
  return {
    kind: "non-zero-exit",
    message: result.signal === null
      ? `Command exited with code ${result.exitCode ?? "unknown"}.`
      : `Command was terminated by signal ${result.signal}.`,
  };
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error ? String((error as NodeJS.ErrnoException).code) : undefined;
}

export function createShellTool(
  workspace: string,
  options: ShellToolOptions = {},
): ShellTool {
  const root = resolve(workspace);
  const environment = shellEnvironment(root, options.environment ?? process.env);
  const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("maxOutputBytes must be a positive integer");
  if (!Number.isSafeInteger(defaultTimeoutMs) || defaultTimeoutMs <= 0 || defaultTimeoutMs > 86_400_000) {
    throw new Error("defaultTimeoutMs must be a positive integer no greater than 86400000");
  }
  return {
    name: "Shell",
    description: 'Run a bounded command reliably inside the workspace. Pass a bare executable in command and one logical value per args entry, without adding surrounding shell quotes. For Node scripts use command="node", args=["-e", "<complete JavaScript>"]; do not wrap native commands in cmd /c or PowerShell -Command unless shell syntax is needed, since legacy PowerShell can strip embedded quotes. Use Grep for text searches and Read/Edit for file changes. stdout/stderr are returned verbatim and failures include a structured diagnostic. background=true returns a managed job id.',
    inputSchema: ShellInput,
    paths: (input) => [workingDirectory(root, input.cwd ?? undefined)],
    summarize: (input) => [input.command, ...input.args].join(" "),
    presentCall: (input) => ({ kind: "terminal", variant: "command", title: backgroundFlag(input.background) ? "Starting background command" : "Running command", command: [input.command, ...input.args].join(" "), state: "running" }),
    permissions: (input) => {
      const normalized = normalizeShellCommand(input);
      return {
        paths: [workingDirectory(root, input.cwd ?? undefined)],
        command: normalized.command,
        args: normalized.args,
        cwd: workingDirectory(root, input.cwd ?? undefined),
      };
    },
    presentResult: (output, input) => output && "jobId" in output
      ? ({
        kind: "job", action: "start", id: output.jobId, jobKind: "shell",
        label: [input.command, ...input.args].join(" "), state: "running",
      } satisfies JobToolPresentation)
      : { kind: "terminal", variant: "command", title: [input.command, ...input.args].join(" "), command: [input.command, ...input.args].join(" "), stdout: output.stdout, stderr: output.stderr, ...(output.diagnostic === undefined ? {} : { diagnostic: output.diagnostic.message }), exitCode: output.exitCode, state: output.terminationReason === "cancelled" ? "cancelled" : output.exitCode === 0 ? "completed" : "failed", truncated: output.truncated },
    execute: async (input, signal, context) => {
      const normalized = normalizeShellCommand(input);
      const effective = { ...input, command: normalized.command, args: normalized.args };
      const timeoutMs = effective.timeoutMs ?? defaultTimeoutMs;
      if (backgroundFlag(effective.background)) {
        if (options.jobs === undefined) throw new Error("Background shell requires a JobRegistry");
        const cancellation = new AbortController();
        const job = options.jobs.create({
          kind: "shell", owner: owner(context), label: [effective.command, ...effective.args].join(" "),
          cancel: () => cancellation.abort(new Error("Background job cancelled")),
        });
        void (async () => {
          try {
            let result: ShellResult;
            if (options.executionEnvironment === undefined) {
              result = await executeShell(root, { ...effective, timeoutMs }, cancellation.signal, maxBytes, environment, (stream, text) => job.append(stream === "stderr" ? `[stderr] ${text}` : text));
            } else {
              const invocation = executionEnvironmentCommand(options.executionEnvironment, effective.command, effective.args);
              const raw = await options.executionEnvironment.exec({
                ...invocation, cwd: workingDirectory(root, effective.cwd ?? undefined), timeoutMs, maxOutputBytes: maxBytes,
              }, cancellation.signal);
              result = boundedExecutionResult(raw, maxBytes, effective.command);
              job.append(result.stdout);
              if (result.stderr !== "") job.append(`[stderr] ${result.stderr}`);
            }
            job.complete({
              exitCode: result.exitCode,
              ...(result.diagnostic === undefined ? {} : { error: result.diagnostic.message }),
            });
          } catch (error) { job.fail(error); }
        })();
        return {
          jobId: job.id, state: "running", command: [effective.command, ...effective.args].join(" "),
          exitCode: null, signal: null, stdout: "", stderr: "", truncated: false,
          truncation: {
            stdout: { truncated: false, originalBytes: 0, limitBytes: maxBytes },
            stderr: { truncated: false, originalBytes: 0, limitBytes: maxBytes },
          },
          terminationReason: null,
        };
      }
      if (options.executionEnvironment === undefined) {
        return executeShell(root, { ...effective, timeoutMs }, signal, maxBytes, environment);
      }
      const invocation = executionEnvironmentCommand(options.executionEnvironment, effective.command, effective.args);
      const result = await options.executionEnvironment.exec({
        ...invocation,
        cwd: workingDirectory(root, effective.cwd ?? undefined),
        timeoutMs,
        maxOutputBytes: maxBytes,
      }, signal);
      return boundedExecutionResult(result, maxBytes, effective.command);
    },
  };
}

export async function executeShell(
  root: string,
  input: z.infer<typeof ShellInput>,
  cancellation: AbortSignal,
  maxBytes: number,
  environment: NodeJS.ProcessEnv = process.env,
  onOutput?: (stream: "stdout" | "stderr", text: string) => void,
): Promise<ShellResult> {
  const cwd = workingDirectory(root, input.cwd ?? undefined);
  const stdout = new BoundedOutput(maxBytes);
  const stderr = new BoundedOutput(maxBytes);
  return new Promise((resolvePromise, reject) => {
    if (cancellation.aborted) { reject(cancellation.reason); return; }
    const invocation = shellInvocation(input, cwd, environment);
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: environment,
      ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
    });
    let exitObserved = false;
    let observedExitCode: number | null = null;
    let observedSignal: NodeJS.Signals | null = null;
    let settled = false;
    let terminationReason: ShellResult["terminationReason"] = null;
    let termination: Promise<void> | undefined;
    let terminalTimer: NodeJS.Timeout | undefined;
    let streamCloseTimer: NodeJS.Timeout | undefined;
    const stdoutDecoder = onOutput === undefined ? undefined : new AdaptiveOutputDecoder();
    const stderrDecoder = onOutput === undefined ? undefined : new AdaptiveOutputDecoder();
    const terminate = (reason: Exclude<ShellResult["terminationReason"], null>) => {
      if (termination !== undefined || settled) return;
      terminationReason = reason;
      if (exitObserved || child.exitCode !== null || child.signalCode !== null) {
        child.stdout.destroy();
        child.stderr.destroy();
        void finishResolve(observedExitCode ?? child.exitCode, observedSignal ?? child.signalCode);
        return;
      }
      termination = terminateProcessTree(child.pid);
      terminalTimer = setTimeout(() => finishReject(new Error(`Process did not close after ${reason} termination`)), TERMINATION_FAILURE_MS);
      terminalTimer.unref();
    };
    const timeoutMs = input.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    child.once("spawn", () => {
      if (timeoutMs === undefined || exitObserved || settled) return;
      timer = setTimeout(() => terminate("timeout"), timeoutMs);
      timer.unref();
    });
    const onCancel = () => terminate("cancelled");
    cancellation.addEventListener("abort", onCancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout.add(chunk);
      if (stdoutDecoder !== undefined) {
        const text = stdoutDecoder.write(chunk);
        if (text !== "") onOutput?.("stdout", text);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.add(chunk);
      if (stderrDecoder !== undefined) {
        const text = stderrDecoder.write(chunk);
        if (text !== "") onOutput?.("stderr", text);
      }
    });
    child.once("exit", (exitCode, exitSignal) => {
      exitObserved = true;
      observedExitCode = exitCode;
      observedSignal = exitSignal;
      if (timer !== undefined) clearTimeout(timer);
      // A detached descendant can inherit stdout/stderr after the shell itself
      // exits. Node waits for those streams before emitting `close`, which used
      // to leave the tool card running forever. Preserve a short drain window,
      // then release the parent-side streams and report the actual shell exit.
      streamCloseTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        void finishResolve(observedExitCode, observedSignal);
      }, STREAM_CLOSE_GRACE_MS);
      streamCloseTimer.unref();
    });
    child.once("error", (error) => {
      void finishResolve(errorCode(error) === "ENOENT" ? 127 : 1, null, error);
    });
    child.once("close", (exitCode, signal) => {
      void finishResolve(exitCode, signal);
    });
    async function finishResolve(exitCode: number | null, exitSignal: NodeJS.Signals | null, spawnError?: Error): Promise<void> {
      if (settled) return;
      settled = true;
      cleanup();
      if (termination !== undefined) await termination;
      const stdoutTail = stdoutDecoder?.end() ?? "";
      const stderrTail = stderrDecoder?.end() ?? "";
      if (stdoutTail !== "") onOutput?.("stdout", stdoutTail);
      if (stderrTail !== "") onOutput?.("stderr", stderrTail);
      resolvePromise(withShellDiagnostic({
        exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
        truncation: { stdout: stdout.metadata(), stderr: stderr.metadata() },
        terminationReason,
      }, input.command, spawnError));
    }
    function finishReject(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function cleanup(): void {
      if (timer !== undefined) clearTimeout(timer);
      if (terminalTimer !== undefined) clearTimeout(terminalTimer);
      if (streamCloseTimer !== undefined) clearTimeout(streamCloseTimer);
      cancellation.removeEventListener("abort", onCancel);
    }
  });
}

class BoundedOutput {
  readonly #limit: number;
  readonly #headLimit: number;
  readonly #tailLimit: number;
  #head = Buffer.alloc(0);
  #tailChunks: Buffer[] = [];
  #tailBytes = 0;
  #complete = Buffer.alloc(0);
  #bytes = 0;

  constructor(limit: number) {
    this.#limit = limit;
    this.#headLimit = Math.ceil(limit / 2);
    this.#tailLimit = Math.floor(limit / 2);
  }

  get truncated(): boolean { return this.#bytes > this.#limit; }

  add(chunk: Buffer): void {
    this.#bytes += chunk.length;
    if (this.#complete.length < this.#limit) {
      this.#complete = Buffer.concat([this.#complete, chunk]).subarray(0, this.#limit);
    }
    if (this.#head.length < this.#headLimit) {
      const count = Math.min(this.#headLimit - this.#head.length, chunk.length);
      this.#head = Buffer.concat([this.#head, chunk.subarray(0, count)]);
    }
    if (this.#tailLimit > 0) {
      // Amortized-linear tail: queue raw chunks and only re-copy when the
      // queue doubles past the window. The previous per-chunk concat made
      // every streamed byte O(output-size), which showed up as GB-scale
      // malloc churn and CPU burn on long shell outputs.
      this.#tailChunks.push(chunk);
      this.#tailBytes += chunk.length;
      if (this.#tailBytes >= this.#tailLimit * 2) {
        const merged = Buffer.concat(this.#tailChunks).subarray(-this.#tailLimit);
        this.#tailChunks = [merged];
        this.#tailBytes = merged.length;
      }
    }
  }

  metadata(): TruncationMetadata {
    return { truncated: this.truncated, originalBytes: this.#bytes, limitBytes: this.#limit };
  }

  text(): string {
    if (!this.truncated) return decodeOutput(this.#complete);
    const tail = Buffer.concat(this.#tailChunks).subarray(-this.#tailLimit);
    const encoding = outputEncoding(this.#complete);
    return `${decodePrefix(this.#head, encoding)}${ELLIPSIS}${decodeSuffix(tail, encoding)}`;
  }
}

type OutputEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030";

class AdaptiveOutputDecoder {
  #pending = Buffer.alloc(0);
  #decoder: TextDecoder | undefined;

  write(chunk: Buffer): string {
    if (this.#decoder !== undefined) return this.#decoder.decode(chunk, { stream: true });
    this.#pending = Buffer.concat([this.#pending, chunk]);
    if (this.#pending.length === 1 && (this.#pending[0] === 0xff || this.#pending[0] === 0xfe)) return "";
    if (!this.#pending.includes(0) && this.#pending.every((byte) => byte < 0x80)) {
      const ascii = this.#pending.toString("ascii");
      this.#pending = Buffer.alloc(0);
      return ascii;
    }
    const classification = classifyUtf8(this.#pending);
    if (classification === "incomplete") return "";
    const encoding = outputEncoding(this.#pending, classification);
    this.#decoder = new TextDecoder(encoding);
    const text = this.#decoder.decode(this.#pending, { stream: true });
    this.#pending = Buffer.alloc(0);
    return text;
  }

  end(): string {
    if (this.#decoder !== undefined) return this.#decoder.decode();
    const text = decodeOutput(this.#pending);
    this.#pending = Buffer.alloc(0);
    return text;
  }
}

function backgroundFlag(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

function workingDirectory(root: string, cwd = "."): string {
  const candidate = resolve(root, cwd);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Working directory is outside the workspace");
  return candidate;
}

function decodeOutput(buffer: Buffer): string {
  const encoding = outputEncoding(buffer);
  return new TextDecoder(encoding).decode(buffer);
}

function shellEnvironment(root: string, environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const localBin = join(root, "node_modules", ".bin");
  if (!existsSync(localBin)) return environment;
  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const current = environment[pathKey] ?? "";
  const entries = current.split(delimiter).filter(Boolean);
  if (entries.some((entry) => resolve(entry) === resolve(localBin))) return environment;
  return { ...environment, [pathKey]: [localBin, ...entries].join(delimiter) };
}

function boundedExecutionResult(
  result: import("../execution/types.js").ExecutionResult,
  maxBytes: number,
  command: string,
): ShellResult {
  if (result.truncation !== undefined) {
    return withShellDiagnostic({
      ...result,
      truncated: result.truncated ?? (result.truncation.stdout.truncated || result.truncation.stderr.truncated),
      truncation: result.truncation,
    }, command);
  }
  const stdout = new BoundedOutput(maxBytes);
  const stderr = new BoundedOutput(maxBytes);
  stdout.add(Buffer.from(result.stdout));
  stderr.add(Buffer.from(result.stderr));
  return withShellDiagnostic({
    ...result,
    stdout: stdout.text(),
    stderr: stderr.text(),
    truncated: stdout.truncated || stderr.truncated,
    truncation: { stdout: stdout.metadata(), stderr: stderr.metadata() },
  }, command);
}

function outputEncoding(buffer: Buffer, utf8 = classifyUtf8(buffer)): OutputEncoding {
  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xfe) return "utf-16le";
    if (buffer[0] === 0xfe && buffer[1] === 0xff) return "utf-16be";
  }
  const sampleLength = Math.min(buffer.length, 256);
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const threshold = Math.max(2, Math.floor(sampleLength / 8));
  if (oddZeros >= threshold && oddZeros > evenZeros * 2) return "utf-16le";
  if (evenZeros >= threshold && evenZeros > oddZeros * 2) return "utf-16be";
  return utf8 === "valid" || process.platform !== "win32" ? "utf-8" : "gb18030";
}

function decodePrefix(buffer: Buffer, encoding: OutputEncoding): string {
  for (let end = buffer.length; end >= Math.max(0, buffer.length - 3); end -= 1) {
    const candidate = buffer.subarray(0, end);
    try { return new TextDecoder(encoding, { fatal: true }).decode(candidate); } catch { /* trim */ }
  }
  return new TextDecoder(encoding).decode(buffer);
}

function decodeSuffix(buffer: Buffer, encoding: OutputEncoding): string {
  for (let start = 0; start <= Math.min(3, buffer.length); start += 1) {
    const candidate = buffer.subarray(start);
    try { return new TextDecoder(encoding, { fatal: true }).decode(candidate); } catch { /* trim */ }
  }
  return new TextDecoder(encoding).decode(buffer);
}

function classifyUtf8(buffer: Buffer): "valid" | "incomplete" | "invalid" {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return "valid";
  } catch {
    const suffixLength = incompleteUtf8SuffixLength(buffer);
    if (suffixLength === 0) return "invalid";
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, buffer.length - suffixLength));
      return "incomplete";
    } catch { return "invalid"; }
  }
}

function incompleteUtf8SuffixLength(buffer: Buffer): number {
  for (let start = Math.max(0, buffer.length - 3); start < buffer.length; start += 1) {
    const lead = buffer[start]!;
    const expected = lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
    if (expected === 0 || buffer.length - start >= expected) continue;
    let continuation = true;
    for (let index = start + 1; index < buffer.length; index += 1) {
      if ((buffer[index]! & 0xc0) !== 0x80) { continuation = false; break; }
    }
    if (continuation) return buffer.length - start;
  }
  return 0;
}
