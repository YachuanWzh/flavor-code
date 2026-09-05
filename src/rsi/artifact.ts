/**
 * RSI immutable artifact manifests — task P0-04a (rsi.md section 6.4, E5).
 *
 * A candidate's identity is the SHA-256 of a *complete* canonical manifest:
 * every file (hash + byte size), the runtime mode, config, state-schema
 * version, and dependency identities. Touching any listed input changes the
 * hash, so a report produced for artifact A can never be re-stamped onto a
 * later edit B. Nothing here imports or activates plugin code — archiving is
 * pure content work.
 *
 * Path policy mirrors E5 step 2: entries are normalized to forward-relative
 * paths, and both the logical path and the physical (realpath-resolved) path
 * must stay inside the artifact root, rejecting `..`, drive-absolute paths,
 * symlinks, and Windows junctions before any bytes are read.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import { hashJson } from "../harness/journal.js";

export const RSI_ARTIFACT_SCHEMA_VERSION = 1 as const;

const FILE_ENTRY_KEYS = ["path", "sha256", "sizeBytes"] as const;

const ArtifactFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative(),
}).strict();
export type ArtifactFileEntry = z.infer<typeof ArtifactFileEntrySchema>;

const ArtifactManifestSchema = z.object({
  schemaVersion: z.literal(RSI_ARTIFACT_SCHEMA_VERSION),
  /** Sorted by normalized path; insertion order can never shift the hash. */
  files: z.array(ArtifactFileEntrySchema).min(1),
  runtimeMode: z.literal("isolated"),
  config: z.record(z.string(), z.unknown()),
  stateSchemaVersion: z.number().int().positive(),
  dependencyIds: z.array(z.string().min(1)),
}).strict();
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

export interface BuildArtifactManifestInput {
  /** Trusted exported artifact root (a clean snapshot, never a live workspace). */
  root: string;
  /** Explicit artifact member list; unlisted files are NOT covered by the hash. */
  entries: readonly string[];
  runtimeMode: "isolated";
  config: Record<string, unknown>;
  stateSchemaVersion: number;
  dependencyIds: readonly string[];
}

/**
 * Normalize a declared entry to a forward-slash relative path, refusing
 * traversal, absolute, drive, and reserved forms before touching the disk.
 */
export function normalizeArtifactEntryPath(entry: string): string {
  const forward = entry.replaceAll("\\", "/");
  if (forward.length === 0) throw new Error(`Artifact entry path is empty: ${JSON.stringify(entry)}`);
  if (/^[A-Za-z]:/.test(forward) || forward.startsWith("/")) {
    throw new Error(`Artifact entry path must be relative, got absolute or drive-qualified: ${entry}`);
  }
  const segments = forward.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Artifact entry path escapes the artifact root via '..': ${entry}`);
  }
  if (segments.some((segment) => /[\u0000-\u001f<>|:"?*]/.test(segment) || segment.endsWith(" ") || segment.endsWith("."))) {
    throw new Error(`Artifact entry path contains characters that are unsafe on Windows: ${entry}`);
  }
  return segments.join("/");
}

function assertUniqueNormalizedPaths(entries: readonly string[]): string[] {
  const normalized = entries.map(normalizeArtifactEntryPath);
  const seenExact = new Set<string>();
  const seenCase = new Set<string>();
  for (const path of normalized) {
    if (seenExact.has(path)) throw new Error(`Duplicate artifact entry: ${path}`);
    seenExact.add(path);
    const lowered = path.toLowerCase();
    if (seenCase.has(lowered)) {
      throw new Error(`Artifact entries collide under Windows case-insensitive lookup: ${path}`);
    }
    seenCase.add(lowered);
  }
  return normalized;
}

/**
 * Verify one declared entry resolves to a regular non-link file inside the
 * canonical root, and read+hash its bytes.
 */
async function hashArtifactFile(rootReal: string, normalized: string): Promise<ArtifactFileEntry> {
  const logical = resolve(rootReal, ...normalized.split("/"));
  if (!isWithin(rootReal, logical)) {
    throw new Error(`Artifact entry resolves outside the root: ${normalized}`);
  }
  // lstat must not follow links; every parent segment must also be link-free,
  // because a symlinked directory smuggles later segments out of the root.
  let walked = rootReal;
  for (const segment of normalized.split("/")) {
    walked = join(walked, segment);
    const info = await lstat(walked).catch((error: unknown) => {
      throw new Error(`Artifact entry cannot be stat'ed (${normalized}): ${error instanceof Error ? error.message : String(error)}`);
    });
    if (info.isSymbolicLink()) throw new Error(`Artifact entry is a symbolic link: ${normalized}`);
    const physical = await realpath(walked);
    if (!isWithin(rootReal, physical)) {
      throw new Error(`Artifact entry resolves outside the root through a reparse point (junction?): ${normalized}`);
    }
    if (segment === normalized.split("/").at(-1)) {
      if (!info.isFile()) throw new Error(`Artifact entry is not a regular file: ${normalized}`);
    } else if (!info.isDirectory()) {
      throw new Error(`Artifact parent is not a directory: ${normalized}`);
    }
  }
  const bytes = await readFile(logical);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { path: normalized, sha256, sizeBytes: bytes.length };
}

