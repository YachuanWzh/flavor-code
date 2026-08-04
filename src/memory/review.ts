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
  /** Called after a candidate is explicitly dismissed by the user. */
  onDismiss?(): void;
  /** Called after a candidate is accepted and stored. */
  onAccept?(): void;
  /**
   * Seconds an unconfirmed candidate stays pending before it is silently
   * dismissed. 0 (the default) disables the auto-dismiss timer. A timeout is
   * not an explicit user dismissal and never triggers {@link onDismiss}.
   */
  autoDismissSeconds?: number;
}

/** Holds model-generated memory outside the durable store until the user accepts it. */
export class MemoryReviewBridge {
  readonly #remember: MemoryReviewBridgeOptions["remember"];
  readonly #onChange: (() => void) | undefined;
  readonly #onDismiss: (() => void) | undefined;
  readonly #onAccept: (() => void) | undefined;
  readonly autoDismissSeconds: number;
  readonly #autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #pending: MemoryReviewItem[] = [];
  #nextId = 1;

  constructor(options: MemoryReviewBridgeOptions) {
    this.#remember = options.remember;
    this.#onChange = options.onChange;
    this.#onDismiss = options.onDismiss;
    this.#onAccept = options.onAccept;
    this.autoDismissSeconds = options.autoDismissSeconds ?? 0;
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
      if (this.#pending.length >= 1) break;
      const content = normalizeMemoryContent(candidate.content);
      const duplicate = this.#pending.some((item) => item.type === candidate.type
        && normalizeMemoryContent(item.content).toLocaleLowerCase() === content.toLocaleLowerCase());
      if (duplicate) continue;
      const scored = candidate as Partial<ScoredMemoryCandidate>;
      const id = `memory-review-${this.#nextId++}`;
      this.#pending.push({
        id,
        type: candidate.type,
        content,
        ...(taskId === undefined ? {} : { taskId }),
        ...(scored.summary === undefined ? {} : { summary: scored.summary }),
        ...(scored.topicKey === undefined ? {} : { topicKey: scored.topicKey }),
        ...(scored.keywords === undefined ? {} : { keywords: scored.keywords }),
        ...(scored.scores === undefined ? {} : { scores: scored.scores }),
      });
      if (this.autoDismissSeconds > 0) {
        this.#autoDismissTimers.set(id, setTimeout(() => this.#autoDismiss(id), this.autoDismissSeconds * 1_000));
      }
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
    this.#onAccept?.();
    return true;
  }

  dismiss(id: string): boolean {
    const removed = this.#remove(id);
    if (removed) this.#onDismiss?.();
    return removed;
  }

  dismissAll(): number {
    const count = this.#pending.length;
    if (count === 0) return 0;
    this.#pending = [];
    this.#clearTimers();
    this.#onChange?.();
    return count;
  }

  dispose(): void {
    this.dismissAll();
  }

  #autoDismiss(id: string): void {
    this.#autoDismissTimers.delete(id);
    if (!this.#pending.some((candidate) => candidate.id === id)) return;
    this.#pending = this.#pending.filter((candidate) => candidate.id !== id);
    this.#onChange?.();
  }

  #remove(id: string): boolean {
    const index = this.#pending.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.#pending = [...this.#pending.slice(0, index), ...this.#pending.slice(index + 1)];
    this.#clearTimer(id);
    this.#onChange?.();
    return true;
  }

  #clearTimer(id: string): void {
    const timer = this.#autoDismissTimers.get(id);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#autoDismissTimers.delete(id);
    }
  }

  #clearTimers(): void {
    for (const timer of this.#autoDismissTimers.values()) clearTimeout(timer);
    this.#autoDismissTimers.clear();
  }
}
