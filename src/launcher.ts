import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";

export interface LauncherRuntime {
  platform: NodeJS.Platform | string;
  osRelease: string;
  nodeVersion: string;
  execArgv: readonly string[];
}

/**
 * Windows 11 build 26200 can crash inside V8's Maglev tier instead of raising
 * a JavaScript error (nodejs/node#62260). Node 24 is affected on the machine
 * where Flavor reproduced it; the upstream report covers the same build on
 * newer V8 releases. Keep the workaround enabled for every future Node major
 * until the affected Windows build is no longer in service. A tiny launcher
 * must apply the flag before loading the
 * real CLI because fatal native crashes bypass crash-guard.ts entirely.
 */
export function needsWindowsMaglevWorkaround(runtime: LauncherRuntime): boolean {
  if (runtime.platform !== "win32") return false;
  const build = Number(runtime.osRelease.split(".")[2]);
  const major = Number(runtime.nodeVersion.replace(/^v/u, "").split(".")[0]);
  if (build !== 26200 || major < 24) return false;
  return !runtime.execArgv.some((argument) => argument === "--no-maglev" || argument === "--jitless");
}

export function cliMainArguments(runtime: LauncherRuntime, mainPath: string, argv: readonly string[]): string[] {
  return [
    ...(needsWindowsMaglevWorkaround(runtime) ? ["--no-maglev"] : []),
    mainPath,
    ...argv,
  ];
}

export async function launchCli(): Promise<void> {
  const mainUrl = new URL("./cli-main.js", import.meta.url);
  const runtime: LauncherRuntime = {
    platform: process.platform,
    osRelease: release(),
    nodeVersion: process.version,
    execArgv: process.execArgv,
  };

  if (!needsWindowsMaglevWorkaround(runtime)) {
    const cli = await import(mainUrl.href) as typeof import("./cli.js");
    await cli.runCli(process.argv);
    return;
  }

  const child = spawn(process.execPath,
    cliMainArguments(runtime, fileURLToPath(mainUrl), process.argv.slice(2)),
    { stdio: "inherit" });

  // Both processes share the Windows console. Let the real CLI own Ctrl+C;
  // otherwise the idle launcher can exit before its child restores the TUI.
  const ignoreSignal = (): void => {};
  process.on("SIGINT", ignoreSignal);
  process.on("SIGBREAK", ignoreSignal);
  try {
    const code = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolvePromise(exitCode ?? 1));
    });
    process.exitCode = code;
  } finally {
    process.off("SIGINT", ignoreSignal);
    process.off("SIGBREAK", ignoreSignal);
  }
}

if (process.argv[1]) {
  const scriptPath = fileURLToPath(import.meta.url);
  if (realpathSync(scriptPath) === realpathSync(process.argv[1])) {
    try {
      await launchCli();
    } catch (error) {
      process.stderr.write(`flavor launcher: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
