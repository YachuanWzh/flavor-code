import { randomUUID } from "node:crypto";
import { waitWithSignal } from "../utils/abort.js";

export type JobState = "running" | "completed" | "failed" | "cancelled";
export type JobKind = "shell" | "terminal" | "d2c-preview" | "e2e-backend" | "process";

export interface JobSnapshot {
  id: string;
  kind: JobKind;
  owner: string;
  label: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  exitCode?: number | null;
  error?: string;
  outputChars: number;
  truncated: boolean;
}

export interface JobReadResult extends JobSnapshot { output: string; cursor: number }
export interface CreateJobInput { kind: JobKind; owner: string; label: string; cancel?: () => void | Promise<void> }

interface JobRecord extends JobSnapshot {
  /**
   * The retained output window, kept as chunks: appending to one growing
   * string re-copied the whole window on every write, a quadratic churn that
   * showed up as heap pressure on churning background jobs.
   */
  chunks: string[];
  windowChars: number;
  outputStart: number;
  cancel?: () => void | Promise<void>;
  settle: (snapshot: JobSnapshot) => void;
  done: Promise<JobSnapshot>;
}

/** Re-slice the window only after this much new output accumulates. */
const OUTPUT_SLICE_SLACK_CHARS = 64 * 1024;

export interface JobHandle {
  readonly id: string;
  append(text: string): void;
  complete(result?: { exitCode?: number | null; error?: string }): void;
  fail(error: unknown): void;
  cancel(): void;
}

export class JobRegistry {
  readonly #jobs = new Map<string, JobRecord>();
  readonly #maxOutputChars: number;
  readonly #maxJobs: number;
  readonly #listeners = new Set<(jobs: readonly JobSnapshot[]) => void>();

