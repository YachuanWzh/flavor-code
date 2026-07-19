export function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizePersistedWorkspace(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("workspace" in value)) return undefined;
  const workspace = (value as { workspace?: unknown }).workspace;
  return typeof workspace === "string" && workspace.trim().length > 0 && workspace.length <= 32_768
    ? workspace
    : undefined;
}

export function isTrustedNavigation(target: string, current: string, trustedRenderer: string): boolean {
  return target === trustedRenderer || (current === trustedRenderer && target === current);
}
