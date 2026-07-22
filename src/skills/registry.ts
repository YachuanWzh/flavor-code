import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open as defaultOpen, readdir, realpath } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { marked } from "marked";
import { parseDocument } from "yaml";

export type SkillSource = "global" | "project";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly root: string;
  readonly disableModelInvocation: boolean;
}

export interface SkillDiagnostic {
  readonly path: string;
  readonly message: string;
}

export type SkillSelector = (
  query: string,
  candidates: readonly SkillMetadata[],
) => string | undefined | Promise<string | undefined>;

export type SkillResourceAuthorizer = (
  path: string,
  skill: SkillMetadata,
) => boolean | Promise<boolean>;

export type SkillFileOpener = (path: string, flags: number) => Promise<FileHandle>;

export type SkillResourceKind = "asset" | "reference" | "script";

export interface ResolvedSkillResource {
  readonly displayPath: string;
  readonly kind: SkillResourceKind;
  readonly size: number;
  readonly skill: Readonly<Pick<SkillMetadata, "name" | "source">>;
}

export interface SkillRegistryOptions {
  globalRoots?: readonly string[];
  projectRoots?: readonly string[];
  selector?: SkillSelector;
  authorizeResource?: SkillResourceAuthorizer;
  maxMetadataBytes?: number;
  maxBodyBytes?: number;
  maxResourceBytes?: number;
  openFile?: SkillFileOpener;
  disabledNames?: readonly string[];
}

interface SkillRecord {
  metadata: SkillMetadata;
  skillFile: string;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  disableModelInvocation: boolean;
  bodyOffset: number;
}

interface FileSnapshot {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface VerifiedFile {
  handle: FileHandle;
  path: string;
  snapshot: FileSnapshot;
}

interface ResolvedResourceRecord {
  path: string;
  reference: string;
  snapshot: FileSnapshot;
  record: SkillRecord;
}

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESOURCE_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const RESOURCE_DIRECTORIES = new Set(["assets", "references", "scripts"]);
const DEFAULT_METADATA_LIMIT = 16 * 1024;
const DEFAULT_BODY_LIMIT = 256 * 1024;
const DEFAULT_RESOURCE_LIMIT = 1024 * 1024;

export class SkillRegistry {
  readonly #options: Required<Pick<SkillRegistryOptions,
    "globalRoots" | "projectRoots" | "maxMetadataBytes" | "maxBodyBytes" | "maxResourceBytes"
  >> & Pick<SkillRegistryOptions, "selector" | "authorizeResource"> & { openFile: SkillFileOpener };
  readonly #records = new Map<string, SkillRecord>();
  #capabilities = new WeakMap<ResolvedSkillResource, ResolvedResourceRecord>();
  #diagnostics: SkillDiagnostic[] = [];
  #discovered = false;
  #disabledNames: Set<string>;

  constructor(options: SkillRegistryOptions = {}) {
    this.#options = {
      globalRoots: options.globalRoots ?? [],
      projectRoots: options.projectRoots ?? [],
      maxMetadataBytes: positiveLimit(options.maxMetadataBytes, DEFAULT_METADATA_LIMIT, "maxMetadataBytes"),
      maxBodyBytes: positiveLimit(options.maxBodyBytes, DEFAULT_BODY_LIMIT, "maxBodyBytes"),
      maxResourceBytes: positiveLimit(options.maxResourceBytes, DEFAULT_RESOURCE_LIMIT, "maxResourceBytes"),
      openFile: options.openFile ?? openFile,
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      ...(options.authorizeResource === undefined ? {} : { authorizeResource: options.authorizeResource }),
    };
    this.#disabledNames = new Set(options.disabledNames ?? []);
  }

