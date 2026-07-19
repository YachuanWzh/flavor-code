import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;

export interface RecoverableFile<T> {
  value: T;
  source: string;
}

export interface ProtectedFileUpdate<T> {
  path: string;
  decode(raw: string): T | Promise<T>;
  encode(value: T): string | Promise<string>;
  update(current: T | undefined): T | Promise<T>;
  backupEncode?(current: T): string | Promise<string>;
  lockTimeoutMs?: number;
  staleLockMs?: number;
}

export async function readRecoverableFile<T>(
  path: string,
  decode: (raw: string) => T | Promise<T>,
): Promise<RecoverableFile<T> | undefined> {
  let primaryError: unknown;
  try {
    return { value: await decode(await readFile(path, "utf8")), source: path };
  } catch (error) {
    if (isCode(error, "ENOENT")) primaryError = error;
    else primaryError = error;
  }

  const backup = `${path}.bak`;
  try {
    return { value: await decode(await readFile(backup, "utf8")), source: backup };
  } catch (backupError) {
    if (isCode(primaryError, "ENOENT") && isCode(backupError, "ENOENT")) return undefined;
    if (isCode(backupError, "ENOENT")) throw primaryError;
    const reason = backupError instanceof Error ? backupError.message : String(backupError);
    const primary = primaryError instanceof Error ? primaryError.message : String(primaryError);
    throw new Error(`Primary and backup files are invalid for ${path}: ${primary}; backup: ${reason}`);
  }
}

export async function updateProtectedFile<T>(options: ProtectedFileUpdate<T>): Promise<T> {
  await mkdir(dirname(options.path), { recursive: true, mode: 0o700 });
  return withFileLock(options.path, async () => {
    const current = await readRecoverableFile(options.path, options.decode);
    const next = await options.update(current?.value);
    if (current !== undefined) {
      const backup = options.backupEncode === undefined
        ? await options.encode(current.value)
        : await options.backupEncode(current.value);
      await writeAtomic(`${options.path}.bak`, backup);
    }
    await writeAtomic(options.path, await options.encode(next));
    return next;
  }, options.lockTimeoutMs ?? LOCK_TIMEOUT_MS, options.staleLockMs ?? STALE_LOCK_MS);
}

async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  lockTimeoutMs: number,
  staleLockMs: number,
): Promise<T> {
  const lockPath = `${path}.lock`;
  const token = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  const deadline = Date.now() + lockTimeoutMs;
  let handle;
  while (handle === undefined) {
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if (!isCode(error, "EEXIST")) throw error;
      await removeStaleLock(lockPath, staleLockMs);
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for configuration lock ${lockPath}`);
      await delay(LOCK_WAIT_MS);
    }
  }

  await handle.close();
  try {
    return await operation();
  } finally {
    try {
      if ((await readFile(lockPath, "utf8")) === token) await rm(lockPath, { force: true });
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }
}

async function removeStaleLock(path: string, staleLockMs: number): Promise<void> {
  try {
    const token = await readFile(path, "utf8");
    const metadata = await stat(path);
    if (Date.now() - metadata.mtimeMs <= staleLockMs) return;
    const owner = parseLockOwner(token);
    if (owner !== undefined && isProcessAlive(owner)) return;
    if (await readFile(path, "utf8") !== token) return;
    const stale = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, stale);
      await rm(stale, { force: true });
    } catch (error) {
      if (!isCode(error, "ENOENT")) return;
    }
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
}

function parseLockOwner(token: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(token);
    if (typeof parsed !== "object" || parsed === null || !("pid" in parsed)) return undefined;
    const pid = (parsed as { pid?: unknown }).pid;
    return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    const legacy = token.match(/^(\d+):/);
    if (legacy?.[1] === undefined) return undefined;
    const pid = Number(legacy[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isCode(error, "EPERM");
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
