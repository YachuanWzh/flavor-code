import { constants, type Stats } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { buildFileChangePresentation, buildPatchPresentation } from "./file-diff.js";
import { withToolPresentation, type ToolDefinition } from "./types.js";

export const MAX_READ_BYTES = 1_048_576;

const ReadInput = z.object({
  path: z.string().min(1),
  maxBytes: z.coerce.number().int().positive().max(MAX_READ_BYTES).nullable().optional(),
  startLine: z.coerce.number().int().positive().nullable().optional(),
  endLine: z.coerce.number().int().positive().nullable().optional(),
  // Accepts booleans and their string forms (weak-typed models emit "true");
  // kept transform-free so the schema converts to JSON Schema for providers.
  force: z.union([z.boolean(), z.string().refine((value) => value === "true" || value === "false")]).nullable().optional(),
});
const WriteInput = z.object({ path: z.string().min(1), content: z.string() });
const EditInput = z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() });
const ApplyPatchInput = z.object({ patch: z.string().min(1) });

export interface ReadFileHandle {
  read(buffer: Buffer, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ReadToolOptions {
  openFile?: (path: string) => Promise<ReadFileHandle>;
  observations?: FileObservationStore;
}

export interface FileWriteProposal {
  path: string;
  before: string;
  after: string;
  kind: "create" | "update";
}

export interface FileMutationOptions {
  beforeCommit?(proposal: FileWriteProposal, signal: AbortSignal): Promise<void>;
  observations?: FileObservationStore;
}

/** Session-scoped compare-and-swap versions shared by Read/Write/Edit/ApplyPatch. */
export class FileObservationStore {
  readonly #versions = new Map<string, string>();
  get(path: string): string | undefined { return this.#versions.get(path); }
  set(path: string, version: string): void { this.#versions.set(path, version); }
  async refresh(path: string): Promise<void> { this.set(path, await fileVersion(path)); }
  async assertCurrent(path: string, expected: string): Promise<void> {
    const current = await fileVersion(path);
    if (current !== expected) throw new Error(`Stale file: ${path} changed since it was read; read it again before writing`);
  }
}

export function createReadTool(workspace: string, options: ReadToolOptions = {}): ToolDefinition<z.infer<typeof ReadInput>> {
  const guard = createPathGuard(workspace);
  const openFile = options.openFile ?? ((path: string) => open(path, constants.O_RDONLY));
  // Per-tool-instance read history backing duplicate-read detection. It lives
  // for the whole run, so a file served once is not re-served while unchanged.
  const readHistory = new Map<string, ReadRecord>();
  return {
    name: "Read",
    description: "Read a UTF-8 text file, optionally restricted to a line range with startLine/endLine",
    inputSchema: ReadInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.existing(input.path);
      const info = await stat(path);
      const maxBytes = input.maxBytes ?? MAX_READ_BYTES;
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_READ_BYTES) {
        throw new Error(`maxBytes must be a positive integer no greater than ${MAX_READ_BYTES}`);
      }
      const startLine = input.startLine ?? undefined;
      const endLine = input.endLine ?? undefined;
      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        throw new Error(`endLine (${endLine}) must not be below startLine (${startLine})`);
      }
      const contents = await readBounded(path, maxBytes, signal, openFile);
      if (isBinary(contents)) throw new Error("Cannot read binary file as text");
      // Trim to a UTF-8 character boundary so the returned text never ends
      // mid-character; the byte count may sit up to 3 bytes below maxBytes.
      const textEnd = utf8SafeEnd(contents, maxBytes);
      const truncated = contents.length > maxBytes;
      const text = contents.subarray(0, textEnd).toString("utf8").replaceAll("\r\n", "\n");
      options.observations?.set(path, versionOfStat(info));
      const lines = text.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const availableLines = lines.length;
      const rangeRequested = startLine !== undefined || endLine !== undefined;
      const start = startLine ?? 1;
      const end = Math.min(endLine ?? availableLines, availableLines);
      if (rangeRequested && start > availableLines) {
        throw new Error(`startLine (${start}) is beyond the ${availableLines} line${availableLines === 1 ? "" : "s"} available${truncated ? ` in this read (truncated at ${maxBytes} bytes)` : " in this file"}`);
      }
      if (rangeRequested && end < start) {
        throw new Error(`endLine (${endLine}) must not be below startLine (${start})`);
      }

      // Duplicate-read detection: unchanged content already served in this run
      // is still in the model context, so re-serving it only spends tokens.
      // A range-less read requests every visible line, so both forms reduce to
      // the same coverage check against the served snapshot.
      const record = readHistory.get(path);
      const alreadyServed = record !== undefined
        && record.snapshot === text
        && rangeCovered(record.ranges, start, end);
      if (alreadyServed && forceFlag(input.force) !== true) {
        return `[Duplicate read suppressed] ${input.path} is unchanged since the last read and the requested ${rangeRequested ? `lines ${start}-${end} are` : "full content is"} already in your context — quote the earlier result instead of re-reading. Pass startLine/endLine for a region you have not seen, or force=true only if the earlier result has been compacted away.`;
      }

      if (record === undefined || record.snapshot !== text) {
        readHistory.set(path, { snapshot: text, ranges: [[start, end]] });
      } else {
        record.ranges = mergeRange(record.ranges, start, end);
      }

      if (rangeRequested) {
        const header = `[Lines ${start}-${end} of ${availableLines}${truncated ? ` visible in this read (truncated at ${maxBytes} bytes)` : ""}]`;
        return `${header}\n\n${lines.slice(start - 1, end).join("\n")}`;
      }
      if (truncated) {
        return `[Truncated to ${maxBytes} bytes. File is ${info.size} bytes total. Request a higher maxBytes or read a specific range with startLine/endLine.]\n\n${text}`;
      }
      return text;
    },
  };
}

export function createWriteTool(workspace: string, options: FileMutationOptions = {}): ToolDefinition<z.infer<typeof WriteInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "Write",
    description: "Create or atomically replace a text file",
    inputSchema: WriteInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.destination(input.path);
      const expected = await expectedMutationVersion(path, options.observations);
      const previous = await readOptionalPresentationText(path);
      if (!previous.exists || previous.text !== undefined) {
        await options.beforeCommit?.({
          path,
          before: previous.text ?? "",
          after: input.content,
          kind: previous.exists ? "update" : "create",
        }, signal);
      }
      await assertMutationVersion(path, expected, options.observations);
      await atomicWrite(path, input.content, signal, expected);
      await options.observations?.refresh(path);
      const output = { path, bytes: Buffer.byteLength(input.content) };
      if (previous.exists && previous.text === undefined) return output;
      return withToolPresentation(output, buildFileChangePresentation(
        path,
        previous.text ?? "",
        input.content,
        previous.exists ? "update" : "create",
      ));
    },
  };
}