  get diagnostics(): readonly SkillDiagnostic[] {
    return [...this.#diagnostics];
  }

  setDisabledNames(names: readonly string[]): void {
    this.#disabledNames = new Set(names);
    this.#capabilities = new WeakMap<ResolvedSkillResource, ResolvedResourceRecord>();
  }

  async refresh(): Promise<readonly SkillMetadata[]> {
    this.#records.clear();
    this.#diagnostics = [];
    this.#discovered = false;
    return this.discover();
  }

  async discover(): Promise<readonly SkillMetadata[]> {
    if (!this.#discovered) {
      this.#diagnostics = [];
      const globals = await this.#discoverSource(this.#options.globalRoots, "global");
      const projects = await this.#discoverSource(this.#options.projectRoots, "project");
      for (const record of globals) this.#records.set(record.metadata.name, record);
      for (const record of projects) this.#records.set(record.metadata.name, record);
      this.#discovered = true;
    }
    return this.#sortedMetadata();
  }

  async match(query: string): Promise<SkillMetadata | undefined> {
    await this.discover();
    const queryTerms = terms(query);
    if (queryTerms.size === 0) return undefined;
    const candidates = this.#sortedMetadata()
      .filter(({ disableModelInvocation }) => !disableModelInvocation)
      .map((metadata) => ({ metadata, score: score(metadata, queryTerms) }))
      .filter(({ score: value }) => value > 0)
      .sort((left, right) => right.score - left.score || compareCodePoints(left.metadata.name, right.metadata.name))
      .map(({ metadata }) => metadata);
    if (candidates.length === 0) return undefined;

    if (this.#options.selector !== undefined) {
      try {
        const selected = await this.#options.selector(query, candidates);
        const refined = candidates.find(({ name }) => name === selected);
        if (refined !== undefined) return refined;
      } catch {
        // A selector is advisory. Deterministic matching remains available if it fails.
      }
    }
    return candidates[0];
  }

  async loadBody(skill: SkillMetadata): Promise<string> {
    const record = await this.#recordFor(skill);
    const file = await openVerifiedFile(record.skillFile, record.metadata.root, "Skill file", this.#options.openFile);
    try {
      const parsed = await readFrontmatter(file.handle, this.#options.maxMetadataBytes);
      if (parsed.name !== record.metadata.name || parsed.description !== record.metadata.description
        || parsed.disableModelInvocation !== record.metadata.disableModelInvocation) {
        throw new Error(`Skill frontmatter changed after discovery: ${record.metadata.name}`);
      }
      const expectedBytes = Number(file.snapshot.size) - parsed.bodyOffset;
      if (expectedBytes > this.#options.maxBodyBytes) throw new Error(`Skill body is too large: ${record.metadata.name}`);
      const body = await readBounded(file.handle, parsed.bodyOffset, this.#options.maxBodyBytes);
      if (body.length !== expectedBytes) throw new Error(`Skill body changed while loading: ${record.metadata.name}`);
      await assertHandleUnchanged(file.handle, file.snapshot, "Skill file");
      return decodeUtf8(body, `Skill body for ${record.metadata.name}`);
    } finally {
      await file.handle.close();
    }
  }

  async resolveResource(skill: SkillMetadata, reference: string): Promise<ResolvedSkillResource> {
    const resolved = await this.#resolveResource(skill, reference);
    const capability: ResolvedSkillResource = Object.freeze({
      displayPath: resolved.reference,
      kind: resourceKind(resolved.reference),
      size: Number(resolved.snapshot.size),
      skill: Object.freeze({ name: resolved.record.metadata.name, source: resolved.record.metadata.source }),
    });
    this.#capabilities.set(capability, resolved);
    return capability;
  }

  async readResource(capability: ResolvedSkillResource): Promise<Buffer> {
    const resolved = this.#capabilities.get(capability);
    if (resolved === undefined) throw new Error("Unknown or forged skill resource capability");
    if (this.#disabledNames.has(resolved.record.metadata.name)) throw new Error(`Skill is disabled: ${resolved.record.metadata.name}`);
    const file = await openVerifiedFile(
      resolved.path, resolved.record.metadata.root, "Resource", this.#options.openFile, resolved.snapshot,
    );
    try {
      const content = await readBounded(file.handle, 0, this.#options.maxResourceBytes);
      if (content.length !== Number(file.snapshot.size)) throw new Error(`Skill resource changed while loading: ${resolved.reference}`);
      await assertHandleUnchanged(file.handle, file.snapshot, "Resource");
      return content;
    } finally {
      await file.handle.close();
    }
  }

  async readTextResource(capability: ResolvedSkillResource): Promise<string> {
    return decodeUtf8(await this.readResource(capability), `Skill resource ${capability.displayPath}`);
  }

  async #resolveResource(skill: SkillMetadata, reference: string): Promise<ResolvedResourceRecord> {
    const record = await this.#recordFor(skill);
    const normalized = normalizeReference(reference);
    const parts = normalized.split("/");
    if (isAbsolute(reference) || parts.includes("..") || parts.length !== 2 || !RESOURCE_DIRECTORIES.has(parts[0] ?? "")
      || !RESOURCE_NAME.test(parts[1] ?? "")) {
      throw new Error(`Resource reference escapes the skill root or is not a direct resource: ${reference}`);
    }
    const body = await this.loadBody(record.metadata);
    const references = extractResourceReferences(body);
    if (!references.has(normalized)) throw new Error(`Skill resource is not directly referenced: ${reference}`);
    const candidate = resolve(record.metadata.root, ...parts);
    const file = await openVerifiedFile(candidate, record.metadata.root, "Resource", this.#options.openFile);
    try {
      if (file.snapshot.size > BigInt(this.#options.maxResourceBytes)) throw new Error(`Skill resource is too large: ${reference}`);
      const authorize = this.#options.authorizeResource;
      if (authorize === undefined || !(await authorize(file.path, record.metadata))) {
        throw new Error(`Permission denied for skill resource: ${reference}`);
      }
      await assertHandleUnchanged(file.handle, file.snapshot, "Resource");
      const revalidated = await openVerifiedFile(
        file.path, record.metadata.root, "Resource", this.#options.openFile, file.snapshot,
      );
      try {
        await assertHandleUnchanged(revalidated.handle, revalidated.snapshot, "Resource");
        return { path: revalidated.path, reference: normalized, snapshot: revalidated.snapshot, record };
      } finally {
        await revalidated.handle.close();
      }
    } finally {
      await file.handle.close();
    }
  }

  async #discoverSource(roots: readonly string[], source: SkillSource): Promise<SkillRecord[]> {
    const found: SkillRecord[] = [];
    for (const configuredRoot of roots) {
      const root = resolve(configuredRoot);
      let entries;
      try {
        const rootInfo = await lstat(root);
        if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("Skill root must be a real directory");
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) continue;
        this.#diagnose(root, error);
        continue;
      }
      entries.sort((left, right) => compareCodePoints(left.name, right.name));
      for (const entry of entries) {
        const skillRoot = resolve(root, entry.name);
        try {
          if (entry.isSymbolicLink()) throw new Error("Symlinked skill directories are not allowed");
          if (!entry.isDirectory()) continue;
          const physicalRoot = await realpath(skillRoot);
          if (!isWithin(root, physicalRoot)) throw new Error("Skill directory escapes its registry root");
          const skillFile = resolve(skillRoot, "SKILL.md");
          const parsed = await readFrontmatterFile(
            skillFile, physicalRoot, this.#options.maxMetadataBytes, this.#options.openFile,
          );
          if (!SKILL_NAME.test(parsed.name)) throw new Error(`Invalid skill name: ${parsed.name}`);
          if (entry.name !== parsed.name) throw new Error("Skill folder must exactly match frontmatter name");
          found.push({
            metadata: Object.freeze({
              name: parsed.name,
              description: parsed.description,
              source,
              root: physicalRoot,
              disableModelInvocation: parsed.disableModelInvocation,
            }),
            skillFile,
          });
        } catch (error) {
          this.#diagnose(skillRoot, error);
        }
      }
    }

    const counts = new Map<string, number>();
    for (const record of found) counts.set(record.metadata.name, (counts.get(record.metadata.name) ?? 0) + 1);
    const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
    for (const name of duplicates) {
      for (const record of found.filter((candidate) => candidate.metadata.name === name)) {
        this.#diagnostics.push({ path: record.metadata.root, message: `Duplicate ${source} skill name: ${name}` });
      }
    }
    return found.filter((record) => !duplicates.has(record.metadata.name));
  }

  async #recordFor(skill: SkillMetadata): Promise<SkillRecord> {
    await this.discover();
    if (this.#disabledNames.has(skill.name)) throw new Error(`Skill is disabled: ${skill.name}`);
    const record = this.#records.get(skill.name);
    if (record === undefined || record.metadata.root !== skill.root || record.metadata.source !== skill.source) {
      throw new Error(`Unknown or stale skill metadata: ${skill.name}`);
    }
    return record;
  }

  #sortedMetadata(): SkillMetadata[] {
    return [...this.#records.values()].map(({ metadata }) => metadata)
      .filter(({ name }) => !this.#disabledNames.has(name))
      .sort((left, right) => compareCodePoints(left.name, right.name));
  }

  #diagnose(path: string, error: unknown): void {
    this.#diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
  }
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${name} must be a positive integer`);
  return result;
}

async function readFrontmatterFile(
  path: string,
  root: string,
  maxBytes: number,
  opener: SkillFileOpener,
): Promise<ParsedFrontmatter> {
  const file = await openVerifiedFile(path, root, "Skill file", opener);
  try {
    const parsed = await readFrontmatter(file.handle, maxBytes);
    await assertHandleUnchanged(file.handle, file.snapshot, "Skill file");
    return parsed;
  } finally {
    await file.handle.close();
  }
}

async function readFrontmatter(handle: FileHandle, maxBytes: number): Promise<ParsedFrontmatter> {
  try {
    let offset = 0;
    const first = await readLine(handle, offset, maxBytes);
    if (first === undefined || !isDelimiter(first.bytes)) throw new Error("SKILL.md must open with YAML frontmatter");
    offset = first.nextOffset;
    const yamlLines: Buffer[] = [];
    while (offset <= maxBytes) {
      const line = await readLine(handle, offset, maxBytes - offset);
      if (line === undefined) throw new Error("YAML frontmatter is not closed");
      offset = line.nextOffset;
      if (isDelimiter(line.bytes)) {
        const document = parseDocument(decodeUtf8(Buffer.concat(yamlLines), "Skill frontmatter"), { uniqueKeys: true });
        if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`);
        if (document.warnings.length > 0) throw new Error(`Unsafe YAML frontmatter: ${document.warnings[0]?.message ?? "warning"}`);
        let metadata: unknown;
        try {
          metadata = document.toJS({ maxAliasCount: 0 });
        } catch (error) {
          throw new Error("YAML aliases are not allowed", { cause: error });
        }
        if (!isPlainRecord(metadata)) throw new Error("Skill frontmatter must be a mapping");
        if (typeof metadata.name !== "string" || typeof metadata.description !== "string" || metadata.description.trim() === "") {
          throw new Error("Skill name and description must be non-empty strings");
        }
        const manualOnly = metadata["disable-model-invocation"];
        if (manualOnly !== undefined && typeof manualOnly !== "boolean") {
          throw new Error("Skill disable-model-invocation must be a boolean");
        }
        return {
          name: metadata.name,
          description: metadata.description,
          disableModelInvocation: manualOnly ?? false,
          bodyOffset: offset,
        };
      }
      yamlLines.push(line.bytes);
    }
    throw new Error("Skill metadata is too large");
  } catch (error) {
    if (error instanceof MetadataLimitError) throw new Error("Skill metadata is too large");
    throw error;
  }
}

class MetadataLimitError extends Error {}

async function readLine(
  handle: FileHandle,
  start: number,
  remaining: number,
): Promise<{ bytes: Buffer; nextOffset: number } | undefined> {
  if (remaining <= 0) throw new MetadataLimitError();
  const chunks: number[] = [];
  const byte = Buffer.allocUnsafe(1);
  let offset = start;
  while (chunks.length < remaining) {
    const { bytesRead } = await handle.read(byte, 0, 1, offset);
    if (bytesRead === 0) return chunks.length === 0 ? undefined : { bytes: Buffer.from(chunks), nextOffset: offset };
    const value = byte[0]!;
    chunks.push(value); offset += 1;
    if (value === 10) return { bytes: Buffer.from(chunks), nextOffset: offset };
  }
  throw new MetadataLimitError();
}

function isDelimiter(line: Buffer): boolean {
  const end = line.at(-1) === 10 ? line.length - (line.at(-2) === 13 ? 2 : 1) : line.length;
  return end === 3 && line[0] === 45 && line[1] === 45 && line[2] === 45;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function openFile(path: string, flags: number): Promise<FileHandle> {
  return defaultOpen(path, flags);
}

async function openVerifiedFile(
  path: string,
  root: string,
  label: string,
  opener: SkillFileOpener,
  expected?: FileSnapshot,
): Promise<VerifiedFile> {
  const initial = await lstat(path, { bigint: true });
  if (initial.isSymbolicLink()) throw new Error(`${label} symlinks are not allowed`);
  assertRegular(initial, label);
  const canonical = await realpath(path);
  if (!isWithin(root, canonical)) throw new Error(`${label} escapes the skill root`);
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await opener(canonical, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat({ bigint: true });
    assertRegular(opened, label);
    const initialSnapshot = snapshot(initial);
    const openedSnapshot = snapshot(opened);
    if (!sameIdentityAndSize(initialSnapshot, openedSnapshot)
      || (expected !== undefined && !sameSnapshot(expected, openedSnapshot))) {
      throw new Error(`${label} identity or metadata changed while opening`);
    }
    return { handle, path: canonical, snapshot: openedSnapshot };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

function assertRegular(info: BigIntStats, label: string): void {
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
}

function snapshot(info: BigIntStats): FileSnapshot {
  return {
    dev: info.dev,
    ino: info.ino,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameSnapshot(left: FileSnapshot, right: FileSnapshot): boolean {
  return sameIdentityAndSize(left, right)
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameIdentityAndSize(left: FileSnapshot, right: FileSnapshot): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.size === right.size;
}

async function assertHandleUnchanged(handle: FileHandle, expected: FileSnapshot, label: string): Promise<void> {
  const current = await handle.stat({ bigint: true });
  assertRegular(current, label);
  if (!sameSnapshot(expected, snapshot(current))) throw new Error(`${label} changed while reading`);
}

async function readBounded(handle: FileHandle, position: number, maxBytes: number): Promise<Buffer> {
  const buffer = Buffer.alloc(maxBytes + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > maxBytes) throw new Error("File content exceeds configured size limit");
  return buffer.subarray(0, total);
}

function decodeUtf8(content: Uint8Array, label: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw new Error(`${label} contains invalid UTF-8 encoding`, { cause: error });
  }
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeReference(reference: string): string {
  return reference.replaceAll("\\", "/");
}

function extractResourceReferences(body: string): Set<string> {
  const found = new Set<string>();
  const tokens = marked.lexer(body, { async: false, gfm: true });
  marked.walkTokens(tokens, (token) => {
    if (token.type === "link" || token.type === "image") addExplicitReference(found, token.href);
    if (token.type === "codespan") addExplicitReference(found, token.text.trim());
  });
  return found;
}

function addExplicitReference(found: Set<string>, value: string): void {
  const normalized = normalizeReference(value);
  const parts = normalized.split("/");
  if (parts.length === 2 && RESOURCE_DIRECTORIES.has(parts[0] ?? "") && RESOURCE_NAME.test(parts[1] ?? "")) {
    found.add(normalized);
  }
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceKind(reference: string): SkillResourceKind {
  if (reference.startsWith("assets/")) return "asset";
  if (reference.startsWith("references/")) return "reference";
  return "script";
}

function terms(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function score(metadata: SkillMetadata, query: ReadonlySet<string>): number {
  const nameTerms = terms(metadata.name);
  const descriptionTerms = terms(metadata.description);
  let result = 0;
  for (const term of query) {
    if (nameTerms.has(term)) result += 3;
    if (descriptionTerms.has(term)) result += 1;
  }
  return result;
}
