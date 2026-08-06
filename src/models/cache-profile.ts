/**
 * Intelligent cache-capability identification for model providers.
 *
 * Provider protocol (`apiType`) is read from the project `.flavor/flavor.json`
 * (or the PKCE token `llm_config`); combined with `baseURL` heuristics it
 * decides which prompt-cache strategy applies so the runtime can surface
 * accurate diagnostics instead of assuming every endpoint caches like
 * Anthropic.
 */

export type CacheStrategy = "explicit" | "implicit" | "none";

export interface CacheProfileInput {
  apiType?: string | undefined;
  baseURL?: string | undefined;
}

export interface CacheProfile {
  strategy: CacheStrategy;
  /** Whether client-side cache markers (cache_control breakpoints) are honored. */
  markersSupported: boolean;
  reason: string;
}

const DASHSCOPE_HOST_PATTERNS = [
  /^dashscope(-[a-z0-9]+)?\.aliyuncs\.com$/,
  /\.maas\.aliyuncs\.com$/,
] as const;

function baseURLHost(baseURL: string | undefined): string | undefined {
  if (baseURL === undefined) return undefined;
  try {
    return new URL(baseURL).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True when the baseURL points at an Alibaba Cloud DashScope / MaaS gateway. */
export function isDashScopeBaseURL(baseURL: string | undefined): boolean {
  const host = baseURLHost(baseURL);
  if (host === undefined) return false;
  return DASHSCOPE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

export function resolveCacheProfile(input: CacheProfileInput): CacheProfile {
  if (input.apiType === "anthropic") {
    return {
      strategy: "explicit",
      markersSupported: true,
      reason: "Anthropic-compatible protocol sends cache_control breakpoints derived from context cache breakpoints",
    };
  }
  if (input.apiType === "openai") {
    if (isDashScopeBaseURL(input.baseURL)) {
      return {
        strategy: "implicit",
        markersSupported: false,
        reason: "DashScope Context Cache only applies to Chat Completions, DashScope, and Anthropic-compatible interfaces; Responses API requests rely on server-side prefix matching with unreliable hit rates",
      };
    }
    return {
      strategy: "implicit",
      markersSupported: false,
      reason: "relies on provider-side automatic prefix caching",
    };
  }
  return {
    strategy: "none",
    markersSupported: false,
    reason: "unknown protocol; cache support cannot be identified",
  };
}
