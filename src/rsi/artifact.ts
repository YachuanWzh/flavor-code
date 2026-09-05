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
 * symlinks, and Windows junctions before any bytes are read. `verifyArtifact`
 * re-applies the same physical-chain check to the *stored* tree (a frozen
 * subtree swapped for a junction after sealing is rejected even when the
 * bytes hash identically) and requires the stored file set to match the
 * manifest exactly. Hashing is defined as SHA-256 over the single canonical
 * encoding produced by {@link canonicalArtifactManifestJson}, so any
 * implementation that can reproduce those bytes reproduces the identity.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

export const RSI_ARTIFACT_SCHEMA_VERSION = 1 as const;

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
 * Assert that every path segment under `rootReal` forms a link-free chain of
 * real directories (a symlinked or junctioned parent smuggles later segments
 * out of the tree), ending in the expected file kind.
 */
async function checkPhysicalChain(rootReal: string, segments: readonly string[], final: "file" | "directory"): Promise<void> {
  let walked = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const isLast = index === segments.length - 1;
    walked = join(walked, segment);
    const info = await lstat(walked).catch((error: unknown) => {
      throw new Error(`Artifact path cannot be stat'ed (${segments.join("/")}): ${error instanceof Error ? error.message : String(error)}`);
    });
    if (info.isSymbolicLink()) throw new Error(`Artifact path is a symbolic link: ${segments.join("/")}`);
    const physical = await realpath(walked);
    if (!isWithin(rootReal, physical)) {
      throw new Error(`Artifact path resolves outside the root through a reparse point (junction?): ${segments.join("/")}`);
    }
    if (isLast) {
      if (final === "file" && !info.isFile()) throw new Error(`Artifact path is not a regular file: ${segments.join("/")}`);
      if (final === "directory" && !info.isDirectory()) throw new Error(`Artifact path is not a directory: ${segments.join("/")}`);
    } else if (!info.isDirectory()) {
      throw new Error(`Artifact parent is not a directory: ${segments.join("/")}`);
    }
  }
}

/**
 * Verify one declared entry resolves to a regular non-link file inside the
 * canonical root, and read+hash its bytes.
 */
async function hashArtifactFile(rootReal: string, normalized: string): Promise<ArtifactFileEntry> {
  const segments = normalized.split("/");
  const logical = resolve(rootReal, ...segments);
  if (!isWithin(rootReal, logical)) {
    throw new Error(`Artifact entry resolves outside the root: ${normalized}`);
  }
  await checkPhysicalChain(rootReal, segments, "file");
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

/**
 * Recursively sort every object's keys (arrays stay order-sensitive) and
 * reject values JSON cannot round-trip byte-for-byte.
 */
function canonicalJsonValue(value: unknown, pathLabel: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new Error(`Manifest is not canonical-JSON safe at ${pathLabel}: non-finite number`);
      return value;
    case "undefined":
    case "function":
    case "bigint":
    case "symbol":
      throw new Error(`Manifest is not canonical-JSON safe at ${pathLabel}: ${typeof value}`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalJsonValue(item, `${pathLabel}[${index}]`));
  }
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    target[key] = canonicalJsonValue(source[key], `${pathLabel}.${key}`);
  }
  return target;
}

/**
 * The single canonical encoding of a manifest (E5 step 5): schema-validated,
 * every object key sorted recursively, UTF-8 JSON with no whitespace. The
 * manifest hash is defined over exactly these bytes.
 */
export function canonicalArtifactManifestJson(manifest: ArtifactManifest): string {
  const parsed = ArtifactManifestSchema.parse(manifest);
  return JSON.stringify(canonicalJsonValue(parsed, "$"));
}

/** The artifact identity: SHA-256 over the canonical manifest bytes. */
export function artifactManifestHash(manifest: ArtifactManifest): string {
  return createHash("sha256").update(canonicalArtifactManifestJson(manifest), "utf8").digest("hex");
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

/**
 * Re-hash stored bytes against the stored manifest; any drift rejects. The
 * whole chain (artifact dir, manifest.json, files/) is link-checked first,
 * each listed file re-passes the per-segment physical boundary check, and
 * the stored file set must equal the manifest's exactly.
 */
export async function verifyArtifact(input: { store: string; artifactHash: string }): Promise<ArtifactManifest> {
  if (!/^[a-f0-9]{64}$/.test(input.artifactHash)) throw new Error("artifactHash must be a lowercase SHA-256 hex digest");
  const rootReal = await realpath(resolve(input.store));
  const directorySegments = ["artifacts", input.artifactHash];
  await checkPhysicalChain(rootReal, directorySegments, "directory");
  const manifestSegments = [...directorySegments, "manifest.json"];
  await checkPhysicalChain(rootReal, manifestSegments, "file");
  const manifest = ArtifactManifestSchema.parse(
    JSON.parse(await readFile(join(rootReal, ...manifestSegments), "utf8")) as unknown,
  );
  const hash = artifactManifestHash(manifest);
  if (hash !== input.artifactHash) {
    throw new Error(`Artifact manifest does not hash to its content-address (${hash} != ${input.artifactHash})`);
  }
  const filesSegments = [...directorySegments, "files"];
  await checkPhysicalChain(rootReal, filesSegments, "directory");
  const filesRoot = join(rootReal, ...filesSegments);
  for (const file of manifest.files) {
    // A subtree swapped for a junction after sealing must fail the chain
    // check here even when the remote bytes hash identically.
    const entry = await hashArtifactFile(filesRoot, file.path).catch((error: unknown) => {
      if (error instanceof Error && /cannot be stat'ed/.test(error.message)) {
        throw new Error(`Artifact file is missing from the frozen store: ${file.path}`);
      }
      throw error;
    });
    if (entry.sha256 !== file.sha256 || entry.sizeBytes !== file.sizeBytes) {
      throw new Error(`Frozen artifact was tampered after sealing: ${file.path}`);
    }
  }
  await assertNoUnlistedFiles(filesRoot, new Set(manifest.files.map((file) => file.path)), "");
  return manifest;
}

/** Every stored path must be covered by the manifest: no smuggled extras. */
async function assertNoUnlistedFiles(base: string, listed: ReadonlySet<string>, relDir: string): Promise<void> {
  for (const dirent of await readdir(join(base, relDir), { withFileTypes: true })) {
    const rel = relDir.length > 0 ? `${relDir}/${dirent.name}` : dirent.name;
    if (dirent.isSymbolicLink()) throw new Error(`Frozen tree contains a symbolic link: ${rel}`);
    if (dirent.isDirectory()) {
      await assertNoUnlistedFiles(base, listed, rel);
      continue;
    }
    if (!dirent.isFile()) throw new Error(`Frozen tree contains a special file: ${rel}`);
    if (!listed.has(rel)) throw new Error(`Frozen tree contains a file not listed in the manifest: ${rel}`);
  }
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code;
}
