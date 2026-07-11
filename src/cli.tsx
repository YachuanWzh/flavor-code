import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { createProductionRuntime, type ProductionRuntime } from "./production.js";

export function createProgram(): Command {
  return new Command()
    .name("flavor")
    .description("Interactive coding agent")
    .version("0.1.0")
    .option("-p, --print <prompt>", "run one prompt without the interactive UI")
    .action(async (options: { print?: string }) => {
      if (options.print !== undefined) {
        process.exitCode = await runPrint(options.print);
        return;
      }
      if (!process.stdin.isTTY) {
        process.stderr.write("Interactive mode needs a TTY. Use --print <prompt> for scripts.\n");
        process.exitCode = 2;
        return;
      }
      const [{ render }, { createElement }, { App }] = await Promise.all([
        import("ink"), import("react"), import("./ui/app.js"),
      ]);
      const instance = render(createElement(App, { workspace: process.cwd(), home: homedir() }), { exitOnCtrlC: false });
      await instance.waitUntilExit();
    });
}

export interface PrintDependencies {
  createRuntime?: typeof createProductionRuntime;
  stdout?(text: string): void;
  stderr?(text: string): void;
}

export async function runPrint(prompt: string, dependencies: PrintDependencies = {}): Promise<number> {
  let code = 0;
  let runtime: ProductionRuntime;
  const stdout = dependencies.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = dependencies.stderr ?? ((text: string) => process.stderr.write(text));
  try {
    runtime = await (dependencies.createRuntime ?? createProductionRuntime)({
      workspace: process.cwd(), home: homedir(), approvalPolicy: "deny",
      output(event) {
        if (event.type === "text") stdout(event.text);
        else if (event.type === "notice") stdout(`${event.message}\n`);
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
  return (error instanceof Error ? error.message : String(error))
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(authorization|api[_ -]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createProgram().parseAsync(process.argv);
}