export function createEditTool(workspace: string, options: FileMutationOptions = {}): ToolDefinition<z.infer<typeof EditInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "Edit",
    description: "Replace one unique exact text match",
    inputSchema: EditInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.existing(input.path);
      const expected = await expectedMutationVersion(path, options.observations);
      const contents = await readText(path);
      const hasCRLF = contents.includes("\r\n");
      const norm = (s: string): string => hasCRLF ? s.replace(/\r\n/g, "\n") : s;
      const contentsLF = norm(contents);
      const oldTextLF = norm(input.oldText);
      const newTextLF = norm(input.newText);
      const first = contentsLF.indexOf(oldTextLF);
      const second = first < 0 ? -1 : contentsLF.indexOf(oldTextLF, first + oldTextLF.length);
      if (first < 0 || second >= 0) {
        const diagnosis = buildEditDiagnosis(contentsLF, oldTextLF, first, second);
        throw new Error(diagnosis);
      }
      const updatedLF = contentsLF.slice(0, first) + newTextLF + contentsLF.slice(first + oldTextLF.length);
      const updated = hasCRLF ? updatedLF.replace(/\n/g, "\r\n") : updatedLF;
      await options.beforeCommit?.({ path, before: contents, after: updated, kind: "update" }, signal);
      await assertMutationVersion(path, expected, options.observations);
      await atomicWrite(path, updated, signal, expected);
      await options.observations?.refresh(path);
      return withToolPresentation(
        { path, replacements: 1 },
        buildFileChangePresentation(path, contents, updated, "update"),
      );
    },
  };
}

