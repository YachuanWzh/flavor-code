import { loadConfig } from "../config/load.js";
import { MemoryStore } from "./store.js";
import { classifyMemoryHeat } from "./retrieval.js";
import type { MemoryCandidate, MemoryEntry, MemoryHeat } from "./types.js";

export interface ManagedMemoryEntry extends MemoryEntry {
  recallTotal?: number;
  heat?: MemoryHeat;
  lastRecalledAt?: string;
}

export interface MemorySnapshot {
  enabled: boolean;
  path: string;
  entries: readonly ManagedMemoryEntry[];
}

export interface MemoryManagerLike {
  snapshot(now?: Date): Promise<MemorySnapshot>;
  remember(candidate: MemoryCandidate): Promise<MemoryEntry>;
  update(id: string, candidate: MemoryCandidate): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  deleteCold?(now?: Date): Promise<{ removed: number; filesRemoved: number }>;
}

export class ProjectMemoryManager implements MemoryManagerLike {
  readonly #store: MemoryStore;
  readonly #enabled: boolean;

  constructor(store: MemoryStore, enabled = true) {
    this.#store = store;
    this.#enabled = enabled;
  }

  async snapshot(now = new Date()): Promise<MemorySnapshot> {
    const references = this.#enabled ? await this.#store.references() : [];
    return {
      enabled: this.#enabled,
      path: this.#store.path,
      entries: references.map((reference) => {
        const lastRecalledAt = Object.values(reference.recalls).sort().at(-1);
        return {
          id: reference.id, type: reference.type, content: reference.summary,
          recallTotal: reference.recallTotal, heat: classifyMemoryHeat(reference, now),
          ...(lastRecalledAt === undefined ? {} : { lastRecalledAt }),
        };
      }),
    };
  }

  async remember(candidate: MemoryCandidate): Promise<MemoryEntry> {
    this.#assertEnabled();
    const result = await this.#store.remember(candidate);
    if (!result.added) throw new Error("Memory entry already exists or the configured capacity has been reached");
    return result.entry;
  }

  async update(id: string, candidate: MemoryCandidate): Promise<MemoryEntry> {
    this.#assertEnabled();
    return this.#store.update(id, candidate);
  }

  async delete(id: string): Promise<boolean> {
    this.#assertEnabled();
    return this.#store.delete(id);
  }

  async deleteCold(now = new Date()): Promise<{ removed: number; filesRemoved: number }> {
    this.#assertEnabled();
    return this.#store.forgetCold(now);
  }

  #assertEnabled(): void {
    if (!this.#enabled) throw new Error("Long-term memory is disabled for this project");
  }
}

export async function createProjectMemoryManager(options: { workspace: string; home: string }): Promise<ProjectMemoryManager> {
  const { memory } = (await loadConfig({ cwd: options.workspace, home: options.home })).config;
  const store = new MemoryStore({
    workspace: options.workspace,
    maxEntries: memory.maxEntries,
    maxEntryChars: memory.maxEntryChars,
  });
  return new ProjectMemoryManager(store, memory.enabled);
}
