import { readFile } from "node:fs/promises";
import type { Command } from "commander";

export interface UsageCliDependencies {
  /** Return the raw usage log contents; empty string when no log exists yet. */
  read?(): Promise<string>;
  write?(text: string): void;
}

export function registerUsageCommands(
  program: Command,
  dependencies: UsageCliDependencies = {},
): void {
  const write = dependencies.write ?? ((text: string) => process.stdout.write(text));
  const read = dependencies.read ?? (async () => {
    const { usageLogPath } = await import("../utils/log.js");
    try {
      return await readFile(usageLogPath(), "utf8");
    } catch (error) {
      if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT") return "";
      throw error;
    }
  });

  program.command("usage")
    .description("Summarize token and cache usage for the current session")
    .option("--json", "print the summary as JSON")
    .option("--path", "print the usage log path and exit")
    .action(async (options: { json?: boolean; path?: boolean }) => {
      if (options.path) {
        const { usageLogPath } = await import("../utils/log.js");
        write(`${usageLogPath()}\n`);
        return;
      }
      const raw = await read();
      const { parseUsageEntries, summarizeUsage, formatUsageSummary } = await import("../utils/usage-summary.js");
      const summary = summarizeUsage(parseUsageEntries(raw));
      if (options.json) write(`${JSON.stringify(summary, null, 2)}\n`);
      else write(`${formatUsageSummary(summary)}\n`);
    });
}
