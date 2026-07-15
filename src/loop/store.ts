import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { LoopEventSchema, LoopStateSchema, type LoopEvent, type LoopState } from "./types.js";
import { message } from "../utils/error.js";

const LOOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface LoopStoreOptions { workspace: string; maxBytes?: number }

export class LoopStore {
  readonly #workspace: string;
  readonly #root: string;
  readonly #maxBytes: number;
  readonly #appendTails = new Map<string, Promise<void>>();

  constructor(options: LoopStoreOptions) {
    this.#workspace = resolve(options.workspace);
    this.#root = join(this.#workspace, ".flavor", "loops");
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async create(state: LoopState): Promise<void> {
    await this.save(state);
    await this.append({
      version: 1, type: "created", timestamp: state.createdAt, loopId: state.loopId,
      payload: { goal: state.goal },
    });
  }

  async save(input: LoopState): Promise<void> {
    const state = LoopStateSchema.parse(input);
    await this.#assertWorkspace(state.workspace);
    const directory = await this.#prepare(state.loopId);
    const target = join(directory, "state.json");
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body) > this.#maxBytes) throw new Error(`Loop state exceeds maximum size of ${this.#maxBytes} bytes`);
    const temporary = join(directory, `.state.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close(); handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async load(loopId: string): Promise<LoopState> {
    const directory = await this.#safeExisting(loopId);
    const target = join(directory, "state.json");
    try {
      const metadata = await stat(target);
      if (!metadata.isFile() || metadata.size > this.#maxBytes) throw new Error("Loop state is not a bounded regular file");
      const raw = await readFile(target, "utf8");
      const state = LoopStateSchema.parse(JSON.parse(raw));
      await this.#assertWorkspace(state.workspace);
      return state;
    } catch (error) {
      if (isCode(error, "ENOENT")) throw new Error(`Loop "${loopId}" was not found`);
      const quarantine = `${target}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`;
      await rename(target, quarantine).catch(() => undefined);
      throw new Error(`Loop "${loopId}" is corrupt and was quarantined: ${message(error)}`);
    }
  }

  append(input: LoopEvent): Promise<void> {
    const event = LoopEventSchema.parse(input);
    const previous = this.#appendTails.get(event.loopId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const directory = await this.#prepare(event.loopId);
      const path = join(directory, "events.jsonl");
      const handle = await open(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY, 0o600);
      try { await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8"); }
      finally { await handle.close(); }
    });
    this.#appendTails.set(event.loopId, next);
    return next;
  }

  async #prepare(loopId: string): Promise<string> {
    validateId(loopId);
    await assertNoSymlink(this.#workspace, dirname(this.#root));
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertNoSymlink(this.#workspace, this.#root);
    const directory = join(this.#root, loopId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoSymlink(this.#workspace, directory);
    return directory;
  }

  async #safeExisting(loopId: string): Promise<string> {
    validateId(loopId);
    await assertNoSymlink(this.#workspace, this.#root);
    const directory = join(this.#root, loopId);
    await assertNoSymlink(this.#workspace, directory);
    return directory;
  }

  async #assertWorkspace(stored: string): Promise<void> {
    const expected = await canonical(this.#workspace);
    const actual = await canonical(stored);
    if (process.platform === "win32" ? expected.toLowerCase() !== actual.toLowerCase() : expected !== actual) {
      throw new Error(`Loop belongs to a different workspace: ${stored}`);
    }
  }
}

function validateId(loopId: string): void {
  if (!LOOP_ID.test(loopId)) throw new Error("Invalid loop id");
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  let cursor = resolve(target);
  const stop = resolve(root);
  if (!isWithin(stop, cursor)) throw new Error("Loop path escapes workspace");
  const chain: string[] = [];
  while (cursor !== stop) { chain.push(cursor); cursor = dirname(cursor); }
  for (const path of chain.reverse()) {
    try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`Loop path contains a symbolic link: ${path}`); }
    catch (error) { if (!isCode(error, "ENOENT")) throw error; }
  }
}

function isWithin(root: string, path: string): boolean {
  const value = relative(resolve(root), resolve(path));
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !value.includes(":"));
}

async function canonical(path: string): Promise<string> {
  try { return await realpath(resolve(path)); } catch { return resolve(path); }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
