import type { Readable, Writable } from "node:stream";

export type RpcRequest = Record<string, unknown> & { type: string };

export class FlavorRpcClient {
  readonly #input: Readable;
  readonly #output: Writable;
  readonly #pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  readonly #listeners = new Set<(event: unknown) => void>();
  #nextId = 1;
  #buffer = "";
  #closed = false;

  constructor(options: { input: Readable; output: Writable }) {
    this.#input = options.input;
    this.#output = options.output;
    this.#input.setEncoding("utf8");
    this.#input.on("data", this.#onData);
    this.#input.once("end", this.#onClose);
    this.#input.once("close", this.#onClose);
    this.#input.once("error", this.#onError);
  }

  onEvent(listener: (event: unknown) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(command: RpcRequest): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("Flavor RPC transport is closed"));
    const id = `vscode-${this.#nextId++}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#output.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (error === null || error === undefined) return;
        this.#pending.delete(id);
        reject(error);
      });
    });
  }

  async dispose(): Promise<void> {
    if (!this.#closed) {
      await new Promise<void>((resolve) => {
        this.#output.write(`${JSON.stringify({ type: "shutdown" })}\n`, () => resolve());
      });
      this.#close(new Error("Flavor RPC transport is closed"));
    }
    this.#input.off("data", this.#onData);
    this.#input.off("end", this.#onClose);
    this.#input.off("close", this.#onClose);
    this.#input.off("error", this.#onError);
  }

  readonly #onData = (chunk: string | Buffer): void => {
    this.#buffer += chunk.toString();
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#accept(line);
    }
  };

  readonly #onClose = (): void => this.#close(new Error("Flavor RPC transport closed"));
  readonly #onError = (error: Error): void => this.#close(error);

  #accept(line: string): void {
    let value: Record<string, unknown>;
    try { value = JSON.parse(line) as Record<string, unknown>; }
    catch { return; }
    if (value.type === "event") {
      for (const listener of this.#listeners) listener(value.event);
      return;
    }
    if (typeof value.id !== "string") return;
    const pending = this.#pending.get(value.id);
    if (pending === undefined) return;
    this.#pending.delete(value.id);
    if (value.type === "error" || value.success === false) {
      pending.reject(new Error(typeof value.message === "string" ? value.message : "Flavor RPC request failed"));
    } else {
      pending.resolve(value.data);
    }
  }

  #close(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
