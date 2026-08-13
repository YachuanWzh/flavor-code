import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface ManagedProcessOptions {
  maxOutputChars?: number;
  terminate(child: ChildProcessWithoutNullStreams, force: boolean): Promise<void>;
}

/** Shared child-process lifecycle used by D2C/E2E runners and other managed services. */
export class ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly done: Promise<void>;
  readonly #terminate: ManagedProcessOptions["terminate"];
  readonly #maxOutputChars: number;
  #output = "";
  #exited = false;
  #exitCode: number | null = null;
  #error: Error | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(child: ChildProcessWithoutNullStreams, options: ManagedProcessOptions) {
    this.child = child;
    this.#terminate = options.terminate;
    this.#maxOutputChars = options.maxOutputChars ?? 65_536;
    const append = (chunk: Buffer): void => { this.#output = (this.#output + chunk.toString("utf8")).slice(-this.#maxOutputChars); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    this.done = new Promise((resolvePromise) => {
      child.once("exit", (code) => { this.#exited = true; this.#exitCode = code; resolvePromise(); });
      child.once("error", (error) => { this.#error = error; this.#exited = true; resolvePromise(); });
    });
  }

  output(): string { return this.#output; }
  exited(): boolean { return this.#exited; }
  exitCode(): number | null { return this.#exitCode; }
  error(): Error | undefined { return this.#error; }

  stop(graceMs = 3_000, forceGraceMs = 1_000): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return this.#stopPromise ??= (async () => {
      await this.#terminate(this.child, false);
      if (await waitFor(this.done, graceMs, () => this.#exited)) return;
      await this.#terminate(this.child, true);
      await waitFor(this.done, forceGraceMs, () => this.#exited);
    })();
  }
}

function waitFor(done: Promise<void>, timeoutMs: number, complete: () => boolean): Promise<boolean> {
  if (complete()) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(complete()), timeoutMs);
    timer.unref();
    done.then(() => { clearTimeout(timer); resolvePromise(true); });
  });
}
