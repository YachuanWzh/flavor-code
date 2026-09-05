// EvolveStore — persistence for the built-in self-improvement loop.
// Pure Node built-ins only.
//
// Layout under <workspace>/.flavor/evolve/:
//   signals.jsonl      aggregated tool-failure signals (deduped by fingerprint)
//   reflections.jsonl  one line per agent run (loop end)
//   done.json          suggestion ids the operator/model already acted on
//   rules.json         learned guardrail rules injected into system prompts

import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface EvolveSignal {
  id: string;
  tool: string;
  errorCode?: string;
  error: string;
  /** Key names of the failing tool input — never values, so secrets stay out of the file. */
  args: string[];
  firstAt: string;
  lastAt: string;
  count: number;
}

export interface EvolveSuggestion {
  id: string;
  tool: string;
  count: number;
  error: string;
  hint: string;
  /** Trend of this tool's failure count since the last run (only when trends are supplied). */
  trend?: "improving" | "stable" | "worsening";
  /** Failure-count delta since the last run, from the supplied trends. */
  delta?: number;
}

export interface ToolTrend {
  /** Failure count of this tool in the run (per-run, not cumulative). */
  failures: number;
  /** Change vs the previous run: negative means the fix is working. */
  delta: number;
}

export interface EvolveReflectionInput {
  iterations: number;
  reason: string;
  toolCalls: number;
  toolErrors: number;
  steers: number;
  totalFailures: number;
  signalDelta: number;
  failedTools: readonly string[];
  perTool?: Record<string, ToolTrend>;
}

export interface EvolveReflection extends EvolveReflectionInput {
  at: string;
  perTool: Record<string, ToolTrend>;
}

export interface EvolveRule {
  id: string;
  text: string;
  addedAt: string;
  /** Signal id that motivated this rule, when it came from a suggestion. */
  sourceId?: string;
}

export interface EvolveStoreOptions {
  workspace: string;
  maxSignals?: number;
  maxRules?: number;
}

