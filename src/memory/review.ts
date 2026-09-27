import { createHash } from "node:crypto";
import { z } from "zod";

import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { containsSensitiveMemory, normalizeMemoryContent } from "./store.js";
import type { MemoryCandidate, MemoryScores, ScoredMemoryCandidate } from "./types.js";

export interface MemoryReviewItem extends MemoryCandidate {
  id: string;
  taskId?: string;
  summary?: string;
  topicKey?: string;
  keywords?: string[];
  scores?: MemoryScores;
  evidence?: string;
  createdAt?: string;
}

const ReviewItemSchema = z.object({
  id: z.string(), type: z.enum(["user", "feedback", "project", "reference"]), content: z.string().min(1).max(20_000),
  taskId: z.string().optional(), summary: z.string().max(240).optional(), topicKey: z.string().max(128).optional(),
  keywords: z.array(z.string()).max(8).optional(),
  evidence: z.string().max(160).optional(),
  scores: z.object({ durability: z.number(), futureUtility: z.number(), authority: z.number(), nonDerivability: z.number() }).optional(),
  createdAt: z.string().optional(),
}).strict();
const DecisionsSchema = z.object({ offered: z.number().int().nonnegative(), accepted: z.number().int().nonnegative(), dismissed: z.number().int().nonnegative() }).strict();
export const MAX_PENDING_MEMORY_REVIEWS = 20;
const InboxSchema = z.object({ version: z.literal(1), pending: z.array(ReviewItemSchema).max(MAX_PENDING_MEMORY_REVIEWS), decisions: DecisionsSchema.optional() }).strict();

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
  /** Persist pending reviews across turns and process restarts. */
  storagePath?: string;
}

/** Holds model-generated memory outside the durable store until the user accepts it. */
export class MemoryReviewBridge {
  readonly #remember: MemoryReviewBridgeOptions["remember"];
  readonly #onChange: (() => void) | undefined;
  readonly #onDismiss: (() => void) | undefined;
  readonly #onAccept: (() => void) | undefined;
  readonly autoDismissSeconds: number;
  readonly #storagePath: string | undefined;
  readonly #autoDismissTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #accepting = new Set<string>();
  #pending: MemoryReviewItem[] = [];
  #decisions = { offered: 0, accepted: 0, dismissed: 0 };
  #persistTail: Promise<void> = Promise.resolve();
  #persistResult: Promise<void> = Promise.resolve();

  constructor(options: MemoryReviewBridgeOptions) {
    this.#remember = options.remember;
    this.#onChange = options.onChange;
    this.#onDismiss = options.onDismiss;
    this.#onAccept = options.onAccept;
    this.autoDismissSeconds = options.autoDismissSeconds ?? 0;
    this.#storagePath = options.storagePath;
  }

  async initialize(): Promise<void> {
    if (this.#storagePath === undefined) return;
    const saved = await readRecoverableFile(this.#storagePath, (raw) => InboxSchema.parse(JSON.parse(raw)));
    this.#pending = (saved?.value.pending ?? []).map((item) => ({
      id: item.id, type: item.type, content: item.content,
      ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
      ...(item.summary === undefined ? {} : { summary: item.summary }),
      ...(item.topicKey === undefined ? {} : { topicKey: item.topicKey }),
      ...(item.keywords === undefined ? {} : { keywords: item.keywords }),
      ...(item.scores === undefined ? {} : { scores: item.scores }),
      ...(item.evidence === undefined ? {} : { evidence: item.evidence }),
      ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
    }));
    this.#decisions = saved?.value.decisions ?? { offered: 0, accepted: 0, dismissed: 0 };
    if (this.#pending.length > 0) this.#onChange?.();
  }

