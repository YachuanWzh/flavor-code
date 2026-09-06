import { spawn } from "node:child_process";
import { mkdirSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MEMORY_RESTART_EXIT_CODE,
  memoryRestartArgs,
  memoryRestartMarkerPath,
  parseMemoryRestartMarker,
} from "./utils/memory-restart.js";

export interface LauncherRuntime {
  execArgv: readonly string[];
}

export interface HeapProfileTarget {
  directory: string;
  name: string;
}

/** Relaunching is required whenever node flags must be applied to the CLI. */
export function needsRelaunch(runtime: LauncherRuntime): boolean {
  if (!runtime.execArgv.some((argument) => argument === "--report-on-fatalerror")) return true;
  if (!runtime.execArgv.some((argument) => argument.startsWith("--heapsnapshot-near-heap-limit"))) return true;
  if (!runtime.execArgv.some((argument) => argument === "--heap-prof")) return true;
  return !runtime.execArgv.some((argument) => argument === "--expose-gc");
}

/** Machines with room to spare get a larger heap: longer rotation cycles, fewer restarts per day. */
const HEAP_HEADROOM_MB = 8192;
const HEAP_HEADROOM_MIN_TOTALMEM = 12 * 1024 * 1024 * 1024;

export function cliMainArguments(
  mainPath: string,
  argv: readonly string[],
  heapProfile?: HeapProfileTarget,
): string[] {
  const flags = [
    // Fatal V8 errors (heap OOM, native crashes) bypass crash-guard.ts and
    // leave only an unusable native stack. Ask Node to dump a diagnostic
    // report next to the working directory so the next crash has a scene.
    "--report-on-fatalerror",
    // The 2026-08-29 OOM reports showed about 4.28GB used at a 4.50GB
    // heap limit while the provider reported roughly 162K context tokens.
    // Capture one heap snapshot as the heap nears its limit so the next
    // crash leaves a .heapsnapshot retainer trail next to the report.
    "--heapsnapshot-near-heap-limit=1",
    // A full snapshot is intentionally reserved for a hard OOM. Sparse
    // allocation sampling has much lower overhead and still records the
    // allocating call stacks responsible for a controlled watermark
    // restart, where --heapsnapshot-near-heap-limit never fires.
    "--heap-prof",
    "--heap-prof-interval=1048576",
    // The heap watermarks are GC-verified: heapUsed counts uncollected
    // garbage, and stopping turns or rotating on garbage alone would waste
    // work. Exposing gc lets the watermark measure the live set instead.
    "--expose-gc",
  ];
  if (heapProfile !== undefined) {
    flags.push(`--heap-prof-dir=${heapProfile.directory}`, `--heap-prof-name=${heapProfile.name}`);
  }
  const processHeapFlag = process.execArgv.find((argument) => argument.startsWith("--max-old-space-size"));
  const argvHeapFlag = argv.find((argument) => argument.startsWith("--max-old-space-size"));
  const userHeapFlag = processHeapFlag ?? argvHeapFlag;
  if (userHeapFlag !== undefined) {
    // execArgv is not inherited when we construct a fresh Node command line.
    // Forward the explicit choice before mainPath where Node will honor it.
    flags.push(userHeapFlag);
  } else {
    const constrained = process.constrainedMemory?.() ?? 0;
    const availableLimit = constrained > 0 ? Math.min(totalmem(), constrained) : totalmem();
    if (availableLimit >= HEAP_HEADROOM_MIN_TOTALMEM) {
      flags.push(`--max-old-space-size=${HEAP_HEADROOM_MB}`);
    }
  }
  return [...flags, mainPath, ...argv.filter((argument) => argument !== argvHeapFlag)];
}

export async function launchCli(): Promise<void> {
  const mainUrl = new URL("./cli-main.js", import.meta.url);
  const runtime: LauncherRuntime = {
    execArgv: process.execArgv,
  };

  if (!needsRelaunch(runtime)) {
    const cli = await import(mainUrl.href) as typeof import("./cli.js");
    await cli.runCli(process.argv);
    return;
  }

  const mainPath = fileURLToPath(mainUrl);
  let argv = process.argv.slice(2);
  let childSequence = 0;
  for (;;) {
    const profileDirectory = join(process.cwd(), ".flavor", "tmp");
    mkdirSync(profileDirectory, { recursive: true });
    const profileName = `heap-profile-${Date.now()}-${process.pid}-${childSequence++}.heapprofile`;
    const profilePath = join(profileDirectory, profileName);
    const code = await spawnAndWait(mainPath, argv, { directory: profileDirectory, name: profileName });
    if (code === 0) {
      // Successful short-lived sessions do not need a diagnostic artifact.
      rmSync(profilePath, { force: true });
    } else {
      process.stderr.write(`flavor launcher: retained allocation profile ${profilePath}\n`);
    }
    if (code === MEMORY_RESTART_EXIT_CODE) {
      // The child hit the heap watermark, saved its session and asked for a
      // fresh heap. Relaunch restores the same session; the marker's
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

async function spawnAndWait(
  mainPath: string,
  argv: readonly string[],
  heapProfile: HeapProfileTarget,
): Promise<number> {
  const child = spawn(process.execPath, cliMainArguments(mainPath, argv, heapProfile), {
    stdio: "inherit",
    env: { ...process.env, NODE_ENV: "production" },
  });

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