/** Collapse whitespace and quoted values so equivalent messages coalesce. */
export function normalizeError(message: unknown): string {
  return String(message ?? "")
    .replace(/\s+/g, " ")
    .replace(/"[^"]*"/g, '"…"')
    // Backtick-quoted values collapse to the same placeholder as double quotes,
    // so "file one" and `file one` dedupe into one signal.
    .replace(/`[^`]*`/g, '"…"')
    .trim()
    .slice(0, 160);
}

/** Stable id for a (tool, errorCode, error) triple, so repeated failures coalesce. */
export function fingerprint(tool: string, errorCode: string | undefined, error: unknown): string {
  return createHash("sha1")
    .update(`${tool}::${errorCode ?? ""}::${normalizeError(error)}`)
    .digest("hex")
    .slice(0, 12);
}

/** Value-free summary of tool args: only key names, never secrets. */
export function argKeys(args: unknown): string[] {
  if (args === null || typeof args !== "object") return [];
  return Object.keys(args).slice(0, 12);
}

async function readJsonLines(file: string): Promise<Record<string, unknown>[]> {
  try {
    const text = await readFile(file, "utf8");
    const records: Record<string, unknown>[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        records.push(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        // Skip corrupt lines; the store stays readable.
      }
    }
    return records;
  } catch {
    return [];
  }
}

async function writeJsonLines(file: string, records: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const body = records.map((record) => JSON.stringify(record)).join("\n");
  await writeFile(file, body.length > 0 ? `${body}\n` : "", { encoding: "utf8", mode: 0o600 });
}

async function readJsonArray(file: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

async function readRules(file: string): Promise<EvolveRule[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === "object")
      .filter((item) => typeof item.id === "string" && typeof item.text === "string")
      .map((item): EvolveRule => ({
        id: item.id as string,
        text: item.text as string,
        addedAt: typeof item.addedAt === "string" ? item.addedAt : "",
        ...(typeof item.sourceId === "string" ? { sourceId: item.sourceId } : {}),
      }));
  } catch {
    return [];
  }
}

async function writeRules(file: string, rules: readonly EvolveRule[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, JSON.stringify(rules, null, 2), { encoding: "utf8", mode: 0o600 });
}

export class EvolveStore {
  readonly dir: string;
  readonly signalsFile: string;
  readonly reflectionsFile: string;
  readonly doneFile: string;
  readonly verifiedFile: string;
  readonly rulesFile: string;
  readonly maxSignals: number;
  readonly maxRules: number;

  // Serialize file mutations: tool hooks may fire in bursts.
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: EvolveStoreOptions) {
    const { workspace, maxSignals = 400, maxRules = 20 } = options;
    this.dir = join(workspace, ".flavor", "evolve");
    this.signalsFile = join(this.dir, "signals.jsonl");
    this.reflectionsFile = join(this.dir, "reflections.jsonl");
    this.doneFile = join(this.dir, "done.json");
    this.verifiedFile = join(this.dir, "verified.json");
    this.rulesFile = join(this.dir, "rules.json");
    this.maxSignals = maxSignals;
    this.maxRules = maxRules;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation, operation);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /**
   * Record one failed tool call. Dedupes by (tool, errorCode, normalized error):
   * existing entries get count/lastAt bumped instead of growing unbounded.
   */
  recordSignal(input: { tool: string; errorCode?: string; error: unknown; args?: unknown }): Promise<{ added: boolean; record: EvolveSignal }> {
    return this.#enqueue(async () => {
      const id = fingerprint(input.tool, input.errorCode, input.error);
      // Normalized (quoted values stripped, capped) so sensitive details never hit disk.
      const message = normalizeError(input.error);
      const now = new Date().toISOString();
      const signals = await readJsonLines(this.signalsFile);
      const existing = signals.find((signal) => signal.id === id);
      if (existing !== undefined) {
        existing.count = (existing.count as number ?? 1) + 1;
        existing.lastAt = now;
        await writeJsonLines(this.signalsFile, signals);
        return { added: false, record: existing as unknown as EvolveSignal };
      }
      const record: EvolveSignal = {
        id,
        tool: input.tool,
        error: message,
        args: argKeys(input.args),
        firstAt: now,
        lastAt: now,
        count: 1,
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
      };
      signals.push(record as unknown as Record<string, unknown>);
      // Keep the file bounded: drop the oldest signals beyond maxSignals.
      if (signals.length > this.maxSignals) signals.splice(0, signals.length - this.maxSignals);
      await writeJsonLines(this.signalsFile, signals);
      return { added: true, record };
    });
  }

  signals(): Promise<EvolveSignal[]> {
    return this.#enqueue(async () => {
      const signals = await readJsonLines(this.signalsFile);
      return (signals as unknown as EvolveSignal[])
        .sort((a, b) => (b.count - a.count) || String(b.lastAt).localeCompare(String(a.lastAt)));
    });
  }

  clearSignals(): Promise<void> {
    return this.#enqueue(async () => {
      await rm(this.signalsFile, { force: true });
      await rm(this.doneFile, { force: true });
      await rm(this.verifiedFile, { force: true });
    });
  }

  appendReflection(input: EvolveReflectionInput): Promise<EvolveReflection> {
    return this.#enqueue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const record: EvolveReflection = {
        at: new Date().toISOString(),
        iterations: input.iterations,
        reason: input.reason,
        toolCalls: input.toolCalls,
        toolErrors: input.toolErrors,
        steers: input.steers,
        totalFailures: input.totalFailures,
        signalDelta: input.signalDelta,
        failedTools: [...input.failedTools].sort(),
        perTool: input.perTool ?? {},
      };
      await appendFile(this.reflectionsFile, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
      return record;
    });
  }

  reflections(limit = 5): Promise<EvolveReflection[]> {
    return this.#enqueue(async () => {
      const records = await readJsonLines(this.reflectionsFile);
      return (records as unknown as EvolveReflection[]).slice(-limit).reverse();
    });
  }

  /** Aggregate open suggestions from repeated failure signals. */
  openSuggestions(input: { threshold?: number; limit?: number; trends?: Readonly<Record<string, number>> } = {}): Promise<EvolveSuggestion[]> {
    const threshold = input.threshold ?? 2;
    const limit = input.limit ?? 8;
    const trends = input.trends ?? {};
    return this.#enqueue(async () => {
      const signals = await readJsonLines(this.signalsFile);
      const done = new Set(await readJsonArray(this.doneFile));
      const verified = new Set(await readJsonArray(this.verifiedFile));
      const trendRank = (tool: string): number => {
        const delta = trends[tool];
        if (delta === undefined || delta === 0) return 1; // stable / unknown
        return delta > 0 ? 2 : 0;
      };
      const isHidden = (signal: Record<string, unknown>): boolean => {
        if (done.has(signal.id as string)) return true;
        // Verified suggestions stay hidden unless the tool is worsening again —
        // a regression means the earlier fix may have stopped working.
        if (verified.has(signal.id as string)) {
          const delta = trends[signal.tool as string];
          if (delta === undefined || delta <= 0) return true;
        }
        return false;
      };
      return signals
        .filter((signal) => (signal.count as number ?? 1) >= threshold && !isHidden(signal))
        .sort((a, b) => trendRank(b.tool as string) - trendRank(a.tool as string) || (b.count as number) - (a.count as number))
        .slice(0, limit)
        .map((signal): EvolveSuggestion => {
          const tool = signal.tool as string;
          const count = signal.count as number;
          const delta = trends[tool];
          const suggestion: EvolveSuggestion = {
            id: signal.id as string,
            tool,
            count,
            error: signal.error as string,
            hint: `Repeated failure on tool "${tool}" (${count}x). Consider a plugin, memory rule, or prompt tweak to fix it.`,
          };
          if (delta !== undefined) {
            suggestion.trend = delta > 0 ? "worsening" : delta < 0 ? "improving" : "stable";
            suggestion.delta = delta;
            suggestion.hint += delta > 0
              ? ` Trend: worsening (+${delta} failures this run) — consider reverting or reworking the fix.`
              : delta < 0
                ? ` Trend: improving (${delta} this run) — fewer failures; fix effectiveness not verified.`
                : " Trend: stable.";
          }
          return suggestion;
        });
    });
  }

  markSuggestionDone(id: string): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const done = await readJsonArray(this.doneFile);
      if (!done.includes(id)) {
        done.push(id);
        await writeFile(this.doneFile, JSON.stringify(done, null, 2), { encoding: "utf8", mode: 0o600 });
      }
    });
  }

  /** Ids carrying the legacy trend-based verified marker (kept for migration/compat reads only). */
  verifiedIds(): Promise<string[]> {
    return this.#enqueue(async () => readJsonArray(this.verifiedFile));
  }

  /**
   * Legacy marker write. Daily runtime paths must not call this: under RSI
   * (rsi.md E3) a verified conclusion requires a candidate plus an
   * independent evaluation report, not a negative failure delta. Retained
   * for explicit compatibility/migration use only.
   */
  markSuggestionVerified(id: string): Promise<void> {
    return this.#enqueue(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const verified = await readJsonArray(this.verifiedFile);
      if (!verified.includes(id)) {
        verified.push(id);
        await writeFile(this.verifiedFile, JSON.stringify(verified, null, 2), { encoding: "utf8", mode: 0o600 });
      }
    });
  }

  /** Learned guardrail rules, oldest first. */
  listRules(): Promise<EvolveRule[]> {
    return this.#enqueue(() => readRules(this.rulesFile));
  }

  /**
   * Add one guardrail rule. Dedupes by fingerprint of the normalized text and
   * keeps at most maxRules entries (oldest dropped first).
   */
  addRule(input: { text: string; sourceId?: string }): Promise<{ added: boolean; rule: EvolveRule }> {
    return this.#enqueue(async () => {
      const text = input.text.replace(/\s+/g, " ").trim().slice(0, 300);
      if (text === "") throw new Error("rule text must not be empty");
      const id = fingerprint("rule", undefined, text);
      const rules = await readRules(this.rulesFile);
      const existing = rules.find((rule) => rule.id === id);
      if (existing !== undefined) return { added: false, rule: existing };
      const rule: EvolveRule = {
        id,
        text,
        addedAt: new Date().toISOString(),
        ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
      };
      rules.push(rule);
      if (rules.length > this.maxRules) rules.splice(0, rules.length - this.maxRules);
      await writeRules(this.rulesFile, rules);
      return { added: true, rule };
    });
  }

  removeRule(id: string): Promise<{ removed: boolean }> {
    return this.#enqueue(async () => {
      const rules = await readRules(this.rulesFile);
      const next = rules.filter((rule) => rule.id !== id);
      if (next.length === rules.length) return { removed: false };
      await writeRules(this.rulesFile, next);
      return { removed: true };
    });
  }
}
