import { constants } from "node:fs";
import { access, lstat, open, readdir, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { parseDocument } from "yaml";

export type SkillSource = "global" | "project";

export interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly root: string;
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

export interface SkillRegistryOptions {
  globalRoots?: readonly string[];
  projectRoots?: readonly string[];
  selector?: SkillSelector;
  authorizeResource?: SkillResourceAuthorizer;
  maxMetadataBytes?: number;
  maxBodyBytes?: number;
  maxResourceBytes?: number;
}

interface SkillRecord {
  metadata: SkillMetadata;
  skillFile: string;
}

interface ParsedFrontmatter {
  name: string;
  description: string;
  bodyOffset: number;
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
  >> & Pick<SkillRegistryOptions, "selector" | "authorizeResource">;
  readonly #records = new Map<string, SkillRecord>();
  #diagnostics: SkillDiagnostic[] = [];
  #discovered = false;

  constructor(options: SkillRegistryOptions = {}) {
    this.#options = {
      globalRoots: options.globalRoots ?? [],
      projectRoots: options.projectRoots ?? [],
      maxMetadataBytes: positiveLimit(options.maxMetadataBytes, DEFAULT_METADATA_LIMIT, "maxMetadataBytes"),
      maxBodyBytes: positiveLimit(options.maxBodyBytes, DEFAULT_BODY_LIMIT, "maxBodyBytes"),
      maxResourceBytes: positiveLimit(options.maxResourceBytes, DEFAULT_RESOURCE_LIMIT, "maxResourceBytes"),
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      ...(options.authorizeResource === undefined ? {} : { authorizeResource: options.authorizeResource }),
    };
  }

  get diagnostics(): readonly SkillDiagnostic[] {
    return [...this.#diagnostics];
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
      .map((metadata) => ({ metadata, score: score(metadata, queryTerms) }))
      .filter(({ score: value }) => value > 0)
      .sort((left, right) => right.score - left.score || left.metadata.name.localeCompare(right.metadata.name))
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
    await assertRegularContainedFile(record.skillFile, record.metadata.root, "Skill file");
    const parsed = await readFrontmatter(record.skillFile, this.#options.maxMetadataBytes);
    if (parsed.name !== record.metadata.name || parsed.description !== record.metadata.description) {
      throw new Error(`Skill frontmatter changed after discovery: ${record.metadata.name}`);
    }
    const info = await stat(record.skillFile);
    const bodyBytes = info.size - parsed.bodyOffset;
    if (bodyBytes > this.#options.maxBodyBytes) {
      throw new Error(`Skill body is too large: ${record.metadata.name}`);
    }
    const handle = await open(record.skillFile, "r");
    try {
      const body = Buffer.alloc(bodyBytes);
      let bytesRead = 0;
      while (bytesRead < bodyBytes) {
        const result = await handle.read(body, bytesRead, bodyBytes - bytesRead, parsed.bodyOffset + bytesRead);
        if (result.bytesRead === 0) throw new Error(`Skill body changed while loading: ${record.metadata.name}`);
        bytesRead += result.bytesRead;
      }
      return body.toString("utf8");
    } finally {
      await handle.close();
    }
  }

  async resolveResource(skill: SkillMetadata, reference: string): Promise<string> {
    const record = await this.#recordFor(skill);
    const normalized = reference.replaceAll("\\", "/");
    const parts = normalized.split("/");
    if (isAbsolute(reference) || parts.includes("..") || parts.length !== 2 || !RESOURCE_DIRECTORIES.has(parts[0] ?? "")
      || !RESOURCE_NAME.test(parts[1] ?? "")) {
      throw new Error(`Resource reference escapes the skill root or is not a direct resource: ${reference}`);
    }
    const body = (await this.loadBody(record.metadata)).replaceAll("\\", "/");
    const references = new Set(body.match(/(?:assets|references|scripts)\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/g) ?? []);
    if (!references.has(normalized)) throw new Error(`Skill resource is not directly referenced: ${reference}`);
    const candidate = resolve(record.metadata.root, ...parts);
    await assertRegularContainedFile(candidate, record.metadata.root, "Resource");
    const authorize = this.#options.authorizeResource;
    if (authorize === undefined || !(await authorize(candidate, record.metadata))) {
      throw new Error(`Permission denied for skill resource: ${reference}`);
    }
    return candidate;
  }

  async readResource(skill: SkillMetadata, reference: string): Promise<string> {
    const path = await this.resolveResource(skill, reference);
    const info = await stat(path);
    if (info.size > this.#options.maxResourceBytes) throw new Error(`Skill resource is too large: ${reference}`);
    return readFile(path, "utf8");
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
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const skillRoot = resolve(root, entry.name);
        try {
          if (entry.isSymbolicLink()) throw new Error("Symlinked skill directories are not allowed");
          if (!entry.isDirectory()) continue;
          const physicalRoot = await realpath(skillRoot);
          if (!isWithin(root, physicalRoot)) throw new Error("Skill directory escapes its registry root");
          const skillFile = resolve(skillRoot, "SKILL.md");
          await assertRegularContainedFile(skillFile, physicalRoot, "Skill file");
          const parsed = await readFrontmatter(skillFile, this.#options.maxMetadataBytes);
          if (!SKILL_NAME.test(parsed.name)) throw new Error(`Invalid skill name: ${parsed.name}`);
          if (entry.name !== parsed.name) throw new Error("Skill folder must exactly match frontmatter name");
          found.push({
            metadata: Object.freeze({ name: parsed.name, description: parsed.description, source, root: physicalRoot }),
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
    const record = this.#records.get(skill.name);
    if (record === undefined || record.metadata.root !== skill.root || record.metadata.source !== skill.source) {
      throw new Error(`Unknown or stale skill metadata: ${skill.name}`);
    }
    return record;
  }

  #sortedMetadata(): SkillMetadata[] {
    return [...this.#records.values()].map(({ metadata }) => metadata)
      .sort((left, right) => left.name.localeCompare(right.name));
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

async function readFrontmatter(path: string, maxBytes: number): Promise<ParsedFrontmatter> {
  const handle = await open(path, "r");
  try {
    let offset = 0;
    const first = await readLine(handle, offset, maxBytes);
    if (first === undefined || cleanLine(first.bytes) !== "---") throw new Error("SKILL.md must open with YAML frontmatter");
    offset = first.nextOffset;
    const yamlLines: Buffer[] = [];
    while (offset <= maxBytes) {
      const line = await readLine(handle, offset, maxBytes - offset);
      if (line === undefined) throw new Error("YAML frontmatter is not closed");
      offset = line.nextOffset;
      if (cleanLine(line.bytes) === "---") {
        const document = parseDocument(Buffer.concat(yamlLines).toString("utf8"), { uniqueKeys: true });
        if (document.errors.length > 0) throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message ?? "parse error"}`);
        const metadata: unknown = document.toJS({ maxAliasCount: 20 });
        if (!isPlainRecord(metadata)) throw new Error("Skill frontmatter must be a mapping");
        const keys = Object.keys(metadata).sort();
        if (keys.length !== 2 || keys[0] !== "description" || keys[1] !== "name") {
          throw new Error("Skill frontmatter must contain exactly name and description");
        }
        if (typeof metadata.name !== "string" || typeof metadata.description !== "string" || metadata.description.trim() === "") {
          throw new Error("Skill name and description must be non-empty strings");
        }
        return { name: metadata.name, description: metadata.description, bodyOffset: offset };
      }
      yamlLines.push(line.bytes);
    }
    throw new Error("Skill metadata is too large");
  } catch (error) {
    if (error instanceof MetadataLimitError) throw new Error("Skill metadata is too large");
    throw error;
  } finally {
    await handle.close();
  }
}

class MetadataLimitError extends Error {}

async function readLine(
  handle: Awaited<ReturnType<typeof open>>,
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

function cleanLine(line: Buffer): string {
  return line.toString("utf8").replace(/\r?\n$/, "");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function assertRegularContainedFile(path: string, root: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`${label} symlinks are not allowed`);
  if (!info.isFile()) throw new Error(`${label} must be a regular file`);
  await access(path, constants.R_OK);
  const physical = await realpath(path);
  if (!isWithin(root, physical)) throw new Error(`${label} escapes the skill root`);
}

function isWithin(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (delta !== ".." && !delta.startsWith(`..${sep}`) && !isAbsolute(delta));
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
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
