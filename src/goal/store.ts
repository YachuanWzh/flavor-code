import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { GoalStateSchema, type GoalState } from "./types.js";

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class GoalStore {
  readonly #workspace: string;
  readonly #root: string;
  readonly #maxBytes: number;

  constructor(options: { workspace: string; maxBytes?: number }) {
    this.#workspace = resolve(options.workspace);
    this.#root = join(this.#workspace, ".flavor", "goals");
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async save(input: GoalState): Promise<void> {
    const state = GoalStateSchema.parse(input);
    await assertNoSymlink(this.#workspace, dirname(this.#root));
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    await assertNoSymlink(this.#workspace, this.#root);
    const target = join(this.#root, `${state.id}.json`);
    const body = `${JSON.stringify(state, null, 2)}\n`;
    if (Buffer.byteLength(body) > this.#maxBytes) {
      throw new Error(`Goal state exceeds maximum size of ${this.#maxBytes} bytes`);
    }
    const temporary = join(this.#root, `.${state.id}.${process.pid}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(body, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

async function assertNoSymlink(root: string, target: string): Promise<void> {
  let cursor = resolve(target);
  const stop = resolve(root);
  const value = relative(stop, cursor);
  if (value === ".." || value.startsWith(`..${sep}`) || value.includes(":")) {
    throw new Error("Goal path escapes workspace");
  }
  const chain: string[] = [];
  while (cursor !== stop) {
    chain.push(cursor);
    cursor = dirname(cursor);
  }
  for (const path of chain.reverse()) {
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`Goal path contains a symbolic link: ${path}`);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
