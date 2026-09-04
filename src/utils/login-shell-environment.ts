import { delimiter } from "node:path";

import { execFileNoThrow } from "./execFileNoThrow.js";

export interface LoginShellEnvironmentDependencies {
  execute?: typeof execFileNoThrow;
}

/**
 * macOS GUI applications do not inherit the user's terminal PATH. Querying a
 * bounded login shell restores Homebrew and user tool directories while
 * preserving paths Electron already supplied. Failure is deliberately soft.
 */
export async function loginShellEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string = process.platform,
  dependencies: LoginShellEnvironmentDependencies = {},
): Promise<NodeJS.ProcessEnv> {
  if (platform !== "darwin") return { ...environment };
  const shell = environment.SHELL || "/bin/zsh";
  const result = await (dependencies.execute ?? execFileNoThrow)(
    shell,
    ["-l", "-c", "command env"],
    { timeout: 2_000, useCwd: false, env: environment },
  );
  if (result.code !== 0) return { ...environment };
  const loginPath = result.stdout.split(/\r?\n/u)
    .filter((line) => line.startsWith("PATH="))
    .at(-1)?.slice(5);
  if (!loginPath) return { ...environment };
  const currentPath = environment.PATH ?? "";
  const entries = [...loginPath.split(delimiter), ...currentPath.split(delimiter)]
    .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
  return { ...environment, PATH: entries.join(delimiter) };
}
