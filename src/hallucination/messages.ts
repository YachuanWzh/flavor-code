import type { ConfidenceResult, RetryViolation } from "./types.js";

interface WarningReport {
  confidence: ConfidenceResult | null;
  retryViolations: RetryViolation[];
  circuitBreakerTripped: boolean;
  circuitBreakerDetail: string | null;
  passed: boolean;
}

type Language = "zh-CN" | "en";

function lang(tag: string): Language {
  if (tag.startsWith("zh")) return "zh-CN";
  if (tag.startsWith("en")) return "en";
  return "zh-CN";
}

const LABELS: Record<Language, {
  guardLabel: string;
  lowConfidence: (confidence: number, reason: string) => string;
  toolRetry: (toolName: string, retryCount: number, maxRetries: number, lastError: string) => string;
  circuitBreaker: (detail: string) => string;
}> = {
  en: {
    guardLabel: "Hallucination guard",
    lowConfidence: (c, r) => `low confidence (${c.toFixed(2)}): ${r}`,
    toolRetry: (n, c, m, e) => `tool "${n}" retried ${c}/${m}× (last error: ${e})`,
    circuitBreaker: (d) => d,
  },
  "zh-CN": {
    guardLabel: "幻觉检测",
    lowConfidence: (c, r) => `置信度过低 (${c.toFixed(2)}): ${r}`,
    toolRetry: (n, c, m, e) => `工具 "${n}" 已重试 ${c}/${m} 次（最近错误: ${e}）`,
    circuitBreaker: (d) => d, // technical detail, keep as-is
  },
};

export function buildWarningMessages(report: WarningReport, languageTag: string): string[] {
  const l = lang(languageTag);
  const labels = LABELS[l];
  const warnings: string[] = [];

  if (report.confidence !== null) {
    const scores = report.confidence.scores;
    const scoreDetail = scores === undefined
      ? ""
      : ` [task=${scores.taskAlignment.toFixed(2)}, evidence=${scores.evidenceGrounding.toFixed(2)}, process=${scores.processReliability.toFixed(2)}]`;
    const claims = report.confidence.unsupportedClaims ?? [];
    const claimDetail = claims.length === 0 ? "" : `; unsupported: ${claims.join(" | ")}`;
    warnings.push(
      `${labels.guardLabel}: ${labels.lowConfidence(
        report.confidence.confidence,
        report.confidence.reason,
      )}${scoreDetail}${claimDetail}`,
    );
  }

  for (const v of report.retryViolations) {
    warnings.push(
      `${labels.guardLabel}: ${labels.toolRetry(
        v.toolName,
        v.retryCount,
        v.maxRetries,
        v.lastErrorCode ?? "unknown",
      )}`,
    );
  }

  if (report.circuitBreakerTripped && report.circuitBreakerDetail !== null) {
    warnings.push(
      `${labels.guardLabel}: ${labels.circuitBreaker(report.circuitBreakerDetail)}`,
    );
  }

  return warnings;
}
