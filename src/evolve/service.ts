// Evolve service — the built-in bounded self-improvement loop.
//
//   1. CAPTURE  PostToolUseFailure records failing tool results into a
//               deduped signal store (tool + errorCode + normalized error).
//   2. ASSESS   repeated failures (>= minRepeats) are rendered into the system
//               prompt as suggestions; the model decides what to fix.
//   3. MODIFY   evolve_improve (model side) and /evolve improve (human side)
//               scaffold a fix-<tool>/ plugin dir + PLAN.md. Implementation
//               happens through the normal tool loop (Write/Edit + reload),
//               which goes through the permission system. Alternatively a
//               suggestion can be proposed as a prompt guardrail rule for
//               review (kind: prompt_rule); only accepted rules are injected.
//   4. VERIFY   /evolve verify dry-runs the plugin in a shadow PluginHost
//               sandbox; /evolve test runs the suite; /evolve revert restores
//               the last good snapshot; /evolve done closes a suggestion.
//   5. REPEAT   ordinary and loop runs record comparable per-tool failure rates. These are
//               observations, not automatic proof that a fix worked.
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
  restoreFixPluginSnapshot,
  sanitizePluginName,
  scaffoldFixPlugin,
  snapshotFixPlugin,
  verifyFixPlugin,
} from "./loader.js";
import { EvolveStore, type EvolveSuggestion, type ToolTrend } from "./store.js";
import { EvolveVerificationStore, hashFixPlugin, hashFixPluginSnapshot } from "./verification.js";

export interface EvolveServiceOptions {
  workspace: string;
  hooks: HookBus;
  store?: EvolveStore;
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
  /** Load persisted suggestions and guardrails before the first model call. */
  initialize(): Promise<void>;
  suggestions(): Promise<EvolveSuggestion[]>;
  /** Synchronous system-prompt section (cached after every capture). */
  promptSection(): string | undefined;
  /** Reset per-run counters at the start of a foreground task or loop worker. */
  beginRun(): void;
  /** Append a reflection and reset counters; emit LoopEnd only for /loop. */
  endRun(reason?: string, emitLoopEnd?: boolean, taskId?: string): Promise<void>;
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

const GUARDRAILS_SECTION_HEADER = `# learned guardrails (evolve)

These rules were distilled from repeated tool failures in this workspace.
Follow them unless the current task or the user explicitly contradicts one.

`;

const USAGE = [
  "usage: /evolve <signals|suggest|improve <id>|verify <name>|test|reload <name>|revert <name>|done <id>|verified|trends [n]|outcomes|comparisons|rule <list|add|accept|remove>|preference <list|drop|restore>|clear>",
  "  signals   list recent failing tool results",
  "  suggest   aggregate repeated failures into fix suggestions (trend-aware ordering)",
  "  improve   scaffold a fix-<tool>/ plugin dir + PLAN.md for one suggestion",
  "  verify    sandbox dry-run a plugin and record its exact content hash",
  "  test      run the test suite and record which verified hashes passed",
  "  reload    activate only the exact verified and tested fix plugin, with rollback",
  "  revert    restore the last good snapshot of a plugin",
  "  done      mark a suggestion as handled (no longer proposed)",
  "  verified  show legacy verification markers (not proof of a working fix)",
  "  trends    cross-run dashboard: tool calls and comparable failure rates",
  "  outcomes  recent candidate exposures, task results, and attributed feedback",
  "  comparisons  local baseline/candidate eval summaries",
  "  rule      review proposed guardrails; accept <id> activates one (add <text> activates a manual rule)",
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
    "- /evolve test",
    `- /evolve reload ${name} (hot-load the exact verified and tested version)`,
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

  const store = options.store ?? new EvolveStore({ workspace });
  const verifications = new EvolveVerificationStore(workspace);
  const disposers: Array<() => void> = [];

  async function restoreKnownGood(name: string, snapshot: string): Promise<void> {
    const digest = (await verifications.list())[name]?.activeDigest;
    if (digest === undefined || await hashFixPluginSnapshot(workspace, name, snapshot) !== digest) {
      throw new Error("Known-good plugin snapshot no longer matches its approved version");
    }
    await restoreFixPluginSnapshot(workspace, name, snapshot);
    if (await hashFixPlugin(workspace, name) !== digest) throw new Error("Plugin changed while restoring its snapshot");
  }

  // Per-run counters (loop stats), reset by beginRun.
  let modelCalls = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  /** Per-tool failure counts for the current run (used for trend analysis). */
  let runToolErrors: Record<string, number> = {};
  let runToolCalls: Record<string, number> = {};
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
    const tools = new Set([...Object.keys(previousPerTool), ...Object.keys(runToolCalls)]);
    const trends: Record<string, number> = {};
    for (const tool of tools) {
      const calls = runToolCalls[tool] ?? 0;
      const before = previousPerTool[tool];
      const previousCalls = before?.calls ?? 0;
      // A run without an invocation supplies no evidence about this tool.
      if (calls === 0 || previousCalls === 0) continue;
      trends[tool] = ((runToolErrors[tool] ?? 0) / calls - before!.failures / previousCalls) * 100;
    }
    return trends;
  }

