import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";

interface LockMetadata { pid: number; createdAt: number; nonce: string }

export interface AcquirePalFileLockOptions {
  path: string;
  endpointLive: () => Promise<boolean>;
  processAlive?: (pid: number) => boolean;
  pid?: number;
  now?: () => number;
  corruptGraceMs?: number;
}

export interface PalFileLock { path: string; release(): Promise<void> }

function defaultProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function parseMetadata(value: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockMetadata>;
    if (!Number.isSafeInteger(parsed.pid) || parsed.pid! <= 0 || !Number.isFinite(parsed.createdAt)
      || typeof parsed.nonce !== "string" || parsed.nonce.length < 1 || parsed.nonce.length > 128) return undefined;
    return { pid: parsed.pid!, createdAt: parsed.createdAt!, nonce: parsed.nonce };
  } catch { return undefined; }
}

export async function acquirePalFileLock(options: AcquirePalFileLockOptions): Promise<PalFileLock | undefined> {
  if (await options.endpointLive()) return undefined;
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const nonce = randomUUID();
  const metadata: LockMetadata = { pid, createdAt: now(), nonce };
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(options.path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const [contents, info] = await Promise.all([readFile(options.path, "utf8").catch(() => ""), stat(options.path).catch(() => undefined)]);
    if (await options.endpointLive()) return undefined;
    const existing = parseMetadata(contents);
    if (existing !== undefined && (options.processAlive ?? defaultProcessAlive)(existing.pid)) return undefined;
    if (existing === undefined && (info === undefined || now() - info.mtimeMs <= (options.corruptGraceMs ?? 5_000))) return undefined;
    const tombstone = `${options.path}.reclaim-${pid}-${nonce}`;
    try { await rename(options.path, tombstone); }
    catch (renameError) {
      if (["ENOENT", "EEXIST"].includes((renameError as NodeJS.ErrnoException).code ?? "")) return undefined;
      throw renameError;
    }
    try { handle = await open(options.path, "wx", 0o600); }
    catch (openError) {
      if ((openError as NodeJS.ErrnoException).code !== "EEXIST") throw openError;
      return undefined;
    } finally {
      await unlink(tombstone).catch((unlinkError: NodeJS.ErrnoException) => { if (unlinkError.code !== "ENOENT") throw unlinkError; });
    }
  }
  try { await handle.writeFile(JSON.stringify(metadata), "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  const release = async (): Promise<void> => {
    const current = parseMetadata(await readFile(options.path, "utf8").catch(() => ""));
    if (current?.nonce !== nonce) return;
    await unlink(options.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  };
  if (await options.endpointLive()) { await release(); return undefined; }
  return { path: options.path, release };
}
