import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string; // ISO 8601
  scope?: string;
}

export interface OAuthTokenStore {
  tokens: Record<string, StoredToken>;
  load(): Promise<Record<string, StoredToken>>;
  save(tokens: Record<string, StoredToken>): Promise<void>;
}

export function createFileTokenStore(filePath: string): OAuthTokenStore {
  const store: OAuthTokenStore = {
    tokens: {},
    async load() {
      try {
        const raw = await readFile(filePath, "utf8");
        if (raw.trim().length === 0) return {};
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
          return {};
        }
        const tokens: Record<string, StoredToken> = {};
        for (const [key, value] of Object.entries(parsed)) {
          if (isStoredToken(value)) tokens[key] = value;
        }
        store.tokens = tokens;
        return tokens;
      } catch (error) {
        if (isMissingFileError(error)) return {};
        if (error instanceof SyntaxError) return {};
        throw error;
      }
    },
    async save(tokens) {
      store.tokens = { ...tokens };
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, JSON.stringify(tokens, null, 2), "utf8");
    },
  };
  return store;
}

function isStoredToken(value: unknown): value is StoredToken {
  return (
    typeof value === "object" &&
    value !== null &&
    "accessToken" in value &&
    typeof (value as StoredToken).accessToken === "string" &&
    (value as StoredToken).accessToken.length > 0 &&
    "expiresAt" in value &&
    typeof (value as StoredToken).expiresAt === "string"
  );
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