  async function openWithTrends(limit: number): Promise<EvolveSuggestion[]> {
    const trends = await currentTrends();
    return store.openSuggestions({ threshold: minRepeats, limit, trends });
  }

  async function refreshPromptCache(): Promise<void> {
    try {
      const [suggestions, rules] = await Promise.all([openWithTrends(promptTop), store.listRules()]);
      const sections: string[] = [];
      const activeRules = rules.filter((rule) => rule.status !== "proposed");
      if (activeRules.length > 0) {
        sections.push(`${GUARDRAILS_SECTION_HEADER}${activeRules.map((rule) => `- ${rule.text}`).join("\n")}\n`);
      }
      if (suggestions.length > 0) {
        sections.push(`${SUGGEST_SECTION_HEADER}${suggestions.map((suggestion) => `- [${suggestion.id}] ${suggestion.hint}`).join("\n")}\n`);
      }
      promptCache = sections.length === 0 ? undefined : sections.join("\n");
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
      toolCalls += 1;
      runToolCalls[tool] = (runToolCalls[tool] ?? 0) + 1;
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
    runToolCalls[tool] = (runToolCalls[tool] ?? 0) + 1;
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
          const diagnostic = shell.diagnostic !== null && typeof shell.diagnostic === "object"
            ? shell.diagnostic as Record<string, unknown>
            : undefined;
          const diagnosticMessage = typeof diagnostic?.message === "string" ? diagnostic.message : "";
          const diagnosticKind = typeof diagnostic?.kind === "string" ? diagnostic.kind : undefined;
          const message = diagnosticMessage.trim().slice(0, 300)
            || stderr.trim().slice(0, 300)
            || stdout.trim().slice(0, 300)
            || (exitCode === undefined ? "shell timed out" : `exit code ${exitCode}`);
          const errorCode = diagnosticKind === undefined
            ? (exitCode === undefined ? "shell_exit_timeout" : `shell_exit_${exitCode}`)
            : `shell_${diagnosticKind}`;
          await captureFailure(tool, errorCode, message, payload.input);
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

    initialize: refreshPromptCache,

    suggestions: () => openWithTrends(promptTop),

    promptSection: () => promptCache,

    beginRun() {
      modelCalls = 0;
      toolCalls = 0;
      toolErrors = 0;
      runToolErrors = {};
      runToolCalls = {};
    },

    async endRun(reason = "finished", emitLoopEnd = true, taskId?: string) {
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
        for (const tool of Object.keys(runToolCalls)) {
          const calls = runToolCalls[tool] ?? 0;
          perTool[tool] = { calls, failures: runToolErrors[tool] ?? 0, delta: trends[tool] ?? 0 };
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
        if (taskId !== undefined) {
          await store.appendOutcomeEvent({ kind: "task_finished", taskId,
            outcome: reason, modelCalls, toolCalls, toolErrors });
        }
        // A lower rate is a trend, not proof that any particular fix caused it.
        // User-facing run summary: only meaningful lines, quiet when nothing happened.
        const sign = (value: number) => (value > 0 ? `+${value}` : String(value));
        const meaningful = Object.entries(perTool).filter(([, trend]) => trend.failures > 0 || trend.delta !== 0);
        const lines: string[] = [];
        if (meaningful.length === 0) {
          lines.push(`run ${reason}: no tool errors`);
        } else {
          const previousTotal = previous?.totalFailures ?? 0;
          lines.push(`run ${reason}: toolErrors ${toolErrors}/${toolCalls} calls, cumulative failures ${previousTotal}→${totalFailures} (+${signalDelta})`);
          for (const [tool, trend] of meaningful) {
            if (trend.delta === 0) continue;
            lines.push(`  - ${tool}: ${trend.delta < 0 ? "lower" : "higher"} failure rate (${sign(Math.round(trend.delta))} percentage points; ${trend.calls} calls), pending evaluation`);
          }
        }
        if (emitLoopEnd || meaningful.length > 0) notify(lines.join("\n"));
        if (emitLoopEnd) await hooks.emit({
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
        runToolCalls = {};
      }
    },

    async handleCommand(args) {
      const arg = String(args.join(" ").trim());

      if (arg === "" || arg === "help" || arg === "status") {
        const signals = await store.signals();
        const open = await openWithTrends(100);
        const verified = await store.verifiedIds();
        const [latest] = await store.reflections(1);
        const pendingRules = (await store.listRules()).filter((rule) => rule.status === "proposed");
        return [
          `evolve status: ${signals.length} signals, ${open.length} open suggestions, ${pendingRules.length} proposed rules, ${verified.length} legacy markers, ${latest === undefined ? "no reflections yet" : `${latest.totalFailures} cumulative failures`}`,
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
        if (verified.length === 0) return "no legacy verified markers";
        const signals = await store.signals();
        const byId = new Map(signals.map((signal) => [signal.id, signal]));
        return verified.map((id) => {
          const signal = byId.get(id);
          return signal === undefined
            ? `[${id}] (signal no longer recorded)`
            : `[${id}] ${signal.tool} x${signal.count} — ${signal.error} (legacy marker; not proof of benefit)`;
        }).join("\n");
      }

      if (arg === "trends" || arg.startsWith("trends ")) {
        const requested = Number.parseInt(arg.slice(6).trim(), 10);
        const count = Number.isNaN(requested) ? 5 : Math.min(Math.max(requested, 1), 50);
        const reflections = await store.reflections(count); // newest first
        if (reflections.length === 0) return "no reflections recorded yet — trends appear after runs end";
        const sign = (value: number) => (value > 0 ? `+${value}` : String(value));
        const lines: string[] = [`evolve trends (last ${reflections.length} run(s), newest first)`];
        for (const reflection of reflections) {
          lines.push(`${reflection.at.replace("T", " ").slice(0, 19)}  ${reflection.reason}: model calls ${reflection.iterations}, tool calls ${reflection.toolCalls} (${reflection.toolErrors} failed), failures ${reflection.totalFailures} (delta ${sign(reflection.signalDelta)})`);
          const moved = Object.entries(reflection.perTool ?? {}).filter(([, trend]) => trend.delta !== 0);
          for (const [tool, trend] of moved) {
            lines.push(`    - ${tool}: ${trend.failures}/${trend.calls ?? "?"} failed (${sign(Math.round(trend.delta))} percentage points vs comparable previous run)`);
          }
        }
        return lines.join("\n");
      }

      if (arg === "outcomes") {
        const events = (await store.outcomeEvents(30)).reverse();
        if (events.length === 0) return "no outcome events recorded yet";
        return events.map((event) => {
          const task = event.taskId.slice(0, 20);
          if (event.kind === "candidate_exposed") return `${event.at} ${task}: exposed ${event.candidateIds.join(", ")}`;
          if (event.kind === "candidate_feedback") return `${event.at} ${task}: ${event.sentiment} feedback for ${event.candidateIds.join(", ")}`;
          return `${event.at} ${task}: ${event.outcome}; ${event.toolErrors}/${event.toolCalls} tool calls failed`;
        }).join("\n");
      }

      if (arg === "comparisons") {
        const comparisons = await store.comparisons(10);
        if (comparisons.length === 0) return "no paired evaluations recorded yet — use flavor eval <spec> --baseline <workspace>";
        return comparisons.map((item) => `${item.at} ${item.caseName}: ${item.verdict}; `
          + `checks ${item.baseline.checksPassed}/${item.baseline.checksTotal} → ${item.candidate.checksPassed}/${item.candidate.checksTotal}; `
          + `tokens ${item.baseline.tokens} → ${item.candidate.tokens}`).join("\n");
      }

      if (arg === "rule" || arg === "rule list") {
        const rules = await store.listRules();
        if (rules.length === 0) return "no guardrail rules yet — add one with /evolve rule add <text>";
        return rules.map((rule) => `[${rule.id}] ${rule.status ?? "active"} ${rule.text}`).join("\n");
      }

      if (arg.startsWith("rule accept ")) {
        const id = arg.slice(12).trim();
        if (!await store.activateRule(id)) return `no guardrail with id "${id}"`;
        await refreshPromptCache();
        return `activated guardrail ${id}`;
      }

      if (arg.startsWith("rule add ")) {
        const text = arg.slice(9).trim();
        if (text === "") return "usage: /evolve rule add <text>";
        const { added, activated, rule } = await store.addRule({ text });
        await refreshPromptCache();
        return added
          ? `added guardrail [${rule.id}]: ${rule.text}`
          : activated ? `activated existing guardrail [${rule.id}]: ${rule.text}`
            : `guardrail already exists [${rule.id}]: ${rule.text}`;
      }

      if (arg.startsWith("rule remove ")) {
        const id = arg.slice(12).trim();
        if (id === "") return "usage: /evolve rule remove <id>";
        const { removed } = await store.removeRule(id);
        await refreshPromptCache();
        return removed ? `removed guardrail ${id}` : `no guardrail with id "${id}"`;
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
          `edit index.js, then run /evolve verify ${name}, /evolve test and /evolve reload ${name}`,
          `mark the suggestion handled with /evolve done ${suggestion.id} once tests pass`,
        ].join("\n");
      }

      if (arg.startsWith("verify ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve verify <plugin>";
        let digest: string;
        try { digest = await hashFixPlugin(workspace, name); }
        catch (error) { return `verify FAILED: ${name}\n  ${error instanceof Error ? error.message : String(error)}`; }
        const report = await verifyFixPlugin(workspace, name);
        if (!report.ok) return `verify FAILED: ${name}\n  ${report.error ?? "unknown error"}`;
        if (report.registrations === 0) return `verify FAILED: ${name}\n  plugin registered no tools, commands, hooks, skills, or model adapters; implement the fix first`;
        if (await hashFixPlugin(workspace, name) !== digest) return `verify FAILED: ${name}\n  plugin changed during verification`;
        await verifications.markVerified(name, digest);
        return [
          `verify OK: ${name} (${digest.slice(0, 12)}, sandbox dry-run, host untouched)`,
          `  provides: ${report.provided.join(", ") || "-"}`,
          `  tools: ${report.tools.join(", ") || "-"}`,
          `  commands: ${report.commands.join(", ") || "-"}`,
        ].join("\n");
      }

      if (arg.startsWith("reload ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve reload <plugin>";
        if (pluginHost === undefined) return "error: plugin reload is unavailable in this context";
        const digest = await hashFixPlugin(workspace, name);
        if (!await verifications.eligible(name, digest)) {
          return `reload BLOCKED: ${name} must pass /evolve verify and /evolve test for its current contents`;
        }
        const previous = await verifications.goodSnapshot(name);
        // Prepare a recoverable copy before touching the running host. If
        // copying fails, the previous plugin remains active.
        const snapshot = await snapshotFixPlugin(workspace, name);
        if (await hashFixPlugin(workspace, name) !== digest
          || await hashFixPluginSnapshot(workspace, name, snapshot) !== digest) {
          return `reload FAILED: ${name}\n  plugin changed while preparing its snapshot`;
        }
        const result = await pluginHost.reload(name);
        if (!result.ok) {
          if (previous !== undefined) {
            try {
              await restoreKnownGood(name, previous);
              const rollback = await pluginHost.reload(name);
              if (!rollback.ok) return `reload FAILED: ${name}\n  ${result.error ?? "unknown error"}\n  rollback FAILED: ${rollback.error ?? "unknown error"}`;
            } catch (error) {
              return `reload FAILED: ${name}\n  ${result.error ?? "unknown error"}\n  rollback FAILED: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          return `reload FAILED: ${name}\n  ${result.error ?? "unknown error"}`;
        }
        if (await hashFixPlugin(workspace, name) !== digest) {
          if (previous !== undefined) {
            try {
              await restoreKnownGood(name, previous);
              const rollback = await pluginHost.reload(name);
              if (!rollback.ok) return `reload FAILED: ${name}\n  plugin changed during activation\n  rollback FAILED: ${rollback.error ?? "unknown error"}`;
            } catch (error) {
              return `reload FAILED: ${name}\n  plugin changed during activation\n  rollback FAILED: ${error instanceof Error ? error.message : String(error)}`;
            }
          } else await pluginHost.unload(name);
          return `reload FAILED: ${name}\n  plugin changed during activation`;
        }
        await verifications.markActive(name, digest, snapshot);
        return `reloaded ${name} (${digest.slice(0, 12)}; verified, tested, and snapshotted)`;
      }

      if (arg.startsWith("revert ")) {
        const name = arg.slice(7).trim();
        if (name === "") return "usage: /evolve revert <plugin>";
        try {
          const snapshot = await verifications.goodSnapshot(name);
          if (snapshot === undefined) return `error: ${name} has no known-good active snapshot`;
          await restoreKnownGood(name, snapshot);
          if (pluginHost !== undefined) {
            const result = await pluginHost.reload(name);
            if (!result.ok) return `revert FAILED: ${name}\n  ${result.error ?? "unknown error"}`;
          }
          return `Restored ${name} from its last known-good version.`;
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
        if (result.ok) {
          for (const [name, entry] of Object.entries(await verifications.list())) {
            try {
              if (await hashFixPlugin(workspace, name) === entry.digest) await verifications.markTested(name, entry.digest, testCommand);
            } catch { /* A removed plugin has no version to approve. */ }
          }
        }
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
        implementation: z.string().min(1).describe("Concise description of the fix to implement (plugin plan, or the guardrail rule text when kind is prompt_rule)"),
        kind: z.enum(["plugin", "prompt_rule"]).optional().describe(
          "plugin (default): scaffold a fix plugin; prompt_rule: propose a guardrail for user review",
        ),
      });
      return {
        name: "evolve_improve",
        description:
          "Implement a fix for one repeated tool failure. Default kind=plugin scaffolds the fix-<tool>/ plugin dir and " +
          "writes PLAN.md with instructions for implementing, verifying, reloading, and testing it. " +
          "kind=prompt_rule stores a proposed guardrail (from `implementation`). It needs /evolve rule accept <id> " +
          "before it enters future prompts. Use when the model proposes a concrete fix for a repeated failure.",
        inputSchema,
        paths: (input) => [join(workspace, ".flavor", "evolve"), ...((input as { kind?: string }).kind === "prompt_rule" ? [] : [join(workspace, ".flavor", "plugins")])],
        execute: async (input, signal) => {
          signal.throwIfAborted();
          const { suggestionId, implementation, kind } = input as { suggestionId: string; implementation: string; kind?: "plugin" | "prompt_rule" };
          const suggestions = await openWithTrends(100);
          signal.throwIfAborted();
          const suggestion = suggestions.find((item) => item.id === suggestionId);
          if (suggestion === undefined) throw new Error(`No open suggestion with id "${suggestionId}".`);

          if (kind === "prompt_rule") {
            const { added, rule } = await store.addRule({ text: implementation, sourceId: suggestionId, status: "proposed" });
            return [
              added ? `Proposed guardrail rule [${rule.id}]: ${rule.text}` : `Guardrail already exists [${rule.id}] (${rule.status ?? "active"}): ${rule.text}`,
              `Suggestion [${suggestion.id}] stays open until its effect is checked.`,
              `Review with /evolve rule list; activate with /evolve rule accept ${rule.id} or remove with /evolve rule remove ${rule.id}.`,
            ].join("\n");
          }

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
            "3. Run /evolve test to verify the suite still passes.",
            `4. Run /evolve reload ${name} to hot-load the exact tested version.`,
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
