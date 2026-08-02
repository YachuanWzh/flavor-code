import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";

import { createProductionRuntime, type ProductionRuntime } from "./production.js";
import { initializeFlavor } from "./init/project.js";
import { loadConfig } from "./config/load.js";
import { message } from "./utils/error.js";
import { redactErrorText } from "./utils/redact.js";
import { staticTaskLines } from "./ui/task-progress-model.js";
import { SkillManager } from "./skills/manager.js";
import { registerMemoryCommands } from "./memory/cli.js";
import { registerMcpCommands } from "./mcp/cli.js";
import { FlavorRpcServer } from "./rpc/server.js";
import { RpcWriteStreamBridge } from "./rpc/write-stream.js";
import { TraceRecorder } from "./trace/recorder.js";
import { runEvaluationFile } from "./eval/cli.js";

export function createProgram(): Command {
  const program = new Command()
    .name("flavor")
    .description("Interactive coding agent")
    .version("1.1.5")
    .option("-p, --print <prompt>", "run one prompt without the interactive UI")
    .option("--resume [session-id]", "resume a saved session (latest when id is omitted)")
    .option("--mode <mode>", "runtime mode: interactive or rpc")
    .option("--workspace <path>", "workspace path (RPC mode)")
    .option("--rpc-approvals", "allow an RPC client to resolve interactive tool approvals")
    .option("--rpc-streamed-writes", "stream proposed file writes to an RPC client before committing them")
    .option("--trace <path>", "write a redacted JSONL execution trace");

  program
    .command("init [directory]")
    .description("Initialize Flavor project files in a directory (defaults to cwd)")
    .action(async (directory?: string) => {
      const cwd = directory ? resolve(directory) : process.cwd();
      try {
        const home = homedir();
        const loaded = await loadConfig({ cwd, home });
        const result = await initializeFlavor(cwd, loaded.config);
        process.stdout.write(`${result.created ? "Created" : "Updated"} ${result.path}\n`);
      } catch (error) {
        process.stderr.write(`init: ${safeError(error)}\n`);
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
  }) => {
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
      process.exitCode = await runPrint(options.print, {}, resumeSession);
      return;
    }
    if (!process.stdin.isTTY) {
      process.stderr.write("Interactive mode needs a TTY. Use --print <prompt> for scripts.\n");
      process.exitCode = 2;
      return;
    }
    setInteractiveProcessTitle();
    const [{ render, AlternateScreen }, { createElement }, { App }] = await Promise.all([
      import("./claude-ink/index.js"), import("react"), import("./ui/app.js"),
    ]);
    const instance = await render(createElement(AlternateScreen, { mouseTracking: true },
      createElement(App, {
        workspace: process.cwd(), home: homedir(), ...(resumeSession === undefined ? {} : { resumeSession }),
      })), { exitOnCtrlC: false });
    await instance.waitUntilExit();
  });

  return program;
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
    return 0;
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

export async function runPrint(prompt: string, dependencies: PrintDependencies = {}, resumeSession?: string | true): Promise<number> {
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
    await runtime.session.submit(prompt);
  } catch (error) {
    stderr(`runtime: ${safeError(error)}\n`); code = 1;
  } finally {
    try { await runtime.session.close(); }
    catch (error) { stderr(`runtime: ${safeError(error)}\n`); code = 1; }
    try { await runtime.dispose(); }
    catch (error) { stderr(`runtime: ${safeError(error)}\n`); code = 1; }
  }
  if (code === 0) stdout("\n");
  return code;
}

function safeError(error: unknown): string {
  return redactErrorText(message(error));
}

if (process.argv[1]) {
  const scriptPath = fileURLToPath(import.meta.url);
  if (realpathSync(scriptPath) === realpathSync(process.argv[1])) {
    try {
      await createProgram().parseAsync(process.argv);
    } catch (error) {
      process.stderr.write(`flavor: ${safeError(error)}\n`);
      process.exitCode = 1;
    }
  }
}
