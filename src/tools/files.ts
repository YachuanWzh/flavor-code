import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

const ReadInput = z.object({ path: z.string().min(1), maxBytes: z.number().int().positive().optional() });
const WriteInput = z.object({ path: z.string().min(1), content: z.string() });
const EditInput = z.object({ path: z.string().min(1), oldText: z.string().min(1), newText: z.string() });
const ApplyPatchInput = z.object({ patch: z.string().min(1) });

const DEFAULT_MAX_READ_BYTES = 1_048_576;

export function createReadTool(workspace: string): ToolDefinition<z.infer<typeof ReadInput>> {
  const guard = createPathGuard(workspace);
  return {
    name: "Read",
    description: "Read a UTF-8 text file",
    inputSchema: ReadInput,
    paths: (input) => [guard.lexical(input.path)],
    execute: async (input, signal) => {
      abortIfNeeded(signal);
      const path = await guard.existing(input.path);
      const info = await stat(path);
      const maxBytes = input.maxBytes ?? DEFAULT_MAX_READ_BYTES;
      if (info.size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte read limit`);
      const contents = await readFile(path);
      abortIfNeeded(signal);
      if (isBinary(contents)) throw new Error("Cannot read binary file as text");
      return contents.toString("utf8");
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
      const first = contents.indexOf(input.oldText);
      const second = first < 0 ? -1 : contents.indexOf(input.oldText, first + input.oldText.length);
      if (first < 0 || second >= 0) throw new Error("oldText must match exactly once");
      const updated = contents.slice(0, first) + input.newText + contents.slice(first + input.oldText.length);
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
        let original = "";
        try { original = await readText(await guard.existing(change.path)); }
        catch (error) {
          if (!change.created) throw error;
        }
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
  const sample = contents.subarray(0, Math.min(contents.length, 8_000));
  if (sample.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample);
    return false;
  } catch {
    return true;
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
    if (!lines[index]?.startsWith("--- ")) { index += 1; continue; }
    const oldPath = patchPath(lines[index]!.slice(4));
    const next = lines[index + 1];
    if (next === undefined || !next.startsWith("+++ ")) throw new Error("Invalid unified diff: missing +++ header");
    const newPath = patchPath(next.slice(4));
    const path = newPath === "/dev/null" ? oldPath : newPath;
    if (path === "/dev/null") throw new Error("Invalid unified diff path");
    index += 2;
    const hunks: PatchHunk[] = [];
    while (index < lines.length && !lines[index]?.startsWith("--- ")) {
      const header = lines[index]?.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
      if (!header) { index += 1; continue; }
      const hunk: PatchHunk = { oldStart: Number(header[1]), lines: [] };
      index += 1;
      while (index < lines.length && !lines[index]?.startsWith("@@ ") && !lines[index]?.startsWith("--- ")) {
        const line = lines[index]!;
        if (line.startsWith("\\ No newline")) { index += 1; continue; }
        if (line !== "" && ![" ", "+", "-"].includes(line[0]!)) throw new Error("Invalid unified diff line");
        if (line === "" && index === lines.length - 1) { index += 1; break; }
        hunk.lines.push(line);
        index += 1;
      }
      hunks.push(hunk);
    }
    if (hunks.length === 0) throw new Error("Invalid unified diff: no hunks");
    files.push({ path, created: oldPath === "/dev/null", hunks });
  }
  if (files.length === 0) throw new Error("Invalid unified diff: no files");
  return files;
}

function patchPath(header: string): string {
  const raw = header.split("\t", 1)[0]!.trim();
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

function applyHunks(original: string, hunks: readonly PatchHunk[]): string {
  const source = original.split("\n");
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
  return `${output.join("\n")}\n`;
}
