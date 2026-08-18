// Evolve service — the built-in bounded self-improvement loop.
//
//   1. CAPTURE  PostToolUseFailure records failing tool results into a
//               deduped signal store (tool + errorCode + normalized error).
//   2. ASSESS   repeated failures (>= minRepeats) are rendered into the system
//               prompt as suggestions; the model decides what to fix.
//   3. MODIFY   evolve_improve (model side) and /evolve improve (human side)
//               scaffold a fix-<tool>/ plugin dir + PLAN.md. Implementation
//               happens through the normal tool loop (Write/Edit + reload),
//               which goes through the permission system.
//   4. VERIFY   /evolve verify dry-runs the plugin in a shadow PluginHost
//               sandbox; /evolve test runs the suite; /evolve revert restores
//               the last good snapshot; /evolve done closes a suggestion.
//   5. REPEAT   loop end appends a reflection with a signalDelta so whether a
//               fix actually reduced failures is measurable across runs.
//
// The loop is never fully autonomous: suggestions are proposals, and every
// modification still flows through the normal permission system.

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { HookBus } from "../hooks/bus.js";
import { PluginHost } from "../plugins/host.js";
import type { ToolDefinition } from "../tools/types.js";
import {
  fixPluginDir,
  revertFixPlugin,
  sanitizePluginName,
  scaffoldFixPlugin,
  snapshotFixPlugin,
  verifyFixPlugin,
} from "./loader.js";
import { EvolveStore, type EvolveSuggestion, type ToolTrend } from "./store.js";

export interface EvolveServiceOptions {
  workspace: string;
  hooks: HookBus;
  /** Real host plugin loader; required only for the reload subcommand. */
  pluginHost?: PluginHost;
  config?: {
    promptTop?: number;
    minRepeats?: number;
    testCommand?: string;
    testTimeoutMs?: number;
  };
  logger?: {
    warn: (message: string) => void;
    /** User-visible notification (rendered as a notice in the session). */
    notice?: (message: string) => void;
  };
}

export interface EvolveService {
  readonly store: EvolveStore;
  suggestions(): Promise<EvolveSuggestion[]>;
  /** Synchronous system-prompt section (cached after every capture). */
  promptSection(): string | undefined;
  /** Reset per-run counters; call when a loop worker starts. */
  beginRun(): void;
  /** Append a reflection, emit LoopEnd, and reset counters. */
  endRun(reason?: string): Promise<void>;
  handleCommand(args: readonly string[]): Promise<string>;
  toolDefinition(): ToolDefinition<unknown>;
  dispose(): void;
}

const SUGGEST_SECTION_HEADER = `# self-improvement suggestions (evolve)

Repeated tool failures are accumulating in .flavor/evolve/. If one of the
suggestions below has an obvious, low-risk fix (e.g. a better prompt section,
a plugin, a memory rule, a tool wrapper, or a safer default), implement it in
this session when it is in scope; otherwise ignore them. Never act on them
without running the test suite afterwards.

`;

const USAGE = [
  "usage: /evolve <signals|suggest|improve <id>|verify <name>|reload <name>|test|revert <name>|done <id>|verified|clear>",
  "  signals   list recent failing tool results",
  "  suggest   aggregate repeated failures into fix suggestions (trend-aware ordering)",
  "  improve   scaffold a fix-<tool>/ plugin dir + PLAN.md for one suggestion",
  "  verify    sandbox dry-run a plugin before activating it (snapshots on success)",
  "  reload    hot-reload a fix plugin into the running host",
  "  test      run the test suite",
  "  revert    restore the last good snapshot of a plugin",
  "  done      mark a suggestion as handled (no longer proposed)",
  "  verified  list suggestions auto-verified by improving failure trends",
  "  clear     reset signals, done markers, and verified markers",
].join("\n");

