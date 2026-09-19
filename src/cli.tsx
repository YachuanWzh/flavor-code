import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import chalk from "chalk";

import { installCrashGuard } from "./utils/crash-guard.js";
import { message } from "./utils/error.js";
import { MEMORY_RESTART_EXIT_CODE } from "./utils/memory-restart.js";
import { redactErrorText } from "./utils/redact.js";
import { packageVersion } from "./utils/version.js";
import { staticTaskLines } from "./ui/task-progress-model.js";
import { installUiUserTimingSweeper } from "./ui/user-timing.js";
import { registerMemoryCommands } from "./memory/cli.js";
import { registerMcpCommands } from "./mcp/cli.js";
import { MAX_ALIAS_LENGTH } from "./pals/protocol.js";

// Runtime-heavy modules are imported lazily inside the actions that need them
// so light commands (--version, doctor, init, …) never pay for loading the
// full production graph. These type-only imports are erased at build time.
import type { ProductionRuntime, ProductionRuntimeOptions } from "./production.js";
import type { DoctorReport } from "./doctor.js";
import type { UpdateOutcome } from "./update/apply.js";
import type { SessionOutput } from "./ui/session.js";
import type { PermissionMode } from "./config/schema.js";
import type { TraceRecorder } from "./trace/recorder.js";

export interface InteractiveCliProps {
  workspace: string;
  home: string;
  resumeSession?: string | true;
  instanceId: string;
  palAlias?: string;
}

export interface CliDependencies {
  isTTY?(): boolean;
  randomUUID?(): string;
  runBroker?: typeof import("./pals/broker-cli.js").runPalBroker;
  runInteractive?(props: InteractiveCliProps): Promise<void>;
  runUpdate?(options?: Parameters<typeof import("./update/apply.js").runUpdate>[0]): Promise<UpdateOutcome>;
  runDoctor?(options?: Parameters<typeof import("./doctor.js").runDoctor>[0]): Promise<DoctorReport>;
}

const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];
const PRINT_PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

export interface PrintOptions {
  outputFormat?: OutputFormat;
  permissionMode?: PermissionMode;
  allowedTools?: readonly string[];
  model?: string;
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const program = new Command()
    .name("flavor")
    .description("Interactive coding agent")
    .version(packageVersion())
    .option("-p, --print [prompt]", "run one prompt without the interactive UI (prompt may come from stdin)")
    .option("--output-format <format>", `--print output format: ${OUTPUT_FORMATS.join(", ")}`, "text")
    .option("--permission-mode <mode>", `--print permission mode: ${PRINT_PERMISSION_MODES.join(", ")}`)
    .option("--allowed-tools <patterns>", "comma-separated tools auto-approved in --print mode, e.g. \"Read,Shell(npm test:*)\"")
    .option("--model <provider:model>", "override the main model for this run")
    .option("--resume [session-id]", "resume a saved session (latest when id is omitted)")
    .option("--mode <mode>", "runtime mode: interactive or rpc")
    .option("--workspace <path>", "workspace path (RPC mode)")
    .option("--rpc-approvals", "allow an RPC client to resolve interactive tool approvals")
    .option("--rpc-streamed-writes", "stream proposed file writes to an RPC client before committing them")
    .option("--trace <path>", "write a redacted JSONL execution trace")
    .option("--pal-name <alias>", "name this interactive Flavor instance for /pals and /chat")
    .addOption(new Option("--memory-restart").hideHelp())
    .addOption(new Option("--pals-broker <address>").hideHelp());

