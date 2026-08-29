import { gt, isValidVersion } from "../utils/semver.js";
export const NPM_PACKAGE_NAME = "flavor-code";

const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${NPM_PACKAGE_NAME}/latest`;
const DEFAULT_TIMEOUT_MS = 3_000;

interface RegistryResponse {
  ok: boolean;
  json(): Promise<unknown>;
}

export type RegistryFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<RegistryResponse>;

export interface UpdateCheckOptions {
  /** Injectable fetch for tests; defaults to the global Node fetch. */
  fetchImpl?: RegistryFetch;
  timeoutMs?: number;
}

/** Returns `latest` only when it is a valid semver strictly newer than `current`. */
export function findNewerVersion(current: string, latest: string): string | undefined {
  if (!isValidVersion(current) || !isValidVersion(latest)) return undefined;
  return gt(latest, current) ? latest : undefined;
}

/** Fetch the latest published version from the npm registry; undefined on any failure. */
export async function fetchLatestVersion(
  options: UpdateCheckOptions = {},
): Promise<string | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), timeoutMs);
    timer.unref?.();
  });
  try {
    const response = await Promise.race([
      fetchImpl(REGISTRY_LATEST_URL, { signal: AbortSignal.timeout(timeoutMs) }),
      timeout,
    ]);
    if (response === undefined || !response.ok) return undefined;
    const body = await Promise.race([response.json(), timeout]) as { version?: unknown };
    return typeof body?.version === "string" ? body.version : undefined;
  } catch {
    // Offline, DNS failure, aborted request, malformed body: never surface it.
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Resolves the newer version to upgrade to, or undefined when up to date / unreachable. */
export async function checkForUpdate(
  current: string,
  options: UpdateCheckOptions = {},
): Promise<string | undefined> {
  const latest = await fetchLatestVersion(options);
  return latest === undefined ? undefined : findNewerVersion(current, latest);
}
