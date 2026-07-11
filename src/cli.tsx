import { pathToFileURL } from "node:url";
import { Command } from "commander";

export function createProgram(): Command {
  return new Command().name("flavor").description("Interactive coding agent").version("0.1.0");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await createProgram().parseAsync(process.argv);
}
