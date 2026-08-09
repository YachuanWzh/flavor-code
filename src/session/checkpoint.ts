import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const EXCLUDED = new Set([".git", ".flavor", "node_modules", "dist", "build", "release", ".worktrees"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

export interface CheckpointFile {
  path: string;
  digest: string;
  size: number;
  mode: number;
}

export interface WorkspaceCheckpoint {
  version: 1;
  id: string;
  createdAt: string;
  label?: string;
  files: CheckpointFile[];
}

export interface WorkspaceCheckpointStoreOptions {
  workspace: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export class WorkspaceCheckpointStore {
  readonly #workspace: string;
  readonly #root: string;
  readonly #objects: string;
  readonly #manifests: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;

  constructor(options: WorkspaceCheckpointStoreOptions) {
    this.#workspace = resolve(options.workspace);
    this.#root = join(this.#workspace, ".flavor", "checkpoints");
    this.#objects = join(this.#root, "objects");
    this.#manifests = join(this.#root, "manifests");
    this.#maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.#maxTotalBytes = options.maxTotalBytes ?? MAX_TOTAL_BYTES;
  }

  async create(label?: string): Promise<WorkspaceCheckpoint> {
    const paths = await discoverFiles(this.#workspace);
    const files: CheckpointFile[] = [];
    let total = 0;
    await mkdir(this.#objects, { recursive: true });
    await mkdir(this.#manifests, { recursive: true });
    for (const path of paths) {
      const absolute = contained(this.#workspace, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink()) throw new Error(`Checkpoint refuses symbolic link: ${path}`);
      if (!info.isFile()) continue;
      if (info.size > this.#maxFileBytes) throw new Error(`Checkpoint file exceeds size limit: ${path}`);
      total += info.size;
      if (total > this.#maxTotalBytes) throw new Error("Checkpoint exceeds total size limit");
      const content = await readFile(absolute);
      const digest = createHash("sha256").update(content).digest("hex");
      const objectPath = join(this.#objects, digest);
      try {
        const handle = await open(objectPath, "wx");
        try { await handle.writeFile(content); }
        finally { await handle.close(); }
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw error;
      }
      files.push({ path, digest, size: info.size, mode: info.mode });
    }
    const checkpoint: WorkspaceCheckpoint = {
      version: 1,
      id: `checkpoint-${Date.now()}-${randomUUID().slice(0, 8)}`,
      createdAt: new Date().toISOString(),
      ...(label === undefined || label.trim().length === 0 ? {} : { label: label.trim() }),
      files,
    };
    await atomicJson(join(this.#manifests, `${checkpoint.id}.json`), checkpoint);
    return checkpoint;
  }

  async load(id: string): Promise<WorkspaceCheckpoint> {
    if (!/^checkpoint-[A-Za-z0-9-]+$/.test(id)) throw new Error("Invalid checkpoint id");
    const value = JSON.parse(await readFile(join(this.#manifests, `${id}.json`), "utf8")) as WorkspaceCheckpoint;
    if (value.version !== 1 || value.id !== id || !Array.isArray(value.files)) throw new Error("Invalid checkpoint manifest");
    for (const file of value.files) {
      contained(this.#workspace, file.path);
      if (!/^[a-f0-9]{64}$/.test(file.digest)) throw new Error("Invalid checkpoint digest");
    }
    return value;
  }

  async restore(id: string): Promise<WorkspaceCheckpoint> {
    const checkpoint = await this.load(id);
    const objects = new Map<string, Buffer>();
    for (const file of checkpoint.files) {
      const object = await readFile(join(this.#objects, file.digest));
      if (object.length !== file.size || createHash("sha256").update(object).digest("hex") !== file.digest) {
        throw new Error(`Checkpoint object is corrupt: ${file.digest}`);
      }
      objects.set(file.digest, object);
    }
    const desired = new Set(checkpoint.files.map((file) => normalizeRelative(file.path)));
    const current = await discoverFiles(this.#workspace);
    for (const path of current) {
      if (!desired.has(path)) await rm(contained(this.#workspace, path), { force: true });
    }
    for (const file of checkpoint.files) {
      const target = contained(this.#workspace, file.path);
      const object = objects.get(file.digest)!;
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, object, { mode: file.mode });
      await rename(temporary, target);
    }
    return checkpoint;
  }
}

async function discoverFiles(workspace: string): Promise<string[]> {
  if (await exists(join(workspace, ".git"))) {
    const listed = await gitFiles(workspace);
    return listed.filter((path) => !EXCLUDED.has(path.split("/")[0] ?? "")).sort();
  }
  const result: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      const path = normalizeRelative(relative(workspace, absolute));
      if (entry.isSymbolicLink()) throw new Error(`Checkpoint refuses symbolic link: ${path}`);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) result.push(path);
    }
  };
  await walk(workspace);
  return result.sort();
}

async function gitFiles(workspace: string): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    execFile("git", ["-C", workspace, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "buffer",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
    }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(`Cannot enumerate checkpoint files with git: ${stderr.toString("utf8").trim() || error.message}`));
        return;
      }
      const paths = stdout.toString("utf8").split("\0").filter(Boolean).map(normalizeRelative);
      try {
        for (const path of paths) contained(workspace, path);
        resolvePromise([...new Set(paths)]);
      } catch (cause) {
        reject(cause);
      }
    });
  });
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isCode(error, "ENOENT")) return false; throw error; }
}

function normalizeRelative(path: string): string {
  return path.replaceAll("\\", "/");
}

function contained(workspace: string, path: string): string {
  if (path.length === 0 || path.includes("\0")) throw new Error("Invalid checkpoint path");
  const absolute = resolve(workspace, path);
  const delta = relative(workspace, absolute);
  if (delta === ".." || delta.startsWith(`..${sep}`) || delta === "" || resolve(absolute) !== absolute) {
    throw new Error(`Checkpoint path escapes workspace: ${path}`);
  }
  return absolute;
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