interface RunResult { ok: boolean; stdout: string; stderr: string; code: number | string }

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const child = spawn(isWindows ? "cmd.exe" : "/bin/sh", isWindows ? ["/d", "/s", "/c", command] : ["-c", command], {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: `${stderr}\n[killed: exceeded ${timeoutMs}ms]`, code: "timeout" });
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += String(chunk); });
    child.on("error", (error: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n${error.message}`, code: "spawn" });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr, code: code ?? "unknown" });
    });
  });
}

function buildPlan(suggestion: EvolveSuggestion, name: string, implementation: string): string {
  return [
    "# evolve fix plan",
    "",
    `Suggestion: [${suggestion.id}] ${suggestion.tool} x${suggestion.count}`,
    `Error: ${suggestion.error}`,
    "",
    "## Implementation",
    "",
    implementation,
    "",
    "## Verification",
    "",
    "- implement index.js (flavor-plugin contract: activate(context), every contribution declared in contributes)",
    `- /evolve verify ${name} (sandbox dry-run must pass before activation)`,
    `- /evolve reload ${name} (hot-load into the running host)`,
    "- /evolve test",
    `- /evolve done ${suggestion.id} after tests pass`,
    `- on failure: /evolve revert ${name} restores the last good snapshot`,
    "",
  ].join("\n");
}

export function createEvolveService(options: EvolveServiceOptions): EvolveService {
  const { workspace, hooks, pluginHost } = options;
  const promptTop = options.config?.promptTop ?? 3;
  const minRepeats = options.config?.minRepeats ?? 2;
  const testCommand = options.config?.testCommand ?? "npm test";
  const testTimeoutMs = options.config?.testTimeoutMs ?? 120_000;
  const logger = options.logger ?? { warn: (message: string) => console.warn(`[evolve] ${message}`) };
  const notify = (message: string) => (logger.notice ?? logger.warn)(message);

  const store = new EvolveStore({ workspace });
  const disposers: Array<() => void> = [];

  // Per-run counters (loop stats), reset by beginRun.
  let modelCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  /** Per-tool failure counts for the current run (used for trend analysis). */
  let runToolErrors: Record<string, number> = {};
  let promptCache: string | undefined;

  /**
   * Per-tool failure deltas for the current run vs the previous reflection.
   * A negative delta means that tool is failing less than last run.
   */
  async function currentTrends(): Promise<Record<string, number>> {
    const [previous] = await store.reflections(1);
    // First run: no baseline yet — record every current tool at delta 0 so the
    // perTool baseline exists for the next run's comparison.
    if (previous === undefined) {
      const base: Record<string, number> = {};
      for (const tool of Object.keys(runToolErrors)) base[tool] = 0;
      return base;
    }
    const previousPerTool = previous.perTool ?? {};
    const tools = new Set([...Object.keys(previousPerTool), ...Object.keys(runToolErrors)]);
    const trends: Record<string, number> = {};
    for (const tool of tools) {
      trends[tool] = (runToolErrors[tool] ?? 0) - (previousPerTool[tool]?.failures ?? 0);
    }
    return trends;
  }

  async function openWithTrends(limit: number): Promise<EvolveSuggestion[]> {
    const trends = await currentTrends();
    return store.openSuggestions({ threshold: minRepeats, limit, trends });
  }

  async function refreshPromptCache(): Promise<void> {
    try {
      const suggestions = await openWithTrends(promptTop);
      promptCache = suggestions.length === 0
        ? undefined
        : `${SUGGEST_SECTION_HEADER}${suggestions.map((suggestion) => `- [${suggestion.id}] ${suggestion.hint}`).join("\n")}\n`;
    } catch (error) {
      logger.warn(`prompt section failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Shared capture: records a failure signal, refreshes the prompt cache, and
  // notifies exactly once when the signal first reaches the repeat threshold.
  async function captureFailure(tool: string, errorCode: string | undefined, message: string, args: unknown): Promise<void> {
    toolErrors += 1;
    runToolErrors[tool] = (runToolErrors[tool] ?? 0) + 1;
    const { record } = await store.recordSignal({
      tool,
      ...(errorCode === undefined ? {} : { errorCode }),
      error: message,
      args,
    });
    await refreshPromptCache();
    if (record.count === minRepeats) {
      const open = await store.openSuggestions({ threshold: minRepeats, limit: 100, trends: await currentTrends() });
      if (open.some((suggestion) => suggestion.id === record.id)) {
        notify(`${record.tool} failed ${record.count}x with the same error — a fix suggestion is available. Run /evolve suggest to review.`);
      }
    }
  }

  // CAPTURE: real tool failures (validation, permission, thrown errors).
  disposers.push(hooks.on("PostToolUseFailure", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    try {
      const tool = String(payload.tool ?? "unknown");
      const error = (payload.error ?? {}) as Record<string, unknown>;
      await captureFailure(
        tool,
        typeof error.code === "string" ? error.code : undefined,
        typeof error.message === "string" ? error.message : String(payload.error ?? ""),
        payload.input,
      );
    } catch (error) {
      logger.warn(`capture failed — ${error instanceof Error ? error.message : String(error)}`);
    }
    return { decision: "allow" as const };
  }));

  // CAPTURE (shell side-channel): the Shell tool intentionally resolves with
  // `{ exitCode, stdout, stderr }` even on command failure (exit !== 0), so it
  // never triggers PostToolUseFailure. Treat non-zero exits and timeouts as
  // failures here, but never cancellations (user-initiated, not a defect).
  disposers.push(hooks.on("PostToolUse", async (event) => {
    const payload = event.payload as Record<string, unknown>;
    toolCalls += 1;
    const tool = String(payload.tool ?? "unknown");
    if (tool === "Shell" && payload.output !== null && typeof payload.output === "object") {
      const shell = payload.output as Record<string, unknown>;
      const exitCode = typeof shell.exitCode === "number" ? shell.exitCode : undefined;
      const terminationReason = typeof shell.terminationReason === "string" ? shell.terminationReason : undefined;
      // Only explicit non-zero exits and timeouts count as failures; null
      // exitCode (e.g. a background job snapshot) does not.
      const failed = (exitCode !== undefined && exitCode !== 0) || terminationReason === "timeout";
      if (failed && terminationReason !== "cancelled") {
        try {
          const stderr = typeof shell.stderr === "string" ? shell.stderr : "";
          const stdout = typeof shell.stdout === "string" ? shell.stdout : "";
          const message = stderr.trim().slice(0, 300)
            || stdout.trim().slice(0, 300)
            || (exitCode === undefined ? "shell timed out" : `exit code ${exitCode}`);
          await captureFailure(tool, exitCode === undefined ? "shell_exit_timeout" : `shell_exit_${exitCode}`, message, payload.input);
        } catch (error) {
          logger.warn(`shell capture failed — ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    return { decision: "allow" as const };
  }));

  // Per-run model call counter.
  disposers.push(hooks.on("AfterModelCall", () => { modelCalls += 1; return { decision: "allow" as const }; }));

  return {
    store,

    suggestions: () => openWithTrends(promptTop),

    promptSection: () => promptCache,

    beginRun() {
      modelCalls = 0;
      toolCalls = 0;
      toolErrors = 0;
      runToolErrors = {};
    },

    async endRun(reason = "finished") {
      try {
        const signals = await store.signals();
        const totalFailures = signals.reduce((sum, signal) => sum + signal.count, 0);
        const failedTools = signals
          .filter((signal) => signal.count >= minRepeats)
          .map((signal) => signal.tool);
        const [previous] = await store.reflections(1);
        const signalDelta = previous === undefined ? 0 : totalFailures - previous.totalFailures;
        const trends = await currentTrends();
        const perTool: Record<string, ToolTrend> = {};
        for (const [tool, delta] of Object.entries(trends)) {
          perTool[tool] = { failures: runToolErrors[tool] ?? 0, delta };
        }
        await store.appendReflection({
          iterations: modelCalls,
          reason,
          toolCalls,
          toolErrors,
          steers: 0,
          totalFailures,
          signalDelta,
          failedTools,
          perTool,
        });
        // Closed loop: a tool that failed less than last run means the fix is
        // working — auto-verify its open suggestions so they stop being proposed.
        const verifiedTools = new Set<string>();
        for (const [tool, trend] of Object.entries(perTool)) {
          if (trend.delta < 0) {
            const suggestions = await store.openSuggestions({ threshold: minRepeats, limit: 100, trends });
            for (const suggestion of suggestions.filter((item) => item.tool === tool)) {
              await store.markSuggestionVerified(suggestion.id);
            }
            verifiedTools.add(tool);
          }
        }
        // User-facing run summary: only meaningful lines, quiet when nothing happened.
        const sign = (value: number) => (value > 0 ? `+${value}` : String(value));
        const meaningful = Object.entries(perTool).filter(([, trend]) => trend.failures > 0 || trend.delta !== 0);
        const lines: string[] = [];
        if (meaningful.length === 0) {
          lines.push(`run ${reason}: no tool errors`);
        } else {
          const previousTotal = previous?.totalFailures ?? 0;
          lines.push(`run ${reason}: toolErrors ${toolErrors}, failures ${previousTotal}→${totalFailures} (delta ${sign(signalDelta)})`);
          for (const [tool, trend] of meaningful) {
            if (trend.delta === 0) continue;
            const note = trend.delta < 0
              ? (verifiedTools.has(tool) ? " — suggestion auto-verified" : "")
              : " — suggestion reopened";
            lines.push(`  - ${tool}: ${trend.delta < 0 ? "improved" : "worsening"} (${sign(trend.delta)})${note}`);
          }
        }
        notify(lines.join("\n"));
        await hooks.emit({
          version: 1,
          type: "LoopEnd",
          payload: {
            status: reason,
            iterations: modelCalls,
            toolCalls,
            toolErrors,
            steers: 0,
            totalFailures,
            signalDelta,
          },
        }).catch((error: unknown) => {
          logger.warn(`LoopEnd emit failed — ${error instanceof Error ? error.message : String(error)}`);
        });
      } catch (error) {
        logger.warn(`reflection failed — ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        modelCalls = 0;
        toolCalls = 0;
        toolErrors = 0;
        runToolErrors = {};
      }
    },

    async handleCommand(args) {
      const arg = String(args.join(" ").trim());

      if (arg === "" || arg === "help") {
        const signals = await store.signals();
        const open = await openWithTrends(100);
        const verified = await store.verifiedIds();
        const [latest] = await store.reflections(1);
        return [
          `evolve status: ${signals.length} signals, ${open.length} open suggestions, ${verified.length} verified, ${latest === undefined ? "no reflections yet" : `${latest.totalFailures} total failures`}`,
          `latest signals: ${signals.slice(0, 5).map((signal) => `${signal.tool} x${signal.count}`).join(", ") || "(none)"}`,
          USAGE,
        ].join("\n");
      }

      if (arg === "signals") {
        const signals = await store.signals();
        if (signals.length === 0) return "no signals recorded yet";
        return signals.slice(0, 10).map((signal) => `[${signal.id}] ${signal.tool} x${signal.count} — ${signal.error}`).join("\n");
      }

      if (arg === "suggest") {
        const suggestions = await openWithTrends(100);
        if (suggestions.length === 0) return `no open suggestions (need >= ${minRepeats} repeats of the same failure)`;
        return suggestions.map((suggestion) => `[${suggestion.id}] ${suggestion.tool} x${suggestion.count}: ${suggestion.error}\n  fix idea: ${suggestion.hint}`).join("\n");
      }

      if (arg === "verified") {
        const verified = await store.verifiedIds();
        if (verified.length === 0) return "no verified suggestions yet";
        const signals = await store.signals();
        const byId = new Map(signals.map((signal) => [signal.id, signal]));
        return verified.map((id) => {
          const signal = byId.get(id);
          return signal === undefined
            ? `[${id}] (signal no longer recorded)`
            : `[${id}] ${signal.tool} x${signal.count} — ${signal.error} (verified)`;
        }).join("\n");
      }

      if (arg.startsWith("improve ")) {
        const suggestionId = arg.slice(8).trim();
        const suggestions = await openWithTrends(100);
        const suggestion = suggestions.find((item) => item.id === suggestionId);
        if (suggestion === undefined) return `No open suggestion with id "${suggestionId}". Use /evolve suggest to list them.`;
        const name = sanitizePluginName(suggestion.tool);
        const dir = await scaffoldFixPlugin(workspace, name);
        await writeFile(join(dir, "PLAN.md"), buildPlan(suggestion, name, "See the repeated failure below; describe your fix in PLAN.md."), "utf8");
        await snapshotFixPlugin(workspace, name);
        return [
          `suggestion ${suggestion.id}: ${suggestion.tool} x${suggestion.count} — ${suggestion.error}`,
          `scaffolded fix plugin at ${dir}`,
          `edit index.js to implement the fix, then run /evolve verify ${name}, /evolve reload ${name} and /evolve test`,
          `mark the suggestion handled with /evolve done ${suggestion.id} once tests pass`,
        ].join("\n");
      }

      if (arg.startsWith("verify ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve verify <plugin>";
        const report = await verifyFixPlugin(workspace, name);
        if (!report.ok) return `verify FAILED: ${name}\n  ${report.error ?? "unknown error"}`;
        await snapshotFixPlugin(workspace, name).catch((error: unknown) => {
          logger.warn(`snapshot failed — ${error instanceof Error ? error.message : String(error)}`);
        });
        return [
          `verify OK: ${name} (sandbox dry-run, host untouched)`,
          `  provides: ${report.provided.join(", ") || "-"}`,
          `  tools: ${report.tools.join(", ") || "-"}`,
          `  commands: ${report.commands.join(", ") || "-"}`,
        ].join("\n");
      }

      if (arg.startsWith("reload ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve reload <plugin>";
        if (pluginHost === undefined) return "error: plugin reload is unavailable in this context";
        const result = await pluginHost.reload(name);
        return result.ok ? `reloaded ${name}` : `reload FAILED: ${name}\n  ${result.error ?? "unknown error"}`;
      }

      if (arg.startsWith("revert ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve revert <plugin>";
        try {
          return await revertFixPlugin(workspace, name);
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (arg.startsWith("done ")) {
        const id = arg.slice(5).trim();
        if (id === "") return "usage: /evolve done <suggestionId>";
        await store.markSuggestionDone(id);
        return `marked ${id} done`;
      }

      if (arg === "test") {
        const result = await runCommand(testCommand, workspace, testTimeoutMs);
        return result.ok
          ? `tests passed (exit 0)${result.stdout.length > 0 ? `\n${result.stdout.slice(-4000)}` : ""}`
          : `tests FAILED (exit ${result.code})${result.stderr.length > 0 ? `\n${result.stderr.slice(-4000)}` : ""}`;
      }

      if (arg === "clear") {
        await store.clearSignals();
        promptCache = undefined;
        return "cleared signals and done markers";
      }

      return USAGE;
    },

    toolDefinition(): ToolDefinition<unknown> {
      const inputSchema = z.object({
        suggestionId: z.string().min(1).describe("Signal id from the evolve suggestions"),
        implementation: z.string().min(1).describe("Concise description of the plugin fix to implement"),
      });
      return {
        name: "evolve_improve",
        description:
          "Implement a fix for one repeated tool failure as a flavor-code plugin: scaffolds the fix-<tool>/ plugin dir, " +
          "writes PLAN.md, and returns instructions for implementing, verifying, reloading, and testing it. " +
          "Use when the model proposes a concrete plugin-level fix for a suggestion in the system prompt.",
        inputSchema,
        paths: () => [],
        execute: async (input) => {
          const { suggestionId, implementation } = input as { suggestionId: string; implementation: string };
          const suggestions = await openWithTrends(100);
          const suggestion = suggestions.find((item) => item.id === suggestionId);
          if (suggestion === undefined) throw new Error(`No open suggestion with id "${suggestionId}".`);

          const name = sanitizePluginName(suggestion.tool);
          const dir = await scaffoldFixPlugin(workspace, name);
          await writeFile(join(dir, "PLAN.md"), buildPlan(suggestion, name, implementation), "utf8");
          await snapshotFixPlugin(workspace, name);

          return [
            `Scaffolded fix plugin at ${dir} for suggestion [${suggestion.id}] (${suggestion.tool} x${suggestion.count}).`,
            `Plan written to PLAN.md.`,
            "",
            "Now implement it yourself:",
            "1. Write the plugin entry (index.js) per the flavor-plugin contract — a minimal hook or tool wrapper is enough.",
            `2. Run /evolve verify ${name} — the sandbox dry-run must pass before activation.`,
            `3. Run /evolve reload ${name} to hot-load it.`,
            "4. Run /evolve test to verify the suite still passes.",
            `5. Run /evolve done ${suggestion.id} to close the suggestion. If anything breaks, /evolve revert ${name} restores the last good snapshot.`,
          ].join("\n");
        },
      };
    },

    dispose() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
  };
}

// Referenced by callers that need the scaffolded dir (e.g. wiring tests).
export { fixPluginDir };
