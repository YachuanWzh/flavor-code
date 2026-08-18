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
}

let installed = false;

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

  const crash = (kind: string, reason: unknown): never => {
    const detail = describe(reason);
    const logPath = writeCrashLog(kind, detail);
    restoreTerminal();
    try {
      const safe = redactErrorText(detail.split("\n").slice(0, 3).join("\n"));
      process.stderr.write(`flavor crashed (${kind}): ${safe}\n`);
      if (logPath !== undefined) process.stderr.write(`crash log: ${logPath}\n`);
    } catch { /* stderr may be gone already; the log file is the fallback. */ }
    process.exit(1);
  };

  process.on("unhandledRejection", (reason) => crash("unhandledRejection", reason));
  process.on("uncaughtException", (error) => crash("uncaughtException", error));
}