export function createApplyPatchTool(workspace: string, options: FileMutationOptions = {}): ToolDefinition<z.infer<typeof ApplyPatchInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "ApplyPatch",
    description: "Apply a workspace-limited unified diff, relocating hunks only by unique exact context",
    inputSchema: ApplyPatchInput,
    paths: (input) => parsePatch(input.patch).map((file) => guard.lexical(file.path)),
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const changes = parsePatch(input.patch);
      const prepared: Array<{ path: string; content: string; change: PatchFile; hunks: PatchHunk[]; expected: string }> = [];
      for (const change of changes) {
        const path = await guard.destination(change.path);
        const expected = await expectedMutationVersion(path, options.observations);
        const original = change.created
          ? await requireAbsent(guard, change.path)
          : await readText(await guard.existing(change.path));
        const applied = applyHunks(original, change.hunks);
        prepared.push({ path, content: applied.content, change, hunks: applied.hunks, expected });
      }
      for (const change of prepared) await assertMutationVersion(change.path, change.expected, options.observations);
      for (const change of prepared) {
        const before = change.change.created ? "" : await readText(change.path);
        await options.beforeCommit?.({
          path: change.path,
          before,
          after: change.content,
          kind: change.change.created ? "create" : "update",
        }, signal);
      }
      // Hooks may take arbitrarily long and external editors may update any target.
      // Revalidate the whole patch before the first replacement to avoid partial commits.
      for (const change of prepared) await assertMutationVersion(change.path, change.expected, options.observations);
      for (const change of prepared) {
        await atomicWrite(change.path, change.content, signal, change.expected);
        await options.observations?.refresh(change.path);
      }
      const first = prepared[0]!;
      const primaryPresentation = buildPatchPresentation(first.path, first.change.created, first.hunks);
      const relatedChanges = prepared.slice(1).map((change) => buildPatchPresentation(change.path, change.change.created, change.hunks));
      return withToolPresentation(
        { files: prepared.map((change) => change.path) },
        relatedChanges.length === 0 ? primaryPresentation : { ...primaryPresentation, relatedChanges },
      );
    },
  };
}

export const createRead = createReadTool;
export const createWrite = createWriteTool;
export const createEdit = createEditTool;
export const createApplyPatch = createApplyPatchTool;

interface PathGuard {
  lexical(path: string): string;
  existing(path: string): Promise<string>;
  destination(path: string): Promise<string>;
}

function createPathGuard(workspace: string): PathGuard {
  const root = resolve(workspace);
  const lexical = (input: string) => {
    const candidate = resolve(root, input);
    if (!within(root, candidate)) throw new Error("Path is outside the workspace");
    return candidate;
  };
  return {
    lexical,
    existing: async (input) => {
      const candidate = lexical(input);
      const physical = await realpath(candidate);
      if (!within(await realpath(root), physical)) throw new Error("Path escapes the workspace through a symlink");
      return physical;
    },
    destination: async (input) => {
      const candidate = lexical(input);
      const physicalRoot = await realpath(root);
      let ancestor = candidate;
      while (true) {
        try {
          const physical = await realpath(ancestor);
          if (!within(physicalRoot, physical)) throw new Error("Path escapes the workspace through a symlink");
          break;
        } catch (error) {
          if (!isMissing(error)) throw error;
          const parent = dirname(ancestor);
          if (parent === ancestor) throw error;
          ancestor = parent;
        }
      }
      return candidate;
    },
  };
}

async function atomicWrite(path: string, content: string, signal: AbortSignal, expectedVersion?: string): Promise<void> {
  abortIfNeeded(signal);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    abortIfNeeded(signal);
    if (expectedVersion !== undefined && await fileVersion(path) !== expectedVersion) {
      throw new Error(`Stale file: ${path} changed while the replacement was being prepared`);
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function readText(path: string): Promise<string> {
  const contents = await readFile(path);
  if (isBinary(contents)) throw new Error("Cannot edit binary file as text");
  return contents.toString("utf8");
}

const ABSENT_VERSION = "absent";

async function expectedMutationVersion(path: string, observations?: FileObservationStore): Promise<string> {
  const current = await fileVersion(path);
  const observed = observations?.get(path);
  if (observed !== undefined && observed !== current) {
    throw new Error(`Stale file: ${path} changed since it was read; read it again before writing`);
  }
  return current;
}

async function assertMutationVersion(path: string, expected: string, observations?: FileObservationStore): Promise<void> {
  if (observations !== undefined) await observations.assertCurrent(path, expected);
  else if (await fileVersion(path) !== expected) throw new Error(`Stale file: ${path} changed since mutation preparation`);
}

async function fileVersion(path: string): Promise<string> {
  try { return versionOfStat(await stat(path)); }
  catch (error) { if (isMissing(error)) return ABSENT_VERSION; throw error; }
}

function versionOfStat(info: Stats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

async function readOptionalPresentationText(path: string): Promise<{ exists: boolean; text?: string }> {
  try {
    const contents = await readFile(path);
    return isBinary(contents) ? { exists: true } : { exists: true, text: contents.toString("utf8") };
  } catch (error) {
    return isMissing(error) ? { exists: false } : { exists: true };
  }
}

function isBinary(contents: Buffer): boolean {
  if (contents.includes(0)) return true;
  // Strict UTF-8 check that tolerates only an incomplete trailing sequence: a
  // bounded Read can cut a multi-byte character exactly at maxBytes, which is
  // still a text file. Invalid bytes anywhere else remain binary.
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return false;
  } catch {
    for (let trim = 1; trim <= 3; trim += 1) {
      if (trim > contents.length) break;
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(0, contents.length - trim));
        return !isIncompleteUtf8Prefix(contents.subarray(contents.length - trim));
      } catch { /* keep trimming */ }
    }
    return true;
  }
}

