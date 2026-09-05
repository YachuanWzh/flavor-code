import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, Option } from "commander";

import { createProductionRuntime, type ProductionRuntime } from "./production.js";
import { formatDoctorReport, runDoctor, type DoctorReport } from "./doctor.js";
import { initializeFlavor } from "./init/project.js";
import { runUpdate, type UpdateOutcome } from "./update/apply.js";
import { NPM_PACKAGE_NAME } from "./update/check.js";
import { installCrashGuard } from "./utils/crash-guard.js";
import { message } from "./utils/error.js";
import { MEMORY_RESTART_EXIT_CODE } from "./utils/memory-restart.js";
import { redactErrorText } from "./utils/redact.js";
import { packageVersion } from "./utils/version.js";
import { staticTaskLines } from "./ui/task-progress-model.js";
import { SkillManager } from "./skills/manager.js";
import { registerMemoryCommands } from "./memory/cli.js";
import { registerMcpCommands } from "./mcp/cli.js";
import { FlavorRpcServer } from "./rpc/server.js";
import { RpcWriteStreamBridge } from "./rpc/write-stream.js";
import { TraceRecorder } from "./trace/recorder.js";
import { runEvaluationFile } from "./eval/cli.js";
import { runPalBroker } from "./pals/broker-cli.js";
import { MAX_ALIAS_LENGTH } from "./pals/protocol.js";

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
  runBroker?: typeof runPalBroker;
  runInteractive?(props: InteractiveCliProps): Promise<void>;
  runUpdate?(options?: Parameters<typeof runUpdate>[0]): Promise<UpdateOutcome>;
  runDoctor?(options?: Parameters<typeof runDoctor>[0]): Promise<DoctorReport>;
}

export function createProgram(dependencies: CliDependencies = {}): Command {
  const program = new Command()
    .name("flavor")
    .description("Interactive coding agent")
    .version(packageVersion())
    .option("-p, --print <prompt>", "run one prompt without the interactive UI")
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
        const result = await initializeFlavor(cwd);
        process.stdout.write(`${result.created ? "Created" : "Updated"} ${result.path}\n`);
      } catch (error) {
        process.stderr.write(`init: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command("update")
    .description(`Update the globally installed ${NPM_PACKAGE_NAME} to the latest npm release`)
    .action(async () => {
      try {
        const outcome = await (dependencies.runUpdate ?? runUpdate)();
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
        const report = await (dependencies.runDoctor ?? runDoctor)({
          workspace: resolve(directory ?? process.cwd()),
          home: homedir(),
        });
        process.stdout.write(command.json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
        if (!report.ok) process.exitCode = 1;
      } catch (error) {
        process.stderr.write(`doctor: ${safeError(error)}\n`);
        process.exitCode = 1;
      }
    });

  const skills = program.command("skills").description("List and enable or disable project skills");
  skills.command("list", { isDefault: true }).description("List skills visible in the current project").action(async () => {
    try {
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
      process.exitCode = await runEvaluationFile(spec, command.output);
    });

  program.action(async (options: {
    print?: string; resume?: string | boolean; mode?: string; workspace?: string; trace?: string; rpcApprovals?: boolean; rpcStreamedWrites?: boolean;
    palName?: string; palsBroker?: string; memoryRestart?: boolean;
  }) => {
    if (options.palsBroker !== undefined) {
      if (!isLocalPalBrokerAddress(options.palsBroker, process.platform)) {
        throw new Error("Invalid local pals broker address");
      }
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
      process.exitCode = await runPrint(options.print, {}, resumeSession, options.memoryRestart === true);
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
    const [{ render, AlternateScreen }, { createElement }, { App }] = await Promise.all([
      import("./claude-ink/index.js"), import("react"), import("./ui/app.js"),
    ]);
    const instance = await render(createElement(AlternateScreen, { mouseTracking: true },
      createElement(App, props)), { exitOnCtrlC: false });
    await instance.waitUntilExit();
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
        if (options.trace !== undefined) recorder = new TraceRecorder({
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
  createRuntime?: typeof createProductionRuntime;
  stdout?(text: string): void;
  stderr?(text: string): void;
}

export async function runPrint(
  prompt: string,
  dependencies: PrintDependencies = {},
  resumeSession?: string | true,
  memoryRestart = false,
): Promise<number> {
  let code = 0;
  let runtime: ProductionRuntime;
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    runtime = await (dependencies.createRuntime ?? createProductionRuntime)({
      workspace: process.cwd(), home: homedir(), approvalPolicy: "deny",
      ...(resumeSession === undefined ? {} : { resumeSession }),
      output(event) {
        if (event.type === "text") stdout(event.text);
        else if (event.type === "notice") stdout(`${event.message}\n`);
        else if (event.type === "tasks") {
          for (const line of staticTaskLines(event.snapshot)) stdout(`${line}\n`);
        }
        else if (event.type === "error") { stderr(`${event.error.code}: ${event.error.message}\n`); code = 1; }
      },
    });
  } catch (error) {
    stderr(`startup: ${safeError(error)}\n`);
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
    stderr(`runtime: ${safeError(error)}\n`); code = 1;
  } finally {
    try { await runtime.session.close(); }
    catch (error) { stderr(`runtime: ${safeError(error)}\n`); code = 1; }
    try { await runtime.dispose(); }
    catch (error) { stderr(`runtime: ${safeError(error)}\n`); code = 1; }
  }
  const restarting = process.exitCode === MEMORY_RESTART_EXIT_CODE;
  if (code === 0 && !restarting) stdout("\n");
  return restarting ? MEMORY_RESTART_EXIT_CODE : code;
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