  constructor(options: { maxOutputChars?: number; maxJobs?: number } = {}) {
    this.#maxOutputChars = options.maxOutputChars ?? 200_000;
    this.#maxJobs = options.maxJobs ?? 100;
    if (!Number.isSafeInteger(this.#maxOutputChars) || this.#maxOutputChars <= 0) throw new Error("maxOutputChars must be positive");
    if (!Number.isSafeInteger(this.#maxJobs) || this.#maxJobs <= 0) throw new Error("maxJobs must be positive");
  }

  create(input: CreateJobInput): JobHandle {
    this.#pruneCompleted();
    if (this.#jobs.size >= this.#maxJobs) throw new Error(`Background job limit (${this.#maxJobs}) reached; wait for or cancel an existing job first`);
    const id = `job-${randomUUID().slice(0, 12)}`;
    const now = new Date().toISOString();
    let settle!: (snapshot: JobSnapshot) => void;
    const done = new Promise<JobSnapshot>((resolve) => { settle = resolve; });
    const record: JobRecord = {
      id, ...input, state: "running", createdAt: now, updatedAt: now,
      outputChars: 0, truncated: false, chunks: [], windowChars: 0, outputStart: 0, settle, done,
    };
    this.#jobs.set(id, record);
    this.#publish();
    return {
      id,
      append: (text) => {
        if (record.state !== "running" || text === "") return;
        record.chunks.push(text);
        record.windowChars += text.length;
        record.outputChars += text.length;
        // Logical truncation is decided by everything ever produced, so the
        // flag stays correct even while the physical window still holds slack.
        if (record.outputChars > this.#maxOutputChars) record.truncated = true;
        if (record.windowChars > this.#maxOutputChars + OUTPUT_SLICE_SLACK_CHARS) {
          const joined = record.chunks.join("");
          const kept = joined.slice(joined.length - this.#maxOutputChars);
          const removed = joined.length - kept.length;
          record.chunks = [kept];
          record.windowChars = kept.length;
          record.outputStart += removed;
          record.truncated = true;
        }
        record.updatedAt = new Date().toISOString();
        this.#publish();
      },
      complete: (result = {}) => this.#finish(
        record,
        result.error !== undefined || (result.exitCode !== undefined && result.exitCode !== null && result.exitCode !== 0) ? "failed" : "completed",
        result,
      ),
      fail: (error) => this.#finish(record, "failed", { error: error instanceof Error ? error.message : String(error) }),
      cancel: () => this.#finish(record, "cancelled", {}),
    };
  }

  list(owner?: string): readonly JobSnapshot[] {
    return [...this.#jobs.values()]
      .filter((job) => owner === undefined || job.owner === owner)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(snapshot);
  }

  read(id: string, owner: string, cursor = 0): JobReadResult {
    const job = this.#owned(id, owner);
    const window = job.chunks.join("");
    // The physical window transiently retains up to maxOutputChars + slack to
    // keep appends amortized; expose only the bounded tail so even a
    // from-scratch read never returns more than maxOutputChars.
    const dropped = Math.max(0, window.length - this.#maxOutputChars);
    const effective = Math.max(cursor, job.outputStart + dropped);
    return { ...snapshot(job), output: window.slice(effective - job.outputStart), cursor: job.outputStart + window.length };
  }

  /** Retained sizes for the rotation census. */
  census(): { jobs: number; running: number; windowChars: number } {
    let windowChars = 0;
    let running = 0;
    for (const job of this.#jobs.values()) {
      windowChars += job.windowChars;
      if (job.state === "running") running += 1;
    }
    return { jobs: this.#jobs.size, running, windowChars };
  }

  async wait(id: string, owner: string, signal?: AbortSignal): Promise<JobSnapshot> {
    signal?.throwIfAborted();
    const job = this.#owned(id, owner);
    if (job.state !== "running") return snapshot(job);
    return waitWithSignal(job.done, signal);
  }

  kill(id: string, owner: string): void | Promise<void> {
    const job = this.#owned(id, owner);
    if (job.state !== "running") return;
    try {
      const cancellation = job.cancel?.();
      if (cancellation !== undefined) return cancellation.then(
        () => this.#finish(job, "cancelled", {}),
        (error: unknown) => this.#finish(job, "failed", { error: `Cancellation failed: ${error instanceof Error ? error.message : String(error)}` }),
      );
    } catch (error) {
      this.#finish(job, "failed", { error: `Cancellation failed: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    this.#finish(job, "cancelled", {});
  }

  subscribe(listener: (jobs: readonly JobSnapshot[]) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    const running = [...this.#jobs.values()].filter((job) => job.state === "running");
    await Promise.allSettled(running.map(async (job) => job.cancel?.()));
    for (const job of running) this.#finish(job, "cancelled", {});
  }

  #owned(id: string, owner: string): JobRecord {
    const job = this.#jobs.get(id);
    if (job === undefined) throw new Error(`Unknown job: ${id}`);
    if (job.owner !== owner) throw new Error("Job owner mismatch");
    return job;
  }

  #finish(record: JobRecord, state: Exclude<JobState, "running">, detail: { exitCode?: number | null; error?: string }): void {
    if (record.state !== "running") return;
    record.state = state;
    record.updatedAt = new Date().toISOString();
    if (detail.exitCode !== undefined) record.exitCode = detail.exitCode;
    if (detail.error !== undefined) record.error = detail.error;
    const value = snapshot(record);
    record.settle(value);
    this.#publish();
  }

  #publish(): void {
    const value = this.list();
    for (const listener of this.#listeners) listener(value);
  }

  #pruneCompleted(): void {
    if (this.#jobs.size < this.#maxJobs) return;
    const removable = [...this.#jobs.values()]
      .filter((job) => job.state !== "running")
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const job of removable) {
      if (this.#jobs.size < this.#maxJobs) break;
      this.#jobs.delete(job.id);
    }
  }
}

function snapshot(job: JobRecord): JobSnapshot {
  return {
    id: job.id, kind: job.kind, owner: job.owner, label: job.label, state: job.state,
    createdAt: job.createdAt, updatedAt: job.updatedAt, outputChars: job.outputChars, truncated: job.truncated,
    ...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
    ...(job.error === undefined ? {} : { error: job.error }),
  };
}
