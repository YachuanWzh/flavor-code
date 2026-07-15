let graphemeSegmenter: Intl.Segmenter | undefined;
export function getGraphemeSegmenter(): Intl.Segmenter {
  return graphemeSegmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
}

/**
 * Detect the system locale as a BCP47 language tag (e.g. "zh-CN", "en-US").
 * Uses Intl (available since Node 13) and falls back to POSIX locale
 * environment variables on Unix systems.
 */
export function detectSystemLocale(): string {
  // Primary: Intl.DateTimeFormat gives a BCP47 tag directly.
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale && locale.length >= 2) return locale;
  } catch {
    // Ignore — Intl is not available or throws.
  }

  // Fallback: parse POSIX-style LANG / LC_ALL on Unix.
  for (const key of ["LANG", "LC_ALL", "LC_MESSAGES"]) {
    const raw = process.env[key];
    if (!raw || raw === "C" || raw === "POSIX") continue;
    const match = raw.match(/^([a-z]{2})_([A-Z]{2})(?:[.@].*)?$/);
    if (match) return `${match[1]}-${match[2]}`;
  }

  // Ultimate fallback: Simplified Chinese.
  return "zh-CN";
}

/**
 * Resolve the effective language tag: explicit config wins, then system
 * detection, and finally "en-US" as the ultimate default.
 */
export function resolveLanguage(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  return detectSystemLocale();
}

/**
 * Build a short instruction suffix that tells the agent which language to
 * reply in.  When the tag is English we still emit it so the model knows
 * the preference is explicit.
 */
export function languageInstruction(language: string): string {
  // Map common BCP47 tags to human-readable labels the model understands.
  const label = LANG_LABELS.get(language) ?? language;
  return `Always respond in ${label}. Do NOT reply in any other language unless the user explicitly asks for it.`;
}

const LANG_LABELS = new Map<string, string>([
  ["zh-CN", "Simplified Chinese (zh-CN)"],
  ["zh-TW", "Traditional Chinese (zh-TW)"],
  ["zh-HK", "Traditional Chinese (zh-HK)"],
  ["ja-JP", "Japanese (ja-JP)"],
  ["ko-KR", "Korean (ko-KR)"],
  ["en-US", "English (en-US)"],
  ["en-GB", "English (en-GB)"],
  ["fr-FR", "French (fr-FR)"],
  ["de-DE", "German (de-DE)"],
  ["es-ES", "Spanish (es-ES)"],
  ["pt-BR", "Portuguese (pt-BR)"],
  ["ru-RU", "Russian (ru-RU)"],
  ["ar-SA", "Arabic (ar-SA)"],
  ["vi-VN", "Vietnamese (vi-VN)"],
  ["th-TH", "Thai (th-TH)"],
  ["id-ID", "Indonesian (id-ID)"],
]);