  async flush(): Promise<void> { await this.#persistResult; }

  get stats(): Readonly<{ offered: number; accepted: number; dismissed: number; pending: number }> {
    return { ...this.#decisions, pending: this.#pending.length };
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
      if (this.#pending.length >= (this.#storagePath === undefined ? 1 : MAX_PENDING_MEMORY_REVIEWS)) break;
      const content = normalizeMemoryContent(candidate.content);
      if (!content || containsSensitiveMemory(content)) continue;
      const duplicate = this.#pending.some((item) => item.type === candidate.type
        && normalizeMemoryContent(item.content).toLocaleLowerCase() === content.toLocaleLowerCase());
      if (duplicate) continue;
      const scored = candidate as Partial<ScoredMemoryCandidate>;
      if ([scored.summary, scored.topicKey, ...(scored.keywords ?? [])]
        .some((field) => field !== undefined && containsSensitiveMemory(field))) continue;
      const id = `memory-review-${createHash("sha256").update(`${candidate.type}\0${content.toLocaleLowerCase()}`).digest("hex").slice(0, 12)}`;
      this.#pending.push({
        id,
        type: candidate.type,
        content,
        ...(taskId === undefined ? {} : { taskId }),
        ...(scored.summary === undefined ? {} : { summary: scored.summary }),
        ...(scored.topicKey === undefined ? {} : { topicKey: scored.topicKey }),
        ...(scored.keywords === undefined ? {} : { keywords: scored.keywords }),
        ...(scored.scores === undefined ? {} : { scores: scored.scores }),
        ...(scored.evidence === undefined || containsSensitiveMemory(scored.evidence) ? {} : { evidence: scored.evidence }),
        createdAt: new Date().toISOString(),
      });
      if (this.autoDismissSeconds > 0) {
        this.#autoDismissTimers.set(id, setTimeout(() => this.#autoDismiss(id), this.autoDismissSeconds * 1_000));
      }
      added += 1;
    }
    if (added > 0) { this.#decisions.offered += added; this.#persist(); this.#onChange?.(); }
    return added;
  }

  async accept(id: string): Promise<boolean> {
    const item = this.#pending.find((candidate) => candidate.id === id);
    if (item === undefined || this.#accepting.has(id)) return false;
    this.#accepting.add(id);
    try {
      await this.#remember(item);
      this.#decisions.accepted += 1;
      this.#remove(id);
      await this.flush();
      this.#onAccept?.();
      return true;
    } finally {
      this.#accepting.delete(id);
    }
  }

  dismiss(id: string): boolean {
    if (this.#accepting.has(id)) return false;
    const removed = this.#remove(id);
    if (removed) { this.#decisions.dismissed += 1; this.#persist(); this.#onDismiss?.(); }
    return removed;
  }

  dismissAll(): number {
    const removable = this.#pending.filter((item) => !this.#accepting.has(item.id));
    const count = removable.length;
    if (count === 0) return 0;
    this.#pending = this.#pending.filter((item) => this.#accepting.has(item.id));
    for (const item of removable) this.#clearTimer(item.id);
    this.#persist();
    this.#onChange?.();
    return count;
  }

  dispose(): void {
    this.#clearTimers();
    if (this.#storagePath === undefined) this.dismissAll();
  }

  #autoDismiss(id: string): void {
    this.#autoDismissTimers.delete(id);
    if (this.#accepting.has(id)) return;
    if (!this.#pending.some((candidate) => candidate.id === id)) return;
    this.#pending = this.#pending.filter((candidate) => candidate.id !== id);
    this.#persist();
    this.#onChange?.();
  }

  #remove(id: string): boolean {
    const index = this.#pending.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    this.#pending = [...this.#pending.slice(0, index), ...this.#pending.slice(index + 1)];
    this.#clearTimer(id);
    this.#persist();
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

  #persist(): void {
    if (this.#storagePath === undefined) return;
    const snapshot = { version: 1 as const, pending: [...this.#pending], decisions: { ...this.#decisions } };
    const path = this.#storagePath;
    const next = this.#persistTail.then(() => updateProtectedFile({
      path,
      decode: (raw) => InboxSchema.parse(JSON.parse(raw)),
      encode: (value) => JSON.stringify(value, null, 2),
      update: () => snapshot,
    })).then(() => undefined);
    this.#persistResult = next;
    this.#persistTail = next.catch(() => undefined);
  }
}
