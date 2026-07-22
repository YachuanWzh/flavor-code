import { normalizeMemoryContent } from "./store.js";
import type { MemoryCandidate, MemoryScores, ScoredMemoryCandidate } from "./types.js";

export interface MemoryReviewItem extends MemoryCandidate {
  id: string;
  taskId?: string;
  summary?: string;
  topicKey?: string;
  keywords?: string[];
  scores?: MemoryScores;
}

export interface MemoryReviewBridgeOptions {
  remember(candidate: MemoryReviewItem): Promise<unknown>;
  onChange?(): void;
}

/** Holds model-generated memory outside the durable store until the user accepts it. */
export class MemoryReviewBridge {
  readonly #remember: MemoryReviewBridgeOptions["remember"];
  readonly #onChange: (() => void) | undefined;
  #pending: MemoryReviewItem[] = [];
  #nextId = 1;

  constructor(options: MemoryReviewBridgeOptions) {
    this.#remember = options.remember;
    this.#onChange = options.onChange;
  }

  get pending(): readonly MemoryReviewItem[] {
    return this.#pending;
  }

  offer(candidates: readonly MemoryCandidate[]): number;
  offer(taskId: string, candidates: readonly ScoredMemoryCandidate[]): number;
  offer(taskIdOrCandidates: string | readonly MemoryCandidate[], scoredCandidates?: readonly ScoredMemoryCandidate[]): number {
    const taskId = typeof taskIdOrCandidates === "string" ? taskIdOrCandidates : undefined;
    const candidates = typeof taskIdOrCandidates === "string" ? scoredCandidates ?? [] : taskIdOrCandidates;
    let added = 0;
    for (const candidate of candidates) {
      const content = normalizeMemoryContent(candidate.content);
      const duplicate = this.#pending.some((item) => item.type === candidate.type
        && normalizeMemoryContent(item.content).toLocaleLowerCase() === content.toLocaleLowerCase());
      if (duplicate) continue;
      const scored = candidate as Partial<ScoredMemoryCandidate>;
      this.#pending.push({
        id: `memory-review-${this.#nextId++}`,
        type: candidate.type,
        content,
        ...(taskId === undefined ? {} : { taskId }),
        ...(scored.summary === undefined ? {} : { summary: scored.summary }),
        ...(scored.topicKey === undefined ? {} : { topicKey: scored.topicKey }),
        ...(scored.keywords === undefined ? {} : { keywords: scored.keywords }),
        ...(scored.scores === undefined ? {} : { scores: scored.scores }),
      });
      added += 1;
    }
    if (added > 0) this.#onChange?.();
    return added;
  }

  async accept(id: string): Promise<boolean> {
    const item = this.#pending.find((candidate) => candidate.id === id);
    if (item === undefined) return false;
    await this.#remember(item);
    this.#remove(id);
    return true;
  }

  dismiss(id: string): boolean {
    return this.#remove(id);
  }

  dispose(): void {
    if (this.#pending.length === 0) return;
    this.#pending = [];
    this.#onChange?.();
  }

  #remove(id: string): boolean {
    const index = this.#pending.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.#pending = [...this.#pending.slice(0, index), ...this.#pending.slice(index + 1)];
    this.#onChange?.();
    return true;
  }
}
