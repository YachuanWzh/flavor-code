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

export interface PersistedDesktopProjects {
  workspace?: string;
  projects: readonly string[];
}

/** Accepts the legacy single-workspace record and the multi-project desktop record. */
export function normalizePersistedDesktopProjects(value: unknown): PersistedDesktopProjects {
  const workspace = normalizePersistedWorkspace(value);
  if (typeof value !== "object" || value === null) {
    return { ...(workspace === undefined ? {} : { workspace }), projects: workspace === undefined ? [] : [workspace] };
  }
  const rawProjects = (value as { projects?: unknown }).projects;
  const projects = Array.isArray(rawProjects)
    ? rawProjects.filter((item): item is string => typeof item === "string" && item.trim().length > 0 && item.length <= 32_768)
    : [];
  const unique = [...new Set([...(workspace === undefined ? [] : [workspace]), ...projects])].slice(0, 50);
  return { ...(workspace === undefined ? {} : { workspace }), projects: unique };
}

export function isTrustedNavigation(target: string, current: string, trustedRenderer: string): boolean {
  return target === trustedRenderer || (current === trustedRenderer && target === current);
}
