import { spawn } from "node:child_process";
import { realpathSync, readFileSync } from "node:fs";
import { release } from "node:os";
import { fileURLToPath } from "node:url";

import {
  MEMORY_RESTART_EXIT_CODE,
  memoryRestartArgs,
  memoryRestartMarkerPath,
  parseMemoryRestartMarker,
} from "./utils/memory-restart.js";

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

/** Relaunching is required whenever node flags must be applied to the CLI. */
export function needsRelaunch(runtime: LauncherRuntime): boolean {
  if (needsWindowsMaglevWorkaround(runtime)) return true;
  if (!runtime.execArgv.some((argument) => argument === "--report-on-fatalerror")) return true;
  return !runtime.execArgv.some((argument) => argument.startsWith("--heapsnapshot-near-heap-limit"));
}

export function cliMainArguments(runtime: LauncherRuntime, mainPath: string, argv: readonly string[]): string[] {
  return [
    ...(needsWindowsMaglevWorkaround(runtime) ? ["--no-maglev"] : []),
    // Fatal V8 errors (heap OOM, native crashes) bypass crash-guard.ts and
    // leave only an unusable native stack. Ask Node to dump a diagnostic
    // report next to the working directory so the next crash has a scene.
    "--report-on-fatalerror",
    // The 2026-08-29 OOM report showed 4.29GB retained with only ~130K
    // context tokens, and no static candidate explained the retention.
    // Capture one heap snapshot as the heap nears its limit so the next
    // crash leaves a .heapsnapshot retainer trail next to the report.
    "--heapsnapshot-near-heap-limit=1",
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

  if (!needsRelaunch(runtime)) {
    const cli = await import(mainUrl.href) as typeof import("./cli.js");
    await cli.runCli(process.argv);
    return;
  }

  const mainPath = fileURLToPath(mainUrl);
  let argv = process.argv.slice(2);
  for (;;) {
    const code = await spawnAndWait(runtime, mainPath, argv);
    if (code === MEMORY_RESTART_EXIT_CODE) {
      // The child hit the heap watermark, saved its session and asked for a
      // fresh heap. Relaunch resumed on the same session; the marker's
      // attempt budget stops a leaking session from bouncing forever.
      let marker;
      try { marker = parseMemoryRestartMarker(readFileSync(memoryRestartMarkerPath(process.cwd()), "utf8")); }
      catch { marker = undefined; }
      const resumed = memoryRestartArgs(argv, marker);
      if (resumed !== undefined) {
        process.stderr.write(`flavor launcher: heap watermark restart, resuming session ${marker!.sessionId}\n`);
        argv = resumed;
        continue;
      }
      if (marker !== undefined) {
        process.stderr.write("flavor launcher: heap watermark restart budget exhausted; restart manually and consider a fresh session.\n");
      }
    }
    process.exitCode = code;
    return;
  }
}

async function spawnAndWait(runtime: LauncherRuntime, mainPath: string, argv: readonly string[]): Promise<number> {
  const child = spawn(process.execPath, cliMainArguments(runtime, mainPath, argv), { stdio: "inherit" });

  // Both processes share the Windows console. Let the real CLI own Ctrl+C;
  // otherwise the idle launcher can exit before its child restores the TUI.
  const ignoreSignal = (): void => {};
  process.on("SIGINT", ignoreSignal);
  process.on("SIGBREAK", ignoreSignal);
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode) => resolvePromise(exitCode ?? 1));
    });
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
