import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const HISTORY_VERSION = 1;

interface PromptHistoryDocument {
  version: typeof HISTORY_VERSION;
  workspace: string;
  entries: string[];
}

export interface PromptHistoryStoreOptions {
  home: string;
  workspace: string;
  maxEntries?: number;
}

/**
 * A private, per-workspace CLI history. Keeping it outside the repository
 * avoids dirtying projects and prevents prompts from one workspace appearing
 * in another workspace's history.
 */
export class PromptHistoryStore {
  readonly #directory: string;
  readonly #path: string;
  readonly #workspace: string;
  readonly #maxEntries: number;
  #writeChain: Promise<void> = Promise.resolve();

  constructor(options: PromptHistoryStoreOptions) {
    this.#workspace = resolve(options.workspace);
    this.#maxEntries = Math.max(1, Math.floor(options.maxEntries ?? 200));
    this.#directory = join(resolve(options.home), ".flavor-code", "history");
    const key = createHash("sha256").update(this.#workspace).digest("hex").slice(0, 24);
    this.#path = join(this.#directory, `${key}.json`);
  }

  async load(): Promise<string[]> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<PromptHistoryDocument>;
      if (parsed.version !== HISTORY_VERSION || parsed.workspace !== this.#workspace || !Array.isArray(parsed.entries)) return [];
      return parsed.entries.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).slice(-this.#maxEntries);
    } catch {
      return [];
    }
  }

  append(entry: string): Promise<void> {
    const normalized = entry.trim();
    if (normalized.length === 0) return this.#writeChain;
    this.#writeChain = this.#writeChain.catch(() => undefined).then(async () => {
      const entries = [...await this.load(), normalized].slice(-this.#maxEntries);
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.#directory, `.${randomUUID()}.tmp`);
      const document: PromptHistoryDocument = { version: HISTORY_VERSION, workspace: this.#workspace, entries };
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.#path);
    });
    return this.#writeChain;
  }
}

