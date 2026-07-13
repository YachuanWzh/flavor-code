import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

export const MAX_READ_BYTES = 1_048_576;

const ReadInput = z.object({
  path: z.string().min(1),
  maxBytes: z.number().int().positive().max(MAX_READ_BYTES).nullable().optional(),
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
}

export function createReadTool(workspace: string, options: ReadToolOptions = {}): ToolDefinition<z.infer<typeof ReadInput>> {
  const guard = createPathGuard(workspace);
  const openFile = options.openFile ?? ((path: string) => open(path, constants.O_RDONLY));
  return {
    name: "Read",
    description: "Read a UTF-8 text file",
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
      const contents = await readBounded(path, maxBytes, signal, openFile);
      if (isBinary(contents)) throw new Error("Cannot read binary file as text");
      const text = contents.toString("utf8");
      if (text.length > maxBytes) {
        const truncated = text.slice(0, maxBytes);
        return `[Truncated to ${maxBytes} bytes. File is ${info.size} bytes total. Request a higher maxBytes or read a specific range.]\n\n${truncated}`;
      }
      return text;
    },
  };
}

export function createWriteTool(workspace: string): ToolDefinition<z.infer<typeof WriteInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "Write",
    description: "Create or atomically replace a text file",
    inputSchema: WriteInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.destination(input.path);
      await atomicWrite(path, input.content, signal);
      return { path, bytes: Buffer.byteLength(input.content) };
    },
  };
}

export function createEditTool(workspace: string): ToolDefinition<z.infer<typeof EditInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "Edit",
    description: "Replace one unique exact text match",
    inputSchema: EditInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.existing(input.path);
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
      await atomicWrite(path, updated, signal);
      return { path, replacements: 1 };
    },
  };
}

export function createApplyPatchTool(workspace: string): ToolDefinition<z.infer<typeof ApplyPatchInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "ApplyPatch",
    description: "Apply a workspace-limited unified diff",
    inputSchema: ApplyPatchInput,
    paths: (input) => parsePatch(input.patch).map((file) => guard.lexical(file.path)),
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const changes = parsePatch(input.patch);
      const prepared: Array<{ path: string; content: string }> = [];
      for (const change of changes) {
        const path = await guard.destination(change.path);
        const original = change.created
          ? await requireAbsent(guard, change.path)
          : await readText(await guard.existing(change.path));
        prepared.push({ path, content: applyHunks(original, change.hunks) });
      }
      for (const change of prepared) await atomicWrite(change.path, change.content, signal);
      return { files: prepared.map((change) => change.path) };
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

async function atomicWrite(path: string, content: string, signal: AbortSignal): Promise<void> {
  abortIfNeeded(signal);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await handle.writeFile(content, "utf8"); await handle.sync(); }
    finally { await handle.close(); }
    abortIfNeeded(signal);
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

function isBinary(contents: Buffer): boolean {
  if (contents.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contents);
    return false;
  } catch {
    return true;
  }
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

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

interface PatchFile { path: string; created: boolean; hunks: PatchHunk[] }
interface PatchHunk { oldStart: number; lines: string[] }

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
      const hunk: PatchHunk = { oldStart: Number(header[1]), lines: [] };
      const expectedOld = header[2] === undefined ? 1 : Number(header[2]);
      const expectedNew = header[4] === undefined ? 1 : Number(header[4]);
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
      const actualOld = hunk.lines.filter((line) => line[0] === " " || line[0] === "-").length;
      const actualNew = hunk.lines.filter((line) => line[0] === " " || line[0] === "+").length;
      if (actualOld !== expectedOld || actualNew !== expectedNew) {
        throw new Error(`Patch hunk count mismatch: expected ${expectedOld}/${expectedNew}, received ${actualOld}/${actualNew}`);
      }
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

function applyHunks(original: string, hunks: readonly PatchHunk[]): string {
  const hasCRLF = original.includes("\r\n");
  const source = original.replace(/\r\n/g, "\n").split("\n");
  if (source.at(-1) === "") source.pop();
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const target = Math.max(0, hunk.oldStart - 1);
    if (target < cursor || target > source.length) throw new Error("Patch hunk is out of range");
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
  return hasCRLF ? result.replace(/\n/g, "\r\n") : result;
}
