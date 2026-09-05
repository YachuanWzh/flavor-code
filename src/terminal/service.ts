import { randomUUID } from "node:crypto";
import { createRequire as nodeCreateRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { IPty } from "node-pty";

import type { JobRegistry } from "../jobs/registry.js";
import type { JobHandle } from "../jobs/registry.js";

export interface TerminalSnapshot {
  id: string;
  owner: string;
  shell: string;
  cwd: string;
  state: "running" | "exited" | "closed";
  createdAt: string;
  exitCode?: number;
  jobId?: string;
}
export interface TerminalReadResult extends TerminalSnapshot { output: string; cursor: number; truncated: boolean }
export interface PtyLike {
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void };
}
export type PtyFactory = (shell: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }) => PtyLike;

interface TerminalRecord extends TerminalSnapshot {
  pty: PtyLike;
  output: string;
  outputStart: number;
  outputChars: number;
  truncated: boolean;
  disposables: Array<{ dispose(): void }>;
  job?: JobHandle;
}

export class TerminalService {
  readonly #root: string;
  readonly #factory: PtyFactory;
  readonly #jobs: JobRegistry | undefined;
  readonly #maxOutputChars: number;
  readonly #sessions = new Map<string, TerminalRecord>();

  constructor(workspace: string, options: { factory?: PtyFactory; jobs?: JobRegistry; maxOutputChars?: number } = {}) {
    this.#root = resolve(workspace);
    this.#factory = options.factory ?? defaultFactory;
    this.#jobs = options.jobs;
    this.#maxOutputChars = options.maxOutputChars ?? 200_000;
    if (!Number.isSafeInteger(this.#maxOutputChars) || this.#maxOutputChars <= 0) throw new Error("maxOutputChars must be a positive integer");
  }

  open(input: { owner: string; cwd?: string; shell?: string; args?: string[]; columns?: number; rows?: number }): TerminalSnapshot {
    const cwd = workspacePath(this.#root, input.cwd ?? ".");
    const shell = input.shell ?? defaultShell();
    const id = `term-${randomUUID().slice(0, 12)}`;
    const pty = this.#factory(shell, input.args ?? [], {
      cwd, cols: input.columns ?? 100, rows: input.rows ?? 30,
      env: cleanEnvironment(process.env),
    });
    let jobId: string | undefined;
    const record: TerminalRecord = {
      id, owner: input.owner, shell, cwd, state: "running", createdAt: new Date().toISOString(),
      pty, output: "", outputStart: 0, outputChars: 0, truncated: false, disposables: [],
    };
    let job: JobHandle | undefined;
    try { job = this.#jobs?.create({ kind: "terminal", owner: input.owner, label: shell, cancel: () => this.close(id, input.owner) }); }
    catch (error) { pty.kill(); throw error; }
    if (job !== undefined) { jobId = job.id; record.jobId = job.id; record.job = job; }
    record.disposables.push(pty.onData((data) => {
      record.output += data;
      record.outputChars += data.length;
      if (record.output.length > this.#maxOutputChars) {
        const removed = record.output.length - this.#maxOutputChars;
        record.output = record.output.slice(removed);
        record.outputStart += removed;
        record.truncated = true;
      }
      job?.append(data);
    }));
    record.disposables.push(pty.onExit(({ exitCode }) => {
      if (record.state === "running") record.state = "exited";
      record.exitCode = exitCode;
      job?.complete({ exitCode });
    }));
    this.#sessions.set(id, record);
    return { ...snapshot(record), ...(jobId === undefined ? {} : { jobId }) };
  }

  write(id: string, owner: string, data: string): void { this.#running(id, owner).pty.write(data); }
  resize(id: string, owner: string, columns: number, rows: number): void { this.#running(id, owner).pty.resize(columns, rows); }

  read(id: string, owner: string, cursor = 0): TerminalReadResult {
    const record = this.#owned(id, owner);
    const effective = Math.max(cursor, record.outputStart);
    return { ...snapshot(record), output: record.output.slice(effective - record.outputStart), cursor: record.outputStart + record.output.length, truncated: record.truncated };
  }

  list(owner: string): readonly TerminalSnapshot[] { return [...this.#sessions.values()].filter((item) => item.owner === owner).map(snapshot); }

  close(id: string, owner: string): void {
    const record = this.#owned(id, owner);
    if (record.state === "running") record.pty.kill();
    record.state = "closed";
    record.job?.cancel();
    for (const disposable of record.disposables) disposable.dispose();
  }

  dispose(): void {
    for (const record of this.#sessions.values()) {
      if (record.state === "running") record.pty.kill();
      for (const disposable of record.disposables) disposable.dispose();
      record.state = "closed";
      record.job?.cancel();
    }
  }

  #owned(id: string, owner: string): TerminalRecord {
    const record = this.#sessions.get(id);
    if (record === undefined) throw new Error(`Unknown terminal: ${id}`);
    if (record.owner !== owner) throw new Error("Terminal owner mismatch");
    return record;
  }

  #running(id: string, owner: string): TerminalRecord {
    const record = this.#owned(id, owner);
    if (record.state !== "running") throw new Error(`Terminal ${id} is ${record.state}; use TerminalOpen to start a new session`);
    return record;
  }
}

function snapshot(record: TerminalRecord): TerminalSnapshot {
  return {
    id: record.id, owner: record.owner, shell: record.shell, cwd: record.cwd, state: record.state, createdAt: record.createdAt,
    ...(record.exitCode === undefined ? {} : { exitCode: record.exitCode }),
    ...(record.jobId === undefined ? {} : { jobId: record.jobId }),
  };
}

function defaultFactory(shell: string, args: string[], options: { cwd: string; cols: number; rows: number; env: Record<string, string> }): IPty {
  try {
    const pty = nodeCreateRequire(import.meta.url)("node-pty") as typeof import("node-pty");
    return pty.spawn(shell, args, { ...options, name: "xterm-256color" });
  } catch (error) {
    throw new Error(`Pseudo-terminal backend is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function defaultShell(): string { return process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : (process.env.SHELL ?? "/bin/sh"); }

function cleanEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

function workspacePath(root: string, input: string): string {
  const path = resolve(root, input);
  const delta = relative(root, path);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Terminal cwd is outside the workspace");
  return path;
}