/**
 * Build the canonical manifest for an exported artifact tree (E5 steps 1-5).
 * The returned object is frozen-normalized: entries sorted by path, fields
 * validated; its {@link artifactManifestHash} is the candidate identity.
 */
export async function buildArtifactManifest(input: BuildArtifactManifestInput): Promise<ArtifactManifest> {
  const rootReal = await realpath(resolve(input.root));
  const normalized = assertUniqueNormalizedPaths(input.entries);
  const files: ArtifactFileEntry[] = [];
  for (const path of normalized) {
    files.push(await hashArtifactFile(rootReal, path));
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const dependencyIds = [...input.dependencyIds].sort();
  return ArtifactManifestSchema.parse({
    schemaVersion: RSI_ARTIFACT_SCHEMA_VERSION,
    files,
    runtimeMode: input.runtimeMode,
    config: input.config,
    stateSchemaVersion: input.stateSchemaVersion,
    dependencyIds,
  });
}

/** Canonical (key-order-stable) serialization used for cross-implementation hashing. */
export function canonicalArtifactManifestJson(manifest: ArtifactManifest): string {
  const parsed = ArtifactManifestSchema.parse(manifest);
  const orderedFiles = parsed.files.map((file) => Object.fromEntries(
    FILE_ENTRY_KEYS.map((key) => [key, file[key]]),
  ));
  return JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    files: orderedFiles,
    runtimeMode: parsed.runtimeMode,
    config: parsed.config,
    stateSchemaVersion: parsed.stateSchemaVersion,
    dependencyIds: parsed.dependencyIds,
  });
}

/** The artifact identity: SHA-256 over the canonical manifest encoding. */
export function artifactManifestHash(manifest: ArtifactManifest): string {
  return hashJson(ArtifactManifestSchema.parse(manifest));
}

export interface FreezeArtifactResult {
  artifactHash: string;
  directory: string;
  manifest: ArtifactManifest;
}

/**
 * E5 steps 6-7: copy the listed content into an immutable
 * `<store>/artifacts/<hash>/` layout, then re-verify the *stored* bytes
 * against the manifest before reporting `frozen`. A half-written freeze never
 * becomes observable: files land in a temp directory that is renamed only
 * after content verification, and re-freezing an existing hash is a no-op
 * after verification (immutable content-addressed storage).
 */
export async function freezeArtifact(input: {
  /** Protected control store root (candidate mounts must not see this). */
  store: string;
  /** Source root the manifest was built from. */
  root: string;
  manifest: ArtifactManifest;
}): Promise<FreezeArtifactResult> {
  const artifactHash = artifactManifestHash(input.manifest);
  const target = join(await realpath(resolve(input.store)), "artifacts", artifactHash);
  await mkdir(join(target, "files"), { recursive: true, mode: 0o700 });
  await writeFile(join(target, "manifest.json"), `${canonicalArtifactManifestJson(input.manifest)}\n`, { encoding: "utf8", flag: "wx" }).catch((error: unknown) => {
    if (!isCode(error, "EEXIST")) throw error;
  });
  const rootReal = await realpath(resolve(input.root));
  for (const file of input.manifest.files) {
    const stored = join(target, "files", ...file.path.split("/"));
    try {
      await stat(stored);
      continue; // already frozen content is never overwritten
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    const source = await hashArtifactFile(rootReal, file.path);
    if (source.sha256 !== file.sha256 || source.sizeBytes !== file.sizeBytes) {
      throw new Error(`Artifact source changed while freezing ${file.path}; build a new candidate instead`);
    }
    await mkdir(dirname(stored), { recursive: true, mode: 0o700 });
    const bytes = await readFile(join(rootReal, ...file.path.split("/")));
    const temporary = await mkdtemp(join(target, ".tmp-"));
    const staged = join(temporary, "part");
    await writeFile(staged, bytes);
    await rename(staged, stored);
    await rm(temporary, { force: true, recursive: true });
  }
  await verifyArtifact({ store: input.store, artifactHash });
  return { artifactHash, directory: target, manifest: input.manifest };
}

/** Re-hash stored bytes against the stored manifest; any drift rejects. */
export async function verifyArtifact(input: { store: string; artifactHash: string }): Promise<ArtifactManifest> {
  if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) throw new Error("artifactHash must be a lowercase SHA-256 hex digest");
  const root = resolve(input.store);
  const directory = join(root, "artifacts", input.artifactHash);
  // Defense in depth: the caller-provided hash is regex-bounded, so this
  // cannot escape, but keep the containment assertion anyway.
  if (!isWithin(await realpath(root), directory)) throw new Error("Artifact directory escapes the store");
  const manifest = ArtifactManifestSchema.parse(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown);
  const hash = artifactManifestHash(manifest);
  if (hash !== input.artifactHash) {
    throw new Error(`Artifact manifest does not hash to its content-address (${hash} != ${input.artifactHash})`);
  }
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, "files", ...file.path.split("/"))).catch(() => {
      throw new Error(`Artifact file is missing from the frozen store: ${file.path}`);
    });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (sha256 !== file.sha256 || bytes.length !== file.sizeBytes) {
      throw new Error(`Frozen artifact was tampered after sealing: ${file.path}`);
    }
  }
  return manifest;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
