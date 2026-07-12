/**
 * Strip well-known API key patterns from an arbitrary error string so it is
 * safe to display to the user or write to logs.
 */
export function redactErrorText(text: string): string {
  return text
    .replace(/\bsk-[A-Za-z0-9_-]+\b/g, "[redacted]")
    .replace(/(authorization|api[_ -]?key|token)\s*[:=]\s*\S+/gi, "$1=[redacted]");
}

/**
 * Replace every occurrence of each secret string inside `input` with
 * `[redacted]`. Used for diagnostics that may contain configured API keys.
 */
export function redactSecrets(input: string, secrets: readonly string[]): string {
  return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), input);
}
