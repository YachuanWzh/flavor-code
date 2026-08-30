import { spawn } from "node:child_process";

import { prepareSpawnInvocation } from "../utils/spawn-executable.js";
import { gt, isValidVersion } from "../utils/semver.js";
import { packageVersion } from "../utils/version.js";
import { fetchLatestVersion, NPM_PACKAGE_NAME, type UpdateCheckOptions } from "./check.js";

export type UpdateOutcome =
  | { status: "up-to-date"; current: string; latest: string }
  | { status: "updated"; current: string; latest: string }
  | { status: "check-failed"; current: string }
  | { status: "install-failed"; current: string; latest: string; exitCode: number | null };

/** Runs `command args...` with inherited stdio and resolves the exit code (null when killed). */
export type InstallRunner = (command: string, args: string[]) => Promise<number | null>;

export interface RunUpdateOptions extends UpdateCheckOptions {
  /** Injectable for tests; defaults to the installed package version. */
  current?: string;
  /** Injectable for tests; defaults to spawning npm with inherited stdio. */
  install?: InstallRunner;
  /** Injectable for tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
}

export function npmExecutable(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "npm.cmd" : "npm";
}

export const defaultInstall: InstallRunner = (command, args) => new Promise((resolve, reject) => {
  const invocation = prepareSpawnInvocation(command, args);
  const child = spawn(invocation.command, invocation.args, {
    stdio: "inherit",
    ...(invocation.windowsVerbatimArguments === undefined ? {} : { windowsVerbatimArguments: invocation.windowsVerbatimArguments }),
  });
  child.on("error", reject);
  child.on("close", (code) => resolve(code));
});

/** Check the npm registry and, when a newer release exists, install it globally. */
export async function runUpdate(options: RunUpdateOptions = {}): Promise<UpdateOutcome> {
  const current = options.current ?? packageVersion();
  const latest = await fetchLatestVersion(options);
  if (latest === undefined || !isValidVersion(latest)) return { status: "check-failed", current };
  if (!gt(latest, current)) return { status: "up-to-date", current, latest };
  const install = options.install ?? defaultInstall;
  let exitCode: number | null;
  try {
    exitCode = await install(npmExecutable(options.platform), ["install", "-g", `${NPM_PACKAGE_NAME}@${latest}`]);
  } catch {
    // npm binary missing or spawn refused: report it with the manual fallback.
    exitCode = null;
  }
  return exitCode === 0
    ? { status: "updated", current, latest }
    : { status: "install-failed", current, latest, exitCode };
}
