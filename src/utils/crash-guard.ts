// Global crash guard.
//
// Node >= 15 kills the process on any unhandled Promise rejection, and an
// uncaught exception does the same. Without handlers the Ink TUI never
// restores the terminal (hidden cursor, alt screen) and the error is lost.
// This module records a crash log under .flavor/, restores the terminal
// best-effort, and exits with a diagnostic on stderr.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { redactErrorText } from "./redact.js";

export interface CrashGuardOptions {
  /** Directory provider for crash logs; defaults to the current working directory. */
  workspace?(): string;
  /** Maximum time granted to registered cleanup callbacks before forced exit. */
  cleanupTimeoutMs?: number;
}

let installed = false;
let crashing = false;
const crashCleanups = new Set<() => void | Promise<void>>();

export function registerCrashCleanup(cleanup: () => void | Promise<void>): () => void {
  crashCleanups.add(cleanup);
  return () => { crashCleanups.delete(cleanup); };
}

export async function runCrashCleanups(timeoutMs: number): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("Crash cleanup timeout must be non-negative");
  const cleanup = Promise.allSettled([...crashCleanups].map(async (callback) => callback()));
  if (timeoutMs === 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      cleanup,
      new Promise<void>((resolvePromise) => { timer = setTimeout(resolvePromise, timeoutMs); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function installCrashGuard(options: CrashGuardOptions = {}): void {
  if (installed) return;
  installed = true;

  const crashLogDir = (): string => {
    try { return join((options.workspace ?? process.cwd)(), ".flavor"); }
    catch { return process.cwd(); }
  };

  const writeCrashLog = (kind: string, detail: string): string | undefined => {
    try {
      const dir = crashLogDir();
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `crash-${new Date().toISOString().replace(/[^0-9]/g, "")}-${process.pid}.log`);
      writeFileSync(path, [
        `kind: ${kind}`,
        `version: ${process.version}`,
        `platform: ${process.platform}`,
        `time: ${new Date().toISOString()}`,
        "",
        detail,
      ].join("\n"), { encoding: "utf8", mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  };

  const restoreTerminal = (): void => {
    try {
      // Show the cursor and leave the alternate screen so the shell is usable
      // again even though the Ink renderer never got to clean up.
      if (process.stdout.isTTY === true) process.stdout.write("\u001b[?25h\u001b[?1049l");
    } catch { /* Terminal restoration is best-effort during a crash. */ }
  };

  const describe = (reason: unknown): string => {
    if (reason instanceof Error) return `${reason.name}: ${reason.message}\n${reason.stack ?? ""}`;
    return String(reason);
  };

  const crash = (kind: string, reason: unknown): void => {
    if (crashing) {
      process.exit(1);
      return;
    }
    crashing = true;
    const detail = describe(reason);
    const logPath = writeCrashLog(kind, detail);
    restoreTerminal();
    try {
      const safe = redactErrorText(detail.split("\n").slice(0, 3).join("\n"));
      process.stderr.write(`flavor crashed (${kind}): ${safe}\n`);
      if (logPath !== undefined) process.stderr.write(`crash log: ${logPath}\n`);
    } catch { /* stderr may be gone already; the log file is the fallback. */ }
    const cleanupTimeoutMs = options.cleanupTimeoutMs ?? 1_000;
    const watchdog = setTimeout(() => process.exit(1), cleanupTimeoutMs + 50);
    void runCrashCleanups(cleanupTimeoutMs).finally(() => {
      clearTimeout(watchdog);
      process.exit(1);
    });
  };

  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
  process.on("uncaughtException", (error) => crash("uncaughtException", error));
}
