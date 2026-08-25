import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { git, isGitRepository } from "../git/service.js";

export interface DesktopWorktree {
  id: string;
  mode: "worktree";
  repository: string;
  path: string;
  branch: string;
  createdAt: string;
  dirty: boolean;
  merged: boolean;
}

interface StoredWorktree extends Omit<DesktopWorktree, "dirty" | "merged"> { version: 1 }

export class DesktopWorktreeManager {
  readonly #repository: string;
  readonly #storage: string;

  constructor(options: { repository: string; storage: string }) {
    this.#repository = resolve(options.repository);
    this.#storage = resolve(options.storage);
  }

  async create(label: string): Promise<DesktopWorktree> {
    if (!(await isGitRepository(this.#repository))) throw new Error("Task worktrees require a Git repository");
    const safe = label.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 36) || "task";
    const suffix = randomUUID().slice(0, 8);
    const id = `worktree-${safe}-${suffix}`;
    const branch = `flavor/desktop-${safe}-${suffix}`;
    const path = this.#safeStoragePath(id);
    await mkdir(this.#storage, { recursive: true, mode: 0o700 });
    const result = await git(this.#repository, ["worktree", "add", "-b", branch, path, "HEAD"], 60_000);
    if (!result.ok) throw new Error(`git worktree add failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
    const stored: StoredWorktree = {
      version: 1, id, mode: "worktree", repository: this.#repository, path, branch, createdAt: new Date().toISOString(),
    };
    try { await writeFile(this.#metadataPath(id), `${JSON.stringify(stored)}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch (error) {
      await git(this.#repository, ["worktree", "remove", "--force", path], 60_000).catch(() => undefined);
      throw error;
    }
    return { ...stored, dirty: false, merged: false };
  }

  async list(): Promise<DesktopWorktree[]> {
    let names: string[];
    try { names = await readdir(this.#storage); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const values = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => {
      try {
        const stored = validateStored(JSON.parse(await readFile(join(this.#storage, name), "utf8")), this.#repository, this.#storage);
        if ((await stat(stored.path).catch(() => undefined))?.isDirectory() !== true) return undefined;
        const status = await git(stored.path, ["status", "--porcelain"]);
        const merged = await git(this.#repository, ["merge-base", "--is-ancestor", stored.branch, "HEAD"]);
        const { version: _version, ...item } = stored;
        return { ...item, dirty: status.ok ? status.stdout.trim().length > 0 : true, merged: merged.ok } satisfies DesktopWorktree;
      } catch { return undefined; }
    }));
    return values.filter((item): item is DesktopWorktree => item !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async remove(id: string, force = false): Promise<void> {
    const item = await this.#load(id);
    const status = await git(item.path, ["status", "--porcelain"]);
    const dirty = !status.ok || status.stdout.trim().length > 0;
    if (dirty && !force) throw new Error("Worktree is dirty; review or explicitly force removal");
    const result = await git(this.#repository, ["worktree", "remove", ...(force ? ["--force"] : []), item.path], 60_000);
    if (!result.ok) throw new Error(`git worktree remove failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
    await rm(this.#metadataPath(id), { force: true });
  }

  async merge(id: string): Promise<void> {
    const item = await this.#load(id);
    const [taskStatus, repositoryStatus] = await Promise.all([
      git(item.path, ["status", "--porcelain"]), git(this.#repository, ["status", "--porcelain"]),
    ]);
    if (!taskStatus.ok || taskStatus.stdout.trim().length > 0) throw new Error("Commit or discard task worktree changes before handoff");
    if (!repositoryStatus.ok || repositoryStatus.stdout.trim().length > 0) throw new Error("The destination checkout must be clean before handoff");
    const result = await git(this.#repository, ["merge", "--no-ff", "--no-edit", item.branch], 60_000);
    if (!result.ok) throw new Error(`Worktree handoff merge failed: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
  }

  async #load(id: string): Promise<StoredWorktree> {
    const path = this.#metadataPath(id);
    return validateStored(JSON.parse(await readFile(path, "utf8")), this.#repository, this.#storage);
  }

  #metadataPath(id: string): string {
    if (!/^worktree-[a-z0-9._-]{1,80}$/.test(id)) throw new Error("Invalid worktree id");
    return this.#safeStoragePath(`${id}.json`);
  }

  #safeStoragePath(name: string): string {
    const target = resolve(this.#storage, name);
    const delta = relative(this.#storage, target);
    if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Worktree path escapes storage");
    return target;
  }
}

function validateStored(value: unknown, repository: string, storage: string): StoredWorktree {
  if (typeof value !== "object" || value === null) throw new Error("Invalid worktree metadata");
  const item = value as Partial<StoredWorktree>;
  if (item.version !== 1 || item.mode !== "worktree" || typeof item.id !== "string" || typeof item.path !== "string"
    || typeof item.branch !== "string" || typeof item.createdAt !== "string" || resolve(item.repository ?? "") !== repository) {
    throw new Error("Invalid worktree metadata");
  }
  const path = resolve(item.path);
  const delta = relative(storage, path);
  if (delta === "" || delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta) || basename(path) !== item.id) {
    throw new Error("Worktree metadata escapes storage");
  }
  return { version: 1, id: item.id, mode: "worktree", repository, path, branch: item.branch, createdAt: item.createdAt };
}