function isIncompleteUtf8Prefix(tail: Buffer): boolean {
  // True when tail is a valid prefix of a multi-byte UTF-8 character that is
  // missing continuation bytes (i.e. the bounded read cut the character).
  if (tail.length === 0 || tail.length > 3) return false;
  const b0 = tail[0]!;
  if (b0 >= 0xc2 && b0 <= 0xdf) return tail.length === 1;
  if (b0 >= 0xe0 && b0 <= 0xef) {
    if (tail.length === 1) return true;
    if (tail.length === 2) {
      const b1 = tail[1]!;
      if (b0 === 0xe0) return b1 >= 0xa0 && b1 <= 0xbf;
      if (b0 === 0xed) return b1 >= 0x80 && b1 <= 0x9f;
      return b1 >= 0x80 && b1 <= 0xbf;
    }
    return false;
  }
  if (b0 >= 0xf0 && b0 <= 0xf4) {
    if (tail.length === 1) return true;
    if (tail.length === 2) {
      const b1 = tail[1]!;
      if (b0 === 0xf0) return b1 >= 0x90 && b1 <= 0xbf;
      if (b0 === 0xf4) return b1 >= 0x80 && b1 <= 0x8f;
      return b1 >= 0x80 && b1 <= 0xbf;
    }
    if (tail.length === 3) {
      const b1 = tail[1]!;
      const b2 = tail[2]!;
      if (b0 === 0xf0) return b1 >= 0x90 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf;
      if (b0 === 0xf4) return b1 >= 0x80 && b1 <= 0x8f && b2 >= 0x80 && b2 <= 0xbf;
      return b1 >= 0x80 && b1 <= 0xbf && b2 >= 0x80 && b2 <= 0xbf;
    }
    return false;
  }
  return false;
}

function utf8SafeEnd(contents: Buffer, maxBytes: number): number {
  // Largest UTF-8 character boundary not exceeding maxBytes. Only reached with
  // valid text, so a boundary always exists within the trailing 3 bytes.
  const upper = Math.min(maxBytes, contents.length);
  for (let end = upper; end >= Math.max(0, upper - 3); end -= 1) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(0, end));
      return end;
    } catch { /* try an earlier boundary */ }
  }
  return upper;
}