  program
    .command("init [directory]")
    .description("Initialize Flavor project files in a directory (defaults to cwd)")
    .action(async (directory?: string) => {
      const cwd = directory ? resolve(directory) : process.cwd();
      try {
        const { initializeFlavor } = await import("./init/project.js");
        const result = await initializeFlavor(cwd);
        process.stdout.write(`${result.created ? "Created" : "Updated"} ${result.path}\n`);
      } catch (error) {
        process.stderr.write(`init: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("update")
    .description("Update the globally installed flavor-code package to the latest npm release")
    .action(async () => {
      const { NPM_PACKAGE_NAME } = await import("./update/check.js");
      try {
        const outcome = await (dependencies.runUpdate ?? (await import("./update/apply.js")).runUpdate)();
        switch (outcome.status) {
          case "up-to-date":
            process.stdout.write(`${NPM_PACKAGE_NAME} is already up to date (v${outcome.current}).\n`);
            break;
          case "updated":
            process.stdout.write(`Updated ${NPM_PACKAGE_NAME} v${outcome.current} \u2192 v${outcome.latest}. Restart flavor to use it.\n`);
            break;
          case "check-failed":
            process.stderr.write("update: could not reach the npm registry to determine the latest version.\n");
            process.exitCode = 1;
            break;
          case "install-failed":
            process.stderr.write(`update: npm install failed${outcome.exitCode === null ? " (npm could not be started)" : ` with exit code ${outcome.exitCode}`}. Install manually with: npm i -g ${NPM_PACKAGE_NAME}\n`);
            process.exitCode = 1;
            break;
        }
      } catch (error) {
        process.stderr.write(`update: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("doctor [directory]")
    .description("Diagnose the local Flavor runtime, configuration, tools, plugins, and npm access")
    .option("--json", "print the report as JSON")
    .action(async (directory: string | undefined, command: { json?: boolean }) => {
      try {
        const doctor = await import("./doctor.js");
        const report = await (dependencies.runDoctor ?? doctor.runDoctor)({
          workspace: resolve(directory ?? process.cwd()),
          home: homedir(),
        });
        process.stdout.write(command.json ? `${JSON.stringify(report, null, 2)}\n` : doctor.formatDoctorReport(report));
        if (!report.ok) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`doctor: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });

  const skills = program.command("skills").description("List and enable or disable project skills");
  skills.command("list", { isDefault: true }).description("List skills visible in the current project").action(async () => {
    try {
      const { SkillManager } = await import("./skills/manager.js");
      const entries = await new SkillManager({ workspace: process.cwd(), home: homedir() }).list();
      if (entries.length === 0) process.stdout.write("No skills found.\n");
      else for (const skill of entries) {
        process.stdout.write(`${skill.enabled ? "on " : "off"}  ${skill.name}  [${skill.source}]  ${skill.description}\n`);
      }
    } catch (error) {
      process.stderr.write(`skills: ${safeError(error)}\n`);
      process.exitCode = 1;
    }
  });
  for (const enabled of [true, false]) {
    const action = enabled ? "enable" : "disable";
    skills.command(`${action} <name>`).description(`${enabled ? "Enable" : "Disable"} a skill for this project`).action(async (name: string) => {
      try {
        const { SkillManager } = await import("./skills/manager.js");
        await new SkillManager({ workspace: process.cwd(), home: homedir() }).setEnabled(name, enabled);
        process.stdout.write(`${enabled ? "Enabled" : "Disabled"} ${name}.\n`);
      } catch (error) {
        process.stderr.write(`skills: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });
  }

  registerMemoryCommands(program);
  registerMcpCommands(program);
  program.command("eval <spec>")
    .option("--output <path>", "write the JSON report to a file")
    .description("run a repeatable coding-agent evaluation")
    .action(async (spec: string, command: { output?: string }) => {
      const { runEvaluationFile } = await import("./eval/cli.js");
      process.exitCode = await runEvaluationFile(spec, command.output);
    });

  program.action(async (options: {
    print?: string | boolean; outputFormat?: string; permissionMode?: string; allowedTools?: string; model?: string;
    resume?: string | boolean; mode?: string; workspace?: string; trace?: string; rpcApprovals?: boolean; rpcStreamedWrites?: boolean;
    palName?: string; palsBroker?: string; memoryRestart?: boolean;
  }) => {
    if (options.palsBroker !== undefined) {
      if (!isLocalPalBrokerAddress(options.palsBroker, process.platform)) {
        throw new Error("Invalid local pals broker address");
      }
      const { runPalBroker } = await import("./pals/broker-cli.js");
      const broker = await (dependencies.runBroker ?? runPalBroker)({ address: options.palsBroker });
      await broker.closed;
      return;
    }
    const resumeSession = options.resume === true ? true : typeof options.resume === "string" ? options.resume : undefined;
    if (options.mode === "rpc") {
      process.exitCode = await runRpcMode({
        workspace: resolve(options.workspace ?? process.cwd()),
        ...(resumeSession === undefined ? {} : { resumeSession }),
        ...(options.trace === undefined ? {} : { trace: resolve(options.trace) }),
        interactiveApprovals: options.rpcApprovals === true,
        streamedWrites: options.rpcStreamedWrites === true,
      });
      return;
    }
    if (options.mode !== undefined && options.mode !== "interactive") {
      process.stderr.write(`Unsupported mode: ${options.mode}\n`);
      process.exitCode = 2;
      return;
    }
    if (options.print !== undefined) {
      const outputFormat = options.outputFormat ?? "text";
      if (!(OUTPUT_FORMATS as readonly string[]).includes(outputFormat)) {
        process.stderr.write(`Unsupported output format: ${outputFormat}\n`);
        process.exitCode = 2;
        return;
      }
      let permissionMode: PermissionMode | undefined;
      if (options.permissionMode !== undefined) {
        if (!(PRINT_PERMISSION_MODES as readonly string[]).includes(options.permissionMode)) {
          process.stderr.write(`Unsupported permission mode: ${options.permissionMode}\n`);
          process.exitCode = 2;
          return;
        }
        permissionMode = options.permissionMode as PermissionMode;
      }
      const prompt = typeof options.print === "string" ? options.print : await readStdinPrompt();
      if (prompt.trim().length === 0) {
        process.stderr.write("No prompt provided. Pass --print <prompt> or pipe text via stdin.\n");
        process.exitCode = 2;
        return;
      }
      const allowedTools = options.allowedTools === undefined
        ? undefined
        : options.allowedTools.split(",").map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0);
      process.exitCode = await runPrint(prompt, {}, resumeSession, options.memoryRestart === true, {
        outputFormat: outputFormat as OutputFormat,
        ...(permissionMode === undefined ? {} : { permissionMode }),
        ...(allowedTools === undefined ? {} : { allowedTools }),
        ...(options.model === undefined ? {} : { model: options.model }),
      });
      return;
    }
    if (!(dependencies.isTTY?.() ?? process.stdin.isTTY)) {
      process.stderr.write("Interactive mode needs a TTY. Use --print <prompt> for scripts.\n");
      process.exitCode = 2;
      return;
    }
    const palAlias = options.palName === undefined ? undefined : parsePalAlias(options.palName);
    setInteractiveProcessTitle();
    const props: InteractiveCliProps = {
      workspace: process.cwd(),
      home: homedir(),
      ...(resumeSession === undefined ? {} : { resumeSession }),
      instanceId: (dependencies.randomUUID ?? randomUUID)(),
      ...(palAlias === undefined ? {} : { palAlias }),
    };
    if (dependencies.runInteractive !== undefined) {
      await dependencies.runInteractive(props);
      return;
    }
    await runInteractiveCli(props);
  });

  return program;
}

async function runInteractiveCli(props: InteractiveCliProps): Promise<void> {
  const disposeUserTimingSweeper = installUiUserTimingSweeper();
  let endedSessionId: string | undefined;
  try {
    // React is CommonJS. When tsup bundles it (noExternal) the dynamic-import
    // namespace only carries `default` (esbuild cannot statically analyze
    // React's conditional `module.exports = require(...)`), so named
    // destructuring like `{ createElement }` would be undefined. Read the
    // default export instead, which is the module.exports object in both the
    // bundled and external cases.
    const [{ render, AlternateScreen }, { default: React }, { App }] = await Promise.all([
      import("./claude-ink/index.js"), import("react"), import("./ui/app.js"),
    ]);
    const instance = await render(React.createElement(AlternateScreen, { mouseTracking: true },
      React.createElement(App, { ...props, onSessionEnd: (sessionId: string) => { endedSessionId = sessionId; } })), { exitOnCtrlC: false });
    await instance.waitUntilExit();
  } finally {
    disposeUserTimingSweeper();
  }
  if (endedSessionId !== undefined) {
    process.stdout.write(`Resume later with: ${chalk.cyan(`flavor --resume ${endedSessionId}`)}\n`);
  }
}

function parsePalAlias(value: string): string {
  const alias = value.trim();
  if (alias.length < 1 || alias.length > MAX_ALIAS_LENGTH) {
    throw new Error(`Pal name must be between 1 and ${MAX_ALIAS_LENGTH} characters`);
  }
  return alias;
}

export function isLocalPalBrokerAddress(address: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const prefix = "\\\\.\\pipe\\flavor-code-pals-u-";
    if (!address.startsWith(prefix) || !address.endsWith("-v1")) return false;
    return /^[a-f0-9]{16}$/u.test(address.slice(prefix.length, -3));
  }
  if (!address.startsWith("/") || address.startsWith("//") || address.includes("\0")) return false;
  return posix.normalize(address) === address
    && posix.basename(address) === "pals-v1.sock"
    && posix.dirname(address) !== "/";
}

export async function runRpcMode(options: {
  workspace: string;
  resumeSession?: string | true;
  trace?: string;
  interactiveApprovals?: boolean;
  streamedWrites?: boolean;
}): Promise<number> {
  const [{ FlavorRpcServer }, { RpcWriteStreamBridge }, { TraceRecorder: Recorder }, { createProductionRuntime }] = await Promise.all([
    import("./rpc/server.js"), import("./rpc/write-stream.js"), import("./trace/recorder.js"), import("./production.js"),
  ]);
  let recorder: TraceRecorder | undefined;
  try {
    const server = new FlavorRpcServer({
      input: process.stdin,
      output: process.stdout,
      workspace: options.workspace,
      createRuntime: async ({ workspace, output }) => {
        let activeRuntime: ProductionRuntime | undefined;
        const streamedWrites = options.streamedWrites ? new RpcWriteStreamBridge(output) : undefined;
        const onApprovalChange = (): void => {
          if (!options.interactiveApprovals) return;
          const approval = activeRuntime?.approvals.pending;
          output(approval === undefined
            ? { type: "approval-cleared" }
            : { type: "approval-request", request: approval });
        };
        const runtime = await createProductionRuntime({
          workspace,
          home: homedir(),
          approvalPolicy: "deny",
          rpcToolApprovals: options.interactiveApprovals === true,
          ...(streamedWrites === undefined ? {} : { beforeFileCommit: streamedWrites.preview.bind(streamedWrites) }),
          ...(options.interactiveApprovals ? { onApprovalChange } : {}),
          ...(options.resumeSession === undefined ? {} : { resumeSession: options.resumeSession }),
          output,
        });
        activeRuntime = runtime;
        Object.defineProperty(runtime, "rpcApprovals", { value: options.interactiveApprovals === true, enumerable: true });
        if (streamedWrites !== undefined) Object.defineProperty(runtime, "rpcWrites", { value: streamedWrites, enumerable: true });
        if (options.trace !== undefined) recorder = new Recorder({
          path: options.trace, sessionId: runtime.sessionId,
        });
        return runtime;
      },
      onRecord: (kind, payload) => recorder?.record(kind, payload),
    });
    await server.start();
    await recorder?.close();
    return process.exitCode === MEMORY_RESTART_EXIT_CODE ? MEMORY_RESTART_EXIT_CODE : 0;
  } catch (error) {
    await recorder?.close().catch(() => undefined);
    process.stderr.write(`rpc: ${safeError(error)}\n`);
    return 1;
  }
}

export function setInteractiveProcessTitle(target: { title: string } = process): void {
  target.title = "Flavor Code";
}

export interface PrintDependencies {
  createRuntime?: typeof import("./production.js").createProductionRuntime;
  stdout?(text: string): void;
  stderr?(text: string): void;
}

/** Reads a piped prompt so `cat notes.txt | flavor -p "summarize"` works. */
async function readStdinPrompt(): Promise<string> {
  if (process.stdin.isTTY === true) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

interface PrintUsageSummary {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/**
 * Routes session output for --print. `text` keeps the historical plain-text
 * contract; `stream-json` emits one JSON line per event for live consumers;
 * `json` stays silent and emits a single result object at the end.
 */
function createPrintReporter(
  format: OutputFormat,
  stdout: (text: string) => void,
  stderr: (text: string) => void,
  onError?: () => void,
): {
  event(event: SessionOutput): void;
  startupError(text: string): void;
  finish(input: { sessionId?: string; code: number; restarting: boolean }): void;
} {
  let text = "";
  let usage: PrintUsageSummary | undefined;
  const errors: string[] = [];
  let sessionId: string | undefined;
  const safeJson = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
    item instanceof Error ? { name: item.name, message: item.message } : item) ?? "null";
  const writeLine = (value: unknown): void => stdout(`${safeJson(value)}\n`);

  const event = (incoming: SessionOutput): void => {
    if (incoming.type === "text") text += incoming.text;
    else if (incoming.type === "usage") {
      usage = {
        inputTokens: incoming.totalInputTokens,
        outputTokens: incoming.totalOutputTokens,
        ...(incoming.cacheReadTokens === undefined ? {} : { cacheReadTokens: incoming.cacheReadTokens }),
        ...(incoming.cacheCreationTokens === undefined ? {} : { cacheCreationTokens: incoming.cacheCreationTokens }),
      };
    } else if (incoming.type === "error") {
      errors.push(`${incoming.error.code}: ${incoming.error.message}`);
      onError?.();
    }
    if (format === "text") {
      if (incoming.type === "text") stdout(incoming.text);
      else if (incoming.type === "notice") stdout(`${incoming.message}\n`);
      else if (incoming.type === "tasks") {
        for (const line of staticTaskLines(incoming.snapshot)) stdout(`${line}\n`);
      } else if (incoming.type === "error") stderr(`${incoming.error.code}: ${incoming.error.message}\n`);
      return;
    }
    if (format === "stream-json") writeLine(incoming);
  };

  const startupError = (detail: string): void => {
    errors.push(detail);
    if (format === "text") stderr(`${detail}\n`);
    else if (format === "stream-json") writeLine({ type: "error", error: { code: "startup", message: detail } });
  };

  const finish = (input: { sessionId?: string; code: number; restarting: boolean }): void => {
    sessionId = input.sessionId ?? sessionId;
    if (format === "json") {
      writeLine({
        type: "result",
        subtype: input.code === 0 ? "success" : "error",
        ...(sessionId === undefined ? {} : { sessionId }),
        result: text,
        ...(usage === undefined ? {} : { usage }),
        ...(errors.length === 0 ? {} : { errors }),
        exitCode: input.code,
      });
      return;
    }
    if (format === "stream-json") {
      writeLine({
        type: "result",
        subtype: input.code === 0 ? "success" : "error",
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(usage === undefined ? {} : { usage }),
        exitCode: input.code,
      });
      return;
    }
    if (input.code === 0 && !input.restarting) stdout("\n");
  };

  return { event, startupError, finish };
}

export async function runPrint(
  prompt: string,
  dependencies: PrintDependencies = {},
  resumeSession?: string | true,
  memoryRestart = false,
  printOptions: PrintOptions = {},
): Promise<number> {
  let code = 0;
  let runtime: ProductionRuntime;
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  const format = printOptions.outputFormat ?? "text";
  const reporter = createPrintReporter(format, stdout, stderr, () => { code = 1; });
  try {
    const createRuntime = dependencies.createRuntime ?? (await import("./production.js")).createProductionRuntime;
    runtime = await createRuntime({
      workspace: process.cwd(), home: homedir(), approvalPolicy: "deny",
      ...(resumeSession === undefined ? {} : { resumeSession }),
      ...(printOptions.permissionMode === undefined ? {} : { permissionMode: printOptions.permissionMode }),
      ...(printOptions.allowedTools === undefined ? {} : { headlessToolAllowlist: printOptions.allowedTools }),
      ...(printOptions.model === undefined ? {} : { modelOverride: printOptions.model }),
      output: reporter.event,
    });
  } catch (error) {
    reporter.startupError(`startup: ${safeError(error)}`);
    reporter.finish({ code: 2, restarting: false });
    return 2;
  }
  try {
    await runtime.session.start();
    if (runtime.session.rotationContinuationResumed) {
      // start() admitted the persisted /loop or /goal. Wait for that task;
      // replaying --print would create a second long-running command.
      await runtime.session.whenIdle();
    } else if (!memoryRestart) {
      await runtime.session.submit(prompt);
    }
  } catch (error) {
    reporter.startupError(`runtime: ${safeError(error)}`); code = 1;
  } finally {
    try { await runtime.session.close(); }
    catch (error) { reporter.startupError(`runtime: ${safeError(error)}`); code = 1; }
    try { await runtime.dispose(); }
    catch (error) { reporter.startupError(`runtime: ${safeError(error)}`); code = 1; }
  }
  const restarting = process.exitCode === MEMORY_RESTART_EXIT_CODE;
  const finalCode = restarting ? MEMORY_RESTART_EXIT_CODE : code;
  reporter.finish({ sessionId: runtime.sessionId, code: finalCode, restarting });
  return finalCode;
}

function safeError(error: unknown): string {
  return redactErrorText(message(error));
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  // Escape hatch for any uncaught failure: write a crash log and restore the
  // terminal instead of dying silently with ANSI garbage on screen.
  installCrashGuard();
  try {
    await createProgram().parseAsync(argv);
  } catch (error) {
    process.stderr.write(`flavor: ${safeError(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]) {
  const scriptPath = fileURLToPath(import.meta.url);
  if (realpathSync(scriptPath) === realpathSync(process.argv[1])) {
    await runCli();
  }
}
