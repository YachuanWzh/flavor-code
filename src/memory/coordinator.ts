import { modelContentText, type ModelMessage } from "../models/types.js";
import { buildMemoryExtractionPrompt, parseScoredMemoryCandidates } from "./extractor.js";
import type { ScoredMemoryCandidate } from "./types.js";

export interface MemoryCoordinatorOptions {
  review(taskId: string, candidates: readonly ScoredMemoryCandidate[]): void | Promise<void>;
  remember(taskId: string, candidates: readonly ScoredMemoryCandidate[]): number | Promise<number>;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  minChars: number;
  maxEntryChars: number;
  scoreThreshold: number;
  maxCandidates: number;
  /** Candidates at or above this total score are stored directly without user review. Defaults to 11. */
  autoStoreThreshold?: number;
  language?: string;
}

const MAX_TASK_PROMPT_CHARS = 20_000;
const DEFAULT_AUTO_STORE_THRESHOLD = 11;

export interface MemoryFinalizationResult {
  evaluated: boolean;
  candidates: boolean;
  /** Number of candidates stored directly without review because they met the auto-store threshold. */
  stored: number;
}

export interface ExplicitMemoryResult extends MemoryFinalizationResult {
  stored: number;
}

export class MemoryCoordinator {
  onError: ((error: unknown) => void) | undefined;
  readonly #options: MemoryCoordinatorOptions & { autoStoreThreshold: number; minChars: number; maxCandidates: number };
  readonly #controller = new AbortController();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryCoordinatorOptions) {
    if (!Number.isSafeInteger(options.minChars) || options.minChars < 0) throw new Error("minChars must be a non-negative integer");
    if (!Number.isSafeInteger(options.scoreThreshold) || options.scoreThreshold < 0 || options.scoreThreshold > 12) throw new Error("scoreThreshold must be between 0 and 12");
    if (!Number.isSafeInteger(options.maxCandidates) || options.maxCandidates < 1) throw new Error("maxCandidates must be positive");
    const autoStoreThreshold = options.autoStoreThreshold ?? DEFAULT_AUTO_STORE_THRESHOLD;
    if (!Number.isSafeInteger(autoStoreThreshold) || autoStoreThreshold < 0 || autoStoreThreshold > 12) {
      throw new Error("autoStoreThreshold must be an integer between 0 and 12");
    }
    // Clamp below the review threshold so every candidate still passes the host gates before direct writes.
    this.#options = {
      ...options,
      autoStoreThreshold: Math.max(options.scoreThreshold, autoStoreThreshold),
      minChars: Math.max(200, options.minChars),
      maxCandidates: 1,
    };
  }

  async finalize(taskId: string, messages: readonly ModelMessage[]): Promise<MemoryFinalizationResult> {
    const result = await this.#evaluate(taskId, messages, false);
    return { evaluated: result.evaluated, candidates: result.candidates, stored: result.stored };
  }

  async rememberExplicit(taskId: string, messages: readonly ModelMessage[]): Promise<ExplicitMemoryResult> {
    return this.#evaluate(taskId, messages, true);
  }

  async #evaluate(taskId: string, messages: readonly ModelMessage[], explicit: boolean): Promise<ExplicitMemoryResult> {
    const visible = visibleMessages(messages);
    const visibleChars = visible.reduce((total, message) => total + [...modelContentText(message.content).trim()].length, 0);
    if (visibleChars === 0 || (!explicit && visibleChars < this.#options.minChars)) {
      return { evaluated: true, candidates: false, stored: 0 };
    }
    let evaluated = true;
    let accepted = false;
    let stored = 0;
    const operation = this.#tail.then(async () => {
      this.#controller.signal.throwIfAborted();
      const raw = await this.#options.generate(buildMemoryExtractionPrompt(
        boundTaskMessages(visible), {
          ...(explicit ? { explicitIntent: true } : {}),
          ...(this.#options.language === undefined ? {} : { outputLanguage: this.#options.language }),
          maxCandidates: this.#options.maxCandidates,
        },
      ), this.#controller.signal);
      const candidates = parseScoredMemoryCandidates(raw, {
        maxEntryChars: this.#options.maxEntryChars,
        scoreThreshold: this.#options.scoreThreshold,
        maxCandidates: this.#options.maxCandidates,
      });
      if (candidates.length > 0) {
        if (explicit) {
          stored = await this.#options.remember(taskId, candidates);
        } else {
          const autoStored = candidates.filter((candidate) => totalScore(candidate) >= this.#options.autoStoreThreshold);
          const needsReview = candidates.filter((candidate) => totalScore(candidate) < this.#options.autoStoreThreshold);
          if (autoStored.length > 0) stored += await this.#options.remember(taskId, autoStored);
          if (needsReview.length > 0) await this.#options.review(taskId, needsReview);
        }
        accepted = true;
      }
    }).catch((error) => {
      evaluated = false;
      if (!this.#controller.signal.aborted) this.onError?.(error);
    });
    this.#tail = operation;
    await operation;
    return { evaluated, candidates: accepted, stored };
  }

  async flush(): Promise<void> { await this.#tail; }

  abort(reason: unknown = new Error("Memory coordinator disposed")): void { this.#controller.abort(reason); }
}

function totalScore(candidate: ScoredMemoryCandidate): number {
  return candidate.scores.durability + candidate.scores.futureUtility + candidate.scores.authority + candidate.scores.nonDerivability;
}

function visibleMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.filter((message) => message.role === "user" || message.role === "assistant")
    .map((message): ModelMessage => ({ ...message, content: modelContentText(message.content).trim() }))
    .filter((message) => modelContentText(message.content).length > 0);
}

function boundTaskMessages(messages: readonly ModelMessage[]): readonly ModelMessage[] {
  const text = messages.map((message) => `${message.role.toUpperCase()}: ${modelContentText(message.content)}`).join("\n\n");
  if ([...text].length <= MAX_TASK_PROMPT_CHARS) return messages;
  const chars = [...text];
  const bounded = `${chars.slice(0, 6_000).join("")}\n\n[...middle of long task omitted...]\n\n${chars.slice(-14_000).join("")}`;
  return [{ role: "user", content: bounded }];
}
