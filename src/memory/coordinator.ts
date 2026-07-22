import type { ModelMessage } from "../models/types.js";
import { buildMemoryExtractionPrompt, parseMemoryCandidates } from "./extractor.js";
import type { MemoryStore } from "./store.js";

export interface MemoryCoordinatorOptions {
  store: MemoryStore;
  generate(prompt: string, signal: AbortSignal): Promise<string>;
  minChars: number;
  maxEntryChars: number;
}

export class MemoryCoordinator {
  onError: ((error: unknown) => void) | undefined;
  readonly #options: MemoryCoordinatorOptions;
  readonly #controller = new AbortController();
  #tail: Promise<void> = Promise.resolve();

  constructor(options: MemoryCoordinatorOptions) {
    if (!Number.isSafeInteger(options.minChars) || options.minChars < 0) throw new Error("minChars must be a non-negative integer");
    this.#options = options;
  }

  enqueue(messages: readonly ModelMessage[]): boolean {
    const visibleChars = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .reduce((total, message) => total + message.content.trim().length, 0);
    if (visibleChars < this.#options.minChars || visibleChars === 0) return false;
    const snapshot = messages.map((message) => ({ ...message }));
    this.#tail = this.#tail.then(async () => {
      this.#controller.signal.throwIfAborted();
      const raw = await this.#options.generate(buildMemoryExtractionPrompt(snapshot), this.#controller.signal);
      const candidates = parseMemoryCandidates(raw, { maxEntryChars: this.#options.maxEntryChars });
      if (candidates.length > 0) await this.#options.store.rememberMany(candidates);
    }).catch((error) => {
      if (!this.#controller.signal.aborted) this.onError?.(error);
    });
    return true;
  }

  async flush(): Promise<void> {
    await this.#tail;
  }

  abort(reason: unknown = new Error("Memory coordinator disposed")): void {
    this.#controller.abort(reason);
  }
}

