import { dirname } from "node:path";
import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { decryptDocument, encryptDocument, loadOrCreateConfigKey } from "../config/secret-envelope.js";
import { isOAuthLlmConfig } from "./oauth-config.js";
import type { OAuthLlmConfig } from "./types.js";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO 8601
  scope?: string;
  configVersion?: number;
  llmConfig?: OAuthLlmConfig;
}

export interface OAuthTokenStore {
  tokens: Record<string, StoredToken>;
  load(): Promise<Record<string, StoredToken>>;
  save(tokens: Record<string, StoredToken>): Promise<void>;
}

/**
 * Reduce the token store to a single credential. `/login` is a switch-to
 * operation: keeping tokens from earlier services made the runtime pick the
 * active provider by registration order, so the welcome card could show a
 * stale service (e.g. a previous "Token Plan") instead of the one just logged in.
 */
export async function retainOnlyCredentials(store: OAuthTokenStore, keepCredentialId: string): Promise<void> {
  const tokens = await store.load();
  const retained = Object.fromEntries(Object.entries(tokens).filter(([id]) => id === keepCredentialId));
  await store.save(retained);
}

export function createFileTokenStore(filePath: string): OAuthTokenStore {
  let baseline: Record<string, StoredToken> = {};
  const store: OAuthTokenStore = {
    tokens: {},
    async load() {
      const key = await loadOrCreateConfigKey(dirname(filePath));
      const result = await readRecoverableFile(filePath, (raw) => parseTokens(decryptDocument(raw, key)));
      const tokens = result?.value ?? {};
      baseline = { ...tokens };
      store.tokens = tokens;
      return tokens;
    },
    async save(tokens) {
      const key = await loadOrCreateConfigKey(dirname(filePath));
      const removals = Object.keys(baseline).filter((providerId) => !(providerId in tokens));
      const upserts = Object.fromEntries(Object.entries(tokens).filter(([providerId, token]) =>
        !sameToken(baseline[providerId], token),
      ));
      const merged = await updateProtectedFile<Record<string, StoredToken>>({
        path: filePath,
        decode: (raw) => parseTokens(decryptDocument(raw, key)),
        encode: (value) => encryptDocument(value, key),
        backupEncode: (value) => encryptDocument(value, key),
        update: (current) => {
          const next = { ...(current ?? {}), ...upserts };
          for (const providerId of removals) delete next[providerId];
          return next;
        },
      });
      baseline = { ...merged };
      store.tokens = merged;
    },
  };
  return store;
}

function parseTokens(parsed: unknown): Record<string, StoredToken> {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("OAuth token file must contain an object");
  }
  const tokens: Record<string, StoredToken> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!isStoredToken(value)) throw new Error(`Invalid OAuth token entry for provider ${key}`);
    tokens[key] = value;
  }
  return tokens;
}

function sameToken(left: StoredToken | undefined, right: StoredToken): boolean {
  return left !== undefined
    && left.accessToken === right.accessToken
    && left.refreshToken === right.refreshToken
    && left.expiresAt === right.expiresAt
    && left.scope === right.scope
    && left.configVersion === right.configVersion
    && JSON.stringify(left.llmConfig) === JSON.stringify(right.llmConfig);
}

function isStoredToken(value: unknown): value is StoredToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "accessToken" in value &&
    typeof (value as StoredToken).accessToken === "string" &&
    (value as StoredToken).accessToken.length > 0 &&
    "expiresAt" in value &&
    typeof (value as StoredToken).expiresAt === "string" &&
    (!("configVersion" in value) || (value as StoredToken).configVersion === undefined
      || (Number.isInteger((value as StoredToken).configVersion) && (value as StoredToken).configVersion! >= 1)) &&
    (!("llmConfig" in value) || (value as StoredToken).llmConfig === undefined
      || isOAuthLlmConfig((value as StoredToken).llmConfig))
  );
}
