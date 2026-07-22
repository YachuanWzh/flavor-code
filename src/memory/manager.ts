import { loadConfig } from "../config/load.js";
import { MemoryStore } from "./store.js";
import type { MemoryCandidate, MemoryEntry } from "./types.js";

export interface MemorySnapshot {
  enabled: boolean;
  path: string;
  entries: readonly MemoryEntry[];
}

export interface MemoryManagerLike {
  snapshot(): Promise<MemorySnapshot>;
  remember(candidate: MemoryCandidate): Promise<MemoryEntry>;
  update(id: string, candidate: MemoryCandidate): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
}

export class ProjectMemoryManager implements MemoryManagerLike {
  readonly #store: MemoryStore;
  readonly #enabled: boolean;

  constructor(store: MemoryStore, enabled = true) {
    this.#store = store;
    this.#enabled = enabled;
  }

  async snapshot(): Promise<MemorySnapshot> {
    return {
      enabled: this.#enabled,
      path: this.#store.path,
      entries: this.#enabled ? await this.#store.list() : [],
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
