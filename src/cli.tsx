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

export function createProgram(): Command {
  const program = new Command()
    .name("flavor")
    .description("Interactive coding agent")
    .version("0.7.0")
    .option("-p, --print <prompt>", "run one prompt without the interactive UI")
    .option("--resume [session-id]", "resume a saved session (latest when id is omitted)");

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

  program.action(async (options: { print?: string; resume?: string | boolean }) => {
    const resumeSession = options.resume === true ? true : typeof options.resume === "string" ? options.resume : undefined;
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
    await createProgram().parseAsync(process.argv);
  }
}
