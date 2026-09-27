import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { z } from "zod";

import { readRecoverableFile, updateProtectedFile } from "../config/protected-file.js";
import { fixPluginDir } from "./loader.js";

const Name = z.string().regex(/^fix-[a-z0-9]+(?:-[a-z0-9]+)*$/);
const Entry = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  verifiedAt: z.string(),
  testedAt: z.string().optional(),
  testCommand: z.string().optional(),
  activeDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  goodSnapshot: z.string().optional(),
}).strict();
const Ledger = z.record(Name, Entry);
type Ledger = z.infer<typeof Ledger>;

export function assertFixPluginName(name: string): void { Name.parse(name); }

/** Hash the exact bytes that will be loaded; symlinks cannot escape the plugin root. */
export async function hashFixPlugin(workspace: string, name: string): Promise<string> {
  assertFixPluginName(name);
  return hashDirectory(fixPluginDir(workspace, name));
}

/** A rollback snapshot must still match the version that was approved. */
export async function hashFixPluginSnapshot(workspace: string, name: string, snapshot: string): Promise<string> {
  assertFixPluginName(name);
  const versions = resolve(workspace, ".flavor", "plugins", ".versions", name);
  const target = resolve(snapshot);
  if (!target.startsWith(`${versions}${sep}`)) throw new Error("Snapshot escapes fix plugin versions");
  return hashDirectory(target);
}

async function hashDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  let files = 0;
  async function visit(dir: string): Promise<void> {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) throw new Error("Fix plugins cannot contain symlinks or special files");
      if (entry.isDirectory()) { await visit(path); continue; }
      if (++files > 100) throw new Error("Fix plugin contains too many files");
      const bytes = await readFile(path);
      if (bytes.length > 1_000_000) throw new Error("Fix plugin file exceeds 1 MB");
      hash.update(relative(root, path).replaceAll("\\", "/"));
      hash.update("\0");
      hash.update(bytes);
      hash.update("\0");
    }
  }
  await visit(root);
  return hash.digest("hex");
}

export class EvolveVerificationStore {
  readonly path: string;
  constructor(workspace: string) { this.path = join(workspace, ".flavor", "evolve", "plugin-verifications.json"); }

  async list(): Promise<Ledger> { return (await readRecoverableFile(this.path, (raw) => Ledger.parse(JSON.parse(raw))))?.value ?? {}; }

  async markVerified(name: string, digest: string): Promise<void> {
    assertFixPluginName(name);
    await this.#update((records) => {
      const old = records[name];
      return { ...records, [name]: {
        digest, verifiedAt: new Date().toISOString(),
        ...(old?.activeDigest === undefined ? {} : { activeDigest: old.activeDigest }),
        ...(old?.goodSnapshot === undefined ? {} : { goodSnapshot: old.goodSnapshot }),
      } };
    });
  }

  async markTested(name: string, digest: string, command: string): Promise<void> {
    await this.#update((records) => {
      const entry = records[name];
      if (entry?.digest !== digest) return records;
      return { ...records, [name]: { ...entry, testedAt: new Date().toISOString(), testCommand: command } };
    });
  }

  async markActive(name: string, digest: string, snapshot: string): Promise<void> {
    await this.#update((records) => {
      const entry = records[name];
      if (entry?.digest !== digest || entry.testedAt === undefined) return records;
      return { ...records, [name]: { ...entry, activeDigest: digest, goodSnapshot: snapshot } };
    });
  }

  async eligible(name: string, digest: string): Promise<boolean> {
    const entry = (await this.list())[name];
    return entry?.digest === digest && entry.testedAt !== undefined;
  }

  async approvedForStartup(name: string, digest: string): Promise<boolean> {
    const entry = (await this.list())[name];
    return entry?.activeDigest === digest && entry.goodSnapshot !== undefined;
  }

  async goodSnapshot(name: string): Promise<string | undefined> {
    const path = (await this.list())[name]?.goodSnapshot;
    if (path === undefined) return undefined;
    const root = resolve(this.path, "..", "..", "plugins", ".versions", name);
    const target = resolve(path);
    return target.startsWith(`${root}\\`) || target.startsWith(`${root}/`) ? target : undefined;
  }

  async #update(update: (records: Ledger) => Ledger): Promise<void> {
    await updateProtectedFile({
      path: this.path,
      decode: (raw) => Ledger.parse(JSON.parse(raw)),
      encode: (records: Ledger) => JSON.stringify(records, null, 2),
      update: (current) => update(current ?? {}),
    });
  }
}

/** Every unapproved fix plugin is disabled at startup; regular plugins are untouched. */
export async function unverifiedFixPlugins(workspace: string, store = new EvolveVerificationStore(workspace)): Promise<string[]> {
  const root = join(workspace, ".flavor", "plugins");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const disabled: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("fix-")) continue;
    try {
      const digest = await hashFixPlugin(workspace, entry.name);
      if (!await store.approvedForStartup(entry.name, digest)) disabled.push(entry.name);
    } catch { disabled.push(entry.name); }
  }
  return disabled;
}