async function readBounded(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
  openFile: (path: string) => Promise<ReadFileHandle>,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  const handle = await openFile(path);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      abortIfNeeded(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    abortIfNeeded(signal);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

function within(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

interface ReadRecord {
  /** Full served text of the last read at its maxBytes window, LF-normalized. */
  snapshot: string;
  /** Disjoint served line ranges within the snapshot, sorted by start. */
  ranges: Array<[number, number]>;
}

function forceFlag(value: boolean | string | null | undefined): boolean {
  return value === true || value === "true";
}

function rangeCovered(ranges: readonly [number, number][], start: number, end: number): boolean {
  let cursor = start;
  for (const [rangeStart, rangeEnd] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (rangeStart > cursor) break;
    cursor = Math.max(cursor, rangeEnd + 1);
    if (cursor > end) return true;
  }
  return cursor > end;
}

function mergeRange(ranges: readonly [number, number][], start: number, end: number): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const range of [...ranges, [start, end] as [number, number]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last !== undefined && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

interface PatchFile { path: string; created: boolean; hunks: PatchHunk[] }
interface PatchHunk { oldStart: number; newStart: number; lines: string[] }
interface AppliedHunks { content: string; hunks: PatchHunk[] }

const PATCH_SEARCH_RADIUS = 100;

function parsePatch(patch: string): PatchFile[] {
  const lines = patch.replaceAll("\r\n", "\n").split("\n");
  const files: PatchFile[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] === "") { index += 1; continue; }
    if (!lines[index]?.startsWith("--- ")) {
      throw new Error(`Unsupported unified diff metadata or line: ${lines[index]}`);
    }
    const oldPath = patchPath(lines[index]!.slice(4));
    const next = lines[index + 1];
    if (next === undefined || !next.startsWith("+++ ")) throw new Error("Invalid unified diff: missing +++ header");
    const newPath = patchPath(next.slice(4));
    if (newPath === "/dev/null") throw new Error("File deletion patches are not supported");
    if (oldPath !== "/dev/null" && oldPath !== newPath) {
      throw new Error("Patch old and new paths differ; renames are not supported");
    }
    const path = newPath;
    index += 2;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && !lines[index]?.startsWith("--- ")) {
      if (lines[index] === "") { index += 1; continue; }
      const header = lines[index]?.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!header) throw new Error(`Unsupported unified diff metadata or line: ${lines[index]}`);
      const hunk: PatchHunk = { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] };
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("@@ ") && !lines[index]?.startsWith("--- ")) {
        const line = lines[index]!;
        if (line.startsWith("\\ No newline")) throw new Error("No-final-newline markers are not supported");
        if (line !== "" && ![" ", "+", "-"].includes(line[0]!)) throw new Error("Invalid unified diff line");
        if (line === "" && index === lines.length - 1) { index += 1; break; }
        if (line === "") throw new Error("Invalid unified diff line");
        hunk.lines.push(line);
        index += 1;
      }
      // Header counts are advisory: models frequently miscount them. The
      // counts are recomputed implicitly from the body, and application stays
      // safe because it relies on exact unique context matching below.
      hunks.push(hunk);
    }
    if (hunks.length === 0) throw new Error("Invalid unified diff: no hunks");
    files.push({ path, created: oldPath === "/dev/null", hunks });
  }
  if (files.length === 0) throw new Error("Invalid unified diff: no files");
  if (files.length > 1) throw new Error("ApplyPatch supports a single file per call");
  return files;
}

async function requireAbsent(guard: PathGuard, path: string): Promise<string> {
  try {
    await guard.existing(path);
  } catch (error) {
    if (isMissing(error)) return "";
    throw error;
  }
  throw new Error("Patch creation destination already exists");
}

function patchPath(header: string): string {
  const raw = header.split("\t", 1)[0]!.trim();
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

function buildEditDiagnosis(contentsLF: string, oldTextLF: string, first: number, second: number): string {
  let diagnosis = "oldText must match exactly once";
  if (second >= 0) {
    const count = contentsLF.split(oldTextLF).length - 1;
    diagnosis += ` — matched ${count} times in the file`;
    return diagnosis;
  }
  // Find the best partial match: longest line in oldText that appears in the file.
  const oldLines = oldTextLF.split("\n");
  const fileLines = contentsLF.split("\n");
  let bestScore = 0;
  let bestLine = 0;
  let bestMatch = "";
  for (const oldLine of oldLines) {
    const trimmed = oldLine.trim();
    if (trimmed.length < 3) continue;
    for (let i = 0; i < fileLines.length; i++) {
      if (fileLines[i] === oldLine && oldLine.length > bestScore) {
        bestScore = oldLine.length;
        bestLine = i + 1;
        bestMatch = oldLine;
      }
    }
  }
  if (bestScore > 0) {
    const ctxStart = Math.max(0, bestLine - 3);
    const ctxEnd = Math.min(fileLines.length, bestLine + 2);
    const ctx = fileLines.slice(ctxStart, ctxEnd)
      .map((l, i) => `  ${String(ctxStart + i + 1).padStart(4)}: ${l.length > 100 ? l.slice(0, 100) + "…" : l}`).join("\n");
    diagnosis += `\nBest partial match at line ${bestLine}: "${bestMatch.length > 60 ? bestMatch.slice(0, 60) + "…" : bestMatch}"\nNearby context:\n${ctx}`;
  } else {
    // Show first few lines of oldText and file for comparison
    const snippet = oldLines.slice(0, 3).map((l) => `  old: ${l.length > 80 ? l.slice(0, 80) + "…" : l}`).join("\n");
    const fileSnippet = fileLines.slice(0, 5).map((l, i) => `  ${String(i + 1).padStart(4)}: ${l.length > 80 ? l.slice(0, 80) + "…" : l}`).join("\n");
    diagnosis += `\nCould not locate oldText. First lines of oldText:\n${snippet}\nFirst lines of file:\n${fileSnippet}`;
  }
  return diagnosis;
}

function applyHunks(original: string, hunks: readonly PatchHunk[]): AppliedHunks {
  const hasCRLF = original.includes("\r\n");
  const source = original.replace(/\r\n/g, "\n").split("\n");
  if (source.at(-1) === "") source.pop();
  const output: string[] = [];
  const appliedHunks: PatchHunk[] = [];
  let cursor = 0;
  for (const [index, hunk] of hunks.entries()) {
    const declaredTarget = Math.max(0, hunk.oldStart - 1);
    const target = resolveHunkTarget(source, hunk, cursor, index + 1);
    const offset = target - declaredTarget;
    appliedHunks.push({
      ...hunk,
      oldStart: hunk.oldStart === 0 ? 0 : target + 1,
      newStart: hunk.newStart === 0 ? 0 : Math.max(1, hunk.newStart + offset),
    });
    output.push(...source.slice(cursor, target));
    cursor = target;
    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || marker === "-") {
        if (source[cursor] !== text) throw new Error("Patch context does not match the file");
        if (marker === " ") output.push(text);
        cursor += 1;
      } else if (marker === "+") output.push(text);
    }
  }
  output.push(...source.slice(cursor));
  const result = `${output.join("\n")}\n`;
  return {
    content: hasCRLF ? result.replace(/\n/g, "\r\n") : result,
    hunks: appliedHunks,
  };
}

