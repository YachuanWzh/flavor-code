import { createHash } from "node:crypto";
import type { SlidingWindowConfig } from "./types.js";
import { DEFAULT_SLIDING_WINDOW_SIZE, DEFAULT_SLIDING_WINDOW_THRESHOLD } from "./types.js";

interface WindowEntry {
  hash: string;
  toolName: string;
}

export class SlidingWindow {
  readonly #windowSize: number;
  readonly #threshold: number;
  readonly #entries: WindowEntry[] = [];
  #trippedHash: string | null = null;
  #trippedToolName: string | null = null;

  constructor(config: Partial<SlidingWindowConfig> = {}) {
    this.#windowSize = config.windowSize ?? DEFAULT_SLIDING_WINDOW_SIZE;
    this.#threshold = config.threshold ?? DEFAULT_SLIDING_WINDOW_THRESHOLD;
    if (this.#windowSize <= 0) throw new Error("windowSize must be positive");
    if (this.#threshold <= 0) throw new Error("threshold must be positive");
    if (this.#threshold > this.#windowSize) throw new Error("threshold must not exceed windowSize");
  }

  hash(toolName: string, params: unknown): string {
    const sorted = JSON.stringify(params, sortedKeys(params));
    return createHash("sha256").update(`${toolName}:${sorted}`).digest("hex");
  }

  push(toolName: string, params: unknown): void {
    const hash = this.hash(toolName, params);
    this.#entries.push({ hash, toolName });
    if (this.#entries.length > this.#windowSize) {
      this.#entries.shift();
    }
    this.#checkTrip();
  }

  isTripped(): boolean {
    return this.#trippedHash !== null;
  }

  get trippedHash(): string | null {
    return this.#trippedHash;
  }

  get trippedToolName(): string | null {
    return this.#trippedToolName;
  }

  get count(): number {
    return this.#entries.length;
  }

  getFrequency(hash: string): number {
    let count = 0;
    for (const entry of this.#entries) {
      if (entry.hash === hash) count += 1;
    }
    return count;
  }

  reset(): void {
    this.#entries.length = 0;
    this.#trippedHash = null;
    this.#trippedToolName = null;
  }

  #checkTrip(): void {
    // Re-evaluate: count frequencies and check if any exceeds threshold.
    // If previously tripped but the offending hash is no longer above threshold,
    // clear the trip (e.g., evicted from window).
    const frequencies = new Map<string, { count: number; toolName: string }>();
    for (const entry of this.#entries) {
      const existing = frequencies.get(entry.hash);
      if (existing === undefined) {
        frequencies.set(entry.hash, { count: 1, toolName: entry.toolName });
      } else {
        existing.count += 1;
      }
    }
    // Check currently tripped hash first
    if (this.#trippedHash !== null) {
      const current = frequencies.get(this.#trippedHash);
      if (current === undefined || current.count <= this.#threshold) {
        this.#trippedHash = null;
        this.#trippedToolName = null;
      }
    }
    // Check for new trips
    if (this.#trippedHash === null) {
      for (const [hash, info] of frequencies) {
        if (info.count > this.#threshold) {
          this.#trippedHash = hash;
          this.#trippedToolName = info.toolName;
          return;
        }
      }
    }
  }
}

function sortedKeys(value: unknown): (string | number)[] | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return Object.keys(value as Record<string, unknown>).sort();
  }
  return undefined;
}
