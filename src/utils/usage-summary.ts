export interface UsageEntry {
  event: "flavor-usage";
  sessionId?: string | undefined;
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalInputTokens: number;
  cacheHitRatio: number;
}

export interface UsageModelStats {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalInputTokens: number;
  minHitRatio: number;
  averageHitRatio: number;
}

export interface UsageSummary {
  requests: number;
  sessionId: string | undefined;
  byModel: UsageModelStats[];
  totalInputTokens: number;
  totalCacheReadTokens: number;
  /** Share of total input tokens served from cache (0 when nothing was sent). */
  cacheShare: number;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseUsageEntries(raw: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.event !== "flavor-usage") continue;
    if (typeof parsed.provider !== "string" || typeof parsed.model !== "string") continue;
    entries.push({
      event: "flavor-usage",
      sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
      provider: parsed.provider,
      model: parsed.model,
      inputTokens: asNumber(parsed.inputTokens),
      cacheReadTokens: asNumber(parsed.cacheReadTokens),
      cacheCreationTokens: asNumber(parsed.cacheCreationTokens),
      totalInputTokens: asNumber(parsed.totalInputTokens),
      cacheHitRatio: asNumber(parsed.cacheHitRatio),
    });
  }
  return entries;
}

export function summarizeUsage(entries: readonly UsageEntry[]): UsageSummary {
  const groups = new Map<string, UsageModelStats>();
  for (const entry of entries) {
    const key = `${entry.provider}:${entry.model}`;
    let stats = groups.get(key);
    if (stats === undefined) {
      stats = {
        provider: entry.provider,
        model: entry.model,
        requests: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        totalInputTokens: 0,
        minHitRatio: Number.POSITIVE_INFINITY,
        averageHitRatio: 0,
      };
      groups.set(key, stats);
    }
    stats.requests += 1;
    stats.inputTokens += entry.inputTokens;
    stats.cacheReadTokens += entry.cacheReadTokens;
    stats.cacheCreationTokens += entry.cacheCreationTokens;
    stats.totalInputTokens += entry.totalInputTokens;
    stats.minHitRatio = Math.min(stats.minHitRatio, entry.cacheHitRatio);
    stats.averageHitRatio += entry.cacheHitRatio;
  }

  const byModel = [...groups.values()]
    .map((stats) => ({
      ...stats,
      minHitRatio: Number.isFinite(stats.minHitRatio) ? stats.minHitRatio : 0,
      averageHitRatio: stats.requests > 0 ? stats.averageHitRatio / stats.requests : 0,
    }))
    .sort((left, right) => right.totalInputTokens - left.totalInputTokens);

  const totalInputTokens = entries.reduce((sum, entry) => sum + entry.totalInputTokens, 0);
  const totalCacheReadTokens = entries.reduce((sum, entry) => sum + entry.cacheReadTokens, 0);

  return {
    requests: entries.length,
    sessionId: entries.length > 0 ? entries[entries.length - 1]?.sessionId : undefined,
    byModel,
    totalInputTokens,
    totalCacheReadTokens,
    cacheShare: totalInputTokens > 0 ? totalCacheReadTokens / totalInputTokens : 0,
  };
}

function formatTokens(value: number): string {
  if (value < 1000) return String(value);
  return `${(value / 1000).toFixed(1)}k`;
}

export function formatUsageSummary(summary: UsageSummary): string {
  if (summary.requests === 0) return "No usage recorded in this session yet.";
  const sessionLabel = summary.sessionId ?? "unknown";
  const header = `Usage for session ${sessionLabel} (${summary.requests} request${summary.requests === 1 ? "" : "s"}):`;
  const columns: [string, string, string, string, string, string, string][] = summary.byModel.map((stats) => [
    stats.provider,
    stats.model,
    String(stats.requests),
    `${stats.minHitRatio.toFixed(2)}→${stats.averageHitRatio.toFixed(2)}`,
    formatTokens(stats.inputTokens),
    formatTokens(stats.cacheReadTokens),
    formatTokens(stats.cacheCreationTokens),
  ]);
  const titles = ["provider", "model", "reqs", "hit(min→avg)", "input", "cacheRead", "cacheWrite"];
  const widths = titles.map((title, index) =>
    Math.max(title.length, ...columns.map((row) => row[index]?.length ?? 0)),
  );
  const render = (row: readonly string[], indent: string) =>
    indent + row.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ").trimEnd();
  const table = [render(titles, "  "), ...columns.map((row) => render(row, "  "))].join("\n");
  const cachePercent = (summary.cacheShare * 100).toFixed(1);
  const total = `Total input tokens: ${formatTokens(summary.totalInputTokens)} (cache read ${formatTokens(summary.totalCacheReadTokens)}, ${cachePercent}%)`;
  return `${header}\n\n${table}\n\n${total}`;
}