function resolveHunkTarget(
  source: readonly string[],
  hunk: PatchHunk,
  cursor: number,
  hunkNumber: number,
): number {
  const declared = Math.max(0, hunk.oldStart - 1);
  const oldLines = patchSideLines(hunk, "old");
  if (oldLines.length === 0) {
    if (declared < cursor || declared > source.length) {
      throw new Error(`Patch hunk ${hunkNumber} is out of range at declared line ${hunk.oldStart}`);
    }
    return declared;
  }
  if (declared >= cursor && matchesLines(source, declared, oldLines)) return declared;

  const matches = exactMatchesNear(source, oldLines, declared, cursor);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    const lines = matches.map((match) => match + 1).join(", ");
    throw new Error(`Patch hunk ${hunkNumber} is ambiguous near declared line ${hunk.oldStart}; exact context matches at lines ${lines}`);
  }

  const newLines = patchSideLines(hunk, "new");
  const newDeclared = Math.max(0, hunk.newStart - 1);
  const appliedMatches = exactMatchesNear(source, newLines, newDeclared, cursor);
  if (appliedMatches.length === 1) {
    throw new Error(`Patch hunk ${hunkNumber} appears to be already applied at line ${appliedMatches[0]! + 1}`);
  }

  const expected = JSON.stringify(oldLines[0]);
  const actualLine = declared < source.length ? source[declared] : "<end of file>";
  const actual = JSON.stringify(actualLine);
  throw new Error(
    `Patch hunk ${hunkNumber} does not match near declared line ${hunk.oldStart}; expected ${expected}, actual ${actual}`,
  );
}

function patchSideLines(hunk: PatchHunk, side: "old" | "new"): string[] {
  const markers = side === "old" ? new Set([" ", "-"]) : new Set([" ", "+"]);
  return hunk.lines.filter((line) => markers.has(line[0]!)).map((line) => line.slice(1));
}

function exactMatchesNear(
  source: readonly string[],
  expected: readonly string[],
  declared: number,
  cursor: number,
): number[] {
  if (expected.length === 0 || source.length < expected.length) return [];
  const first = Math.max(cursor, 0, declared - PATCH_SEARCH_RADIUS);
  const last = Math.min(source.length - expected.length, declared + PATCH_SEARCH_RADIUS);
  const matches: number[] = [];
  for (let start = first; start <= last; start += 1) {
    if (matchesLines(source, start, expected)) matches.push(start);
  }
  return matches;
}

function matchesLines(source: readonly string[], start: number, expected: readonly string[]): boolean {
  return start >= 0
    && start + expected.length <= source.length
    && expected.every((line, index) => source[start + index] === line);
}
