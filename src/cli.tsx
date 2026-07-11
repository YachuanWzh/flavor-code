import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { Command } from "commander";

import { createProductionRuntime } from "./production.js";

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

export async function runPrint(prompt: string): Promise<number> {
  let code = 0;
  let runtime;
  try {
    runtime = await createProductionRuntime({
      workspace: process.cwd(), home: homedir(), approvalPolicy: "deny",
      output(event) {
        if (event.type === "text") process.stdout.write(event.text);
        else if (event.type === "notice") process.stdout.write(`${event.message}\n`);
        else if (event.type === "error") { process.stderr.write(`${event.error.code}: ${event.error.message}\n`); code = 1; }
      },
    });
    await runtime.session.start();
    await runtime.session.submit(prompt);
    if (code === 0) process.stdout.write("\n");
    return code;
  } catch (error) {
    process.stderr.write(`startup: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  } finally {
    await runtime?.session.close();
    await runtime?.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createProgram().parseAsync(process.argv);
}
