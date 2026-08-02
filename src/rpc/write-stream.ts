import { randomUUID } from "node:crypto";

import type { FileWriteProposal } from "../tools/files.js";
import type { SessionOutput } from "../ui/session.js";

interface PendingWrite {
  id: string;
  resolve(): void;
  reject(error: unknown): void;
  removeAbort(): void;
}

export class RpcWriteStreamBridge {
  readonly #output: (event: SessionOutput) => void;
  #pending: PendingWrite | undefined;

  constructor(output: (event: SessionOutput) => void) {
    this.#output = output;
  }

  get pendingId(): string | undefined { return this.#pending?.id; }

  async preview(proposal: FileWriteProposal, signal: AbortSignal): Promise<void> {
    if (this.#pending !== undefined) throw new Error("Another streamed write is still awaiting commit");
    if (signal.aborted) throw signal.reason;
    const id = randomUUID();
    this.#output({
      type: "write-start",
      id,
      path: proposal.path,
      before: proposal.before,
      totalBytes: Buffer.byteLength(proposal.after),
    });
    for (const delta of streamChunks(proposal.after)) this.#output({ type: "write-delta", id, delta });
    this.#output({ type: "write-ready", id });

    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#output({ type: "write-cancelled", id });
        this.#clear(id);
        reject(signal.reason);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.#pending = {
        id,
        resolve,
        reject,
        removeAbort: () => signal.removeEventListener("abort", onAbort),
      };
    });
  }

  commit(id: string): void {
    const pending = this.#pending;
    if (pending === undefined || pending.id !== id) throw new Error("Streamed write is no longer awaiting commit");
    pending.removeAbort();
    this.#pending = undefined;
    pending.resolve();
  }

  dispose(): void {
    const pending = this.#pending;
    if (pending === undefined) return;
    pending.removeAbort();
    this.#pending = undefined;
    pending.reject(new Error("Streamed write bridge disposed"));
  }

  #clear(id: string): void {
    if (this.#pending?.id !== id) return;
    this.#pending.removeAbort();
    this.#pending = undefined;
  }
}

export function streamChunks(content: string, maxChars = 2_048): string[] {
  if (!content) return [];
  const chunks: string[] = [];
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    for (let offset = 0; offset < line.length; offset += maxChars) {
      chunks.push(line.slice(offset, offset + maxChars));
    }
  }
  return chunks;
}
