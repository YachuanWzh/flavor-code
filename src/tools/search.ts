import { spawn } from "node:child_process";
import { open, opendir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import createIgnore from "ignore";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

const DEFAULT_RESULT_LIMIT = 1_000;
const DEFAULT_MAX_FILE_BYTES = 1_048_576;
const DEFAULT_MAX_SEARCH_BYTES = 16_777_216;
const DEFAULT_MAX_DIRECTORY_ENTRIES = 50_000;
const DEFAULT_MAX_DISCOVERED_FILES = 100_000;

const GlobInput = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  limit: z.number().int().positive().max(100_000).optional(),
});

const GrepInput = z.object({
  pattern: z.string().min(1),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  type: z.string().min(1).optional(),
  context: z.number().int().nonnegative().max(100).optional(),
  limit: z.number().int().positive().max(100_000).optional(),
});

export interface SearchToolOptions {
  forceNode?: boolean;
  rgPath?: string;
  rgArgsPrefix?: string[];
  defaultLimit?: number;
  maxFileBytes?: number;
  maxSearchBytes?: number;
  maxDirectoryEntries?: number;
}

export interface SearchResult<T> {
  matches: T[];
  truncated: boolean;
}

export interface GrepMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
}

export function createGlobTool(
  workspace: string,
  options: SearchToolOptions = {},
): ToolDefinition<z.infer<typeof GlobInput>> {
  const root = resolve(workspace);
  return {
    name: "Glob",
    description: "Find workspace files matching a glob",
    inputSchema: GlobInput,
    paths: (input) => [scope(root, input.path)],
    execute: async (input, signal) => {
      const limit = input.limit ?? options.defaultLimit ?? DEFAULT_RESULT_LIMIT;
      const start = scope(root, input.path);
      const matcher = globRegex(input.pattern);
      const directoryCap = options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES;
      let paths: string[];
      if (options.forceNode === true) {
        paths = await nodeFiles(root, start, signal, (path) => matcher.test(path), limit + 1, directoryCap);
      } else {
        try {
          paths = await rgFiles(root, start, input.pattern, signal, options.rgPath ?? bundledRgPath, options.rgArgsPrefix ?? [], limit + 1, options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES, directoryCap);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (!(error instanceof SearchSpawnError) || !error.fallbackSafe) throw error;
          paths = await nodeFiles(root, start, signal, (path) => matcher.test(path), limit + 1, directoryCap);
        }
      }
      const matches = paths.filter((path) => matcher.test(path)).sort(comparePaths);
      return { matches: matches.slice(0, limit), truncated: matches.length > limit };
    },
  };
}

export function createGrepTool(
  workspace: string,
  options: SearchToolOptions = {},
): ToolDefinition<z.infer<typeof GrepInput>> {
  const root = resolve(workspace);
  return {
    name: "Grep",
    description: "Search workspace text with a regular expression",
    inputSchema: GrepInput,
    paths: (input) => [scope(root, input.path)],
    execute: async (input, signal) => {
      // Compile eagerly so both backends report invalid expressions consistently.
      const expression = new RegExp(input.pattern);
      const limit = input.limit ?? options.defaultLimit ?? DEFAULT_RESULT_LIMIT;
      const context = input.context ?? 0;
      const start = scope(root, input.path);
      let matches: GrepMatch[];
      if (options.forceNode === true) {
        matches = await nodeGrep(root, start, input.glob, input.type, expression, context, signal, limit + 1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES, options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES);
      } else {
        try {
          matches = await rgGrep(root, start, input, context, signal, options.rgPath ?? bundledRgPath, options.rgArgsPrefix ?? [], limit + 1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES, options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          if (!(error instanceof SearchSpawnError) || !error.fallbackSafe) throw error;
          matches = await nodeGrep(root, start, input.glob, input.type, expression, context, signal, limit + 1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES, options.maxSearchBytes ?? DEFAULT_MAX_SEARCH_BYTES, options.maxDirectoryEntries ?? DEFAULT_MAX_DIRECTORY_ENTRIES);
        }
      }
      matches.sort((a, b) => comparePaths(a.path, b.path) || a.line - b.line || a.column - b.column);
      return { matches: matches.slice(0, limit), truncated: matches.length > limit };
    },
  };
}

async function rgFiles(
  root: string, start: string, pattern: string, signal: AbortSignal, executable: string, argsPrefix: string[], limit: number, maxBytes: number, maxDirectoryEntries: number,
): Promise<string[]> {
  const target = relative(root, start) || ".";
  const matcher = globRegex(pattern);
  const ignoreLayers = await collectIgnoreLayers(root, start, signal, maxDirectoryEntries);
  const paths: string[] = [];
  const parser = delimitedParser(0, (record) => {
    if (record.length === 0) return true;
    const path = normalizedRelative(root, resolve(root, decodeUtf8(record, "ripgrep path")));
    if (!matcher.test(path) || ignored(path, false, ignoreLayers)) return true;
    paths.push(path);
    return paths.length < limit;
  });
  const output = await runStreaming(executable, [...argsPrefix, "--files", "--null", "--sort", "path", "--hidden", "--glob", "!.git", "--glob", pattern, "--", target], root, signal, maxBytes, parser);
  if (!output.stoppedEarly && output.code !== 0) throw new Error(output.stderr || `ripgrep exited with ${output.code}`);
  parser.finish();
  return paths;
}

async function rgGrep(
  root: string,
  start: string,
  input: z.infer<typeof GrepInput>,
  context: number,
  signal: AbortSignal,
  executable: string,
  argsPrefix: string[],
  limit: number,
  maxFileBytes: number,
  maxBytes: number,
  maxDirectoryEntries: number,
): Promise<GrepMatch[]> {
  const args = ["--json", "--line-number", "--column", "--sort", "path", "--hidden", "--glob", "!.git", "--max-filesize", String(maxFileBytes), "--context", String(context)];
  if (input.glob !== undefined) args.push("--glob", input.glob);
  if (input.type !== undefined) args.push("--type", input.type);
  args.push("--regexp", input.pattern, "--", relative(root, start) || ".");
  const matches: GrepMatch[] = [];
  const ignoreLayers = await collectIgnoreLayers(root, start, signal, maxDirectoryEntries);
  const parser = delimitedParser(10, (record) => {
    if (record.length === 0) return true;
    const event = JSON.parse(decodeUtf8(record, "ripgrep JSON")) as RgEvent;
    if (event.type !== "match") return true;
    const pathValue = rgBytes(event.data.path);
    const lineValue = rgBytes(event.data.lines);
    if (pathValue === undefined || lineValue === undefined || lineValue.includes(0)) return true;
    const decodedPath = tryDecodeUtf8(pathValue);
    const lineWithEnding = tryDecodeUtf8(lineValue);
    if (decodedPath === undefined || lineWithEnding === undefined) return true;
    const path = normalizePath(decodedPath).replace(/^\.\//, "");
    if (ignored(path, false, ignoreLayers)) return true;
    const text = lineWithEnding.replace(/\r?\n$/, "");
    const startByte = event.data.submatches?.[0]?.start ?? 0;
    const prefix = lineValue.subarray(0, Math.min(startByte, lineValue.length));
    matches.push({
      path,
      line: event.data.line_number,
      column: decodeUtf8(prefix, "ripgrep match prefix").length + 1,
      text,
      before: [],
      after: [],
    });
    return matches.length < limit;
  });
  const output = await runStreaming(executable, [...argsPrefix, ...args], root, signal, maxBytes, parser);
  if (!output.stoppedEarly && output.code !== 0 && output.code !== 1) throw new Error(output.stderr || `ripgrep exited with ${output.code}`);
  parser.finish();
  await hydrateContext(root, matches, context, signal, maxFileBytes, maxBytes);
  return matches;
}

async function hydrateContext(root: string, matches: GrepMatch[], context: number, signal: AbortSignal, maxFileBytes: number, maxTotalBytes: number): Promise<void> {
  if (context === 0) return;
  const byPath = new Map<string, GrepMatch[]>();
  for (const match of matches) byPath.set(match.path, [...(byPath.get(match.path) ?? []), match]);
  let totalBytes = 0;
  for (const [path, pathMatches] of byPath) {
    abort(signal);
    const absolute = resolve(root, path);
    const contents = await readBoundedFile(absolute, maxFileBytes, signal);
    if (contents === undefined) continue;
    totalBytes += contents.length;
    if (totalBytes > maxTotalBytes) throw new Error(`Search context exceeded the ${maxTotalBytes} byte limit`);
    const lines = contents.toString("utf8").replaceAll("\r\n", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const match of pathMatches) {
      const index = match.line - 1;
      match.before = lines.slice(Math.max(0, index - context), index);
      match.after = lines.slice(index + 1, index + 1 + context);
    }
  }
}

interface RgEvent {
  type: "match" | "context" | string;
  data: {
    path: RgText;
    lines: RgText;
    line_number: number;
    submatches?: Array<{ start: number }>;
  };
}

interface RgText { text?: string; bytes?: string }

async function nodeGrep(
  root: string,
  start: string,
  glob: string | undefined,
  type: string | undefined,
  expression: RegExp,
  context: number,
  signal: AbortSignal,
  maxMatches: number,
  maxFileBytes: number,
  maxSearchBytes: number,
  maxDirectoryEntries: number,
): Promise<GrepMatch[]> {
  const files = await nodeFiles(root, start, signal, () => true, DEFAULT_MAX_DISCOVERED_FILES + 1, maxDirectoryEntries);
  if (files.length > DEFAULT_MAX_DISCOVERED_FILES) throw new Error(`File discovery limit of ${DEFAULT_MAX_DISCOVERED_FILES} exceeded`);
  const matcher = glob === undefined ? undefined : globRegex(glob);
  const extension = type === undefined ? undefined : typeExtension(type);
  if (type !== undefined && extension === undefined) throw new Error(`Unsupported file type: ${type}`);
  const matches: GrepMatch[] = [];
  let searchedBytes = 0;
  for (const path of files.sort(comparePaths)) {
    abort(signal);
    if (searchedBytes >= maxSearchBytes) break;
    if (matcher !== undefined && !matcher.test(path)) continue;
    if (extension !== undefined && !extension.some((suffix) => path.endsWith(suffix))) continue;
    const absolute = resolve(root, path);
    const bytes = await readBoundedFile(absolute, Math.min(maxFileBytes, maxSearchBytes - searchedBytes), signal);
    if (bytes === undefined) continue;
    searchedBytes += bytes.length;
    if (bytes.includes(0)) continue;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { continue; }
    const lines = content.replaceAll("\r\n", "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (let index = 0; index < lines.length; index += 1) {
      expression.lastIndex = 0;
      const found = expression.exec(lines[index]!);
      if (found === null) continue;
      matches.push({
        path,
        line: index + 1,
        column: found.index + 1,
        text: lines[index]!,
        before: lines.slice(Math.max(0, index - context), index),
        after: lines.slice(index + 1, index + 1 + context),
      });
      if (matches.length >= maxMatches) return matches;
    }
  }
  return matches;
}

async function nodeFiles(
  root: string,
  start: string,
  signal: AbortSignal,
  accept: (path: string) => boolean = () => true,
  limit = Number.POSITIVE_INFINITY,
  maxDirectoryEntries = DEFAULT_MAX_DIRECTORY_ENTRIES,
): Promise<string[]> {
  const ignores: IgnoreLayer[] = [];
  const output: string[] = [];
  const delta = relative(root, start);
  const segments = delta === "" ? [] : delta.split(sep);
  let ancestor = root;
  for (let index = 0; index < segments.length; index += 1) {
    await loadIgnoreFiles(ancestor, normalizedRelative(root, ancestor), ignores);
    ancestor = resolve(ancestor, segments[index]!);
  }
  async function walk(directory: string): Promise<void> {
    abort(signal);
    const relativeDirectory = normalizedRelative(root, directory);
    const ruleCount = ignores.length;
    await loadIgnoreFiles(directory, relativeDirectory, ignores);
    const handle = await opendir(directory);
    const entries = [];
    for await (const entry of handle) {
      entries.push(entry);
      if (entries.length > maxDirectoryEntries) throw new Error(`Directory entry limit of ${maxDirectoryEntries} exceeded: ${relativeDirectory}`);
    }
    entries.sort((a, b) => comparePaths(a.isDirectory() ? `${a.name}/` : a.name, b.isDirectory() ? `${b.name}/` : b.name));
    for (const entry of entries) {
      abort(signal);
      const absolute = resolve(directory, entry.name);
      const path = normalizedRelative(root, absolute);
      if (entry.name === ".git" || ignored(path, entry.isDirectory(), ignores)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && accept(path)) output.push(path);
      if (output.length >= limit) break;
    }
    ignores.length = ruleCount;
  }
  await walk(start);
  return output;
}

async function collectIgnoreLayers(
  root: string,
  start: string,
  signal: AbortSignal,
  maxDirectoryEntries: number,
): Promise<IgnoreLayer[]> {
  const layers: IgnoreLayer[] = [];
  const delta = relative(root, start);
  const segments = delta === "" ? [] : delta.split(sep);
  let ancestor = root;
  for (let index = 0; index < segments.length; index += 1) {
    await loadIgnoreFiles(ancestor, normalizedRelative(root, ancestor), layers);
    ancestor = resolve(ancestor, segments[index]!);
  }
  async function walk(directory: string): Promise<void> {
    abort(signal);
    const relativeDirectory = normalizedRelative(root, directory);
    await loadIgnoreFiles(directory, relativeDirectory, layers);
    const handle = await opendir(directory);
    let count = 0;
    for await (const entry of handle) {
      count += 1;
      if (count > maxDirectoryEntries) throw new Error(`Directory entry limit of ${maxDirectoryEntries} exceeded: ${relativeDirectory}`);
      if (!entry.isDirectory() || entry.name === ".git") continue;
      const absolute = resolve(directory, entry.name);
      const path = normalizedRelative(root, absolute);
      if (!ignored(path, true, layers)) await walk(absolute);
    }
  }
  await walk(start);
  return layers;
}

async function loadIgnoreFiles(directory: string, base: string, rules: IgnoreLayer[]): Promise<void> {
  for (const name of [".gitignore", ".ignore"]) {
    try {
      const ignoreText = await readFile(resolve(directory, name), "utf8");
      rules.push({ base, matcher: createIgnore().add(ignoreText) });
    } catch {
      // A directory without an ignore file has no additional local rules.
    }
  }
}

interface IgnoreLayer { base: string; matcher: ReturnType<typeof createIgnore> }

function ignored(path: string, directory: boolean, rules: readonly IgnoreLayer[]): boolean {
  let result = false;
  for (const rule of rules) {
    const scoped = relativeIgnorePath(rule.base, path);
    if (scoped === undefined || scoped === "") continue;
    const decision = rule.matcher.test(directory ? `${scoped}/` : scoped);
    if (decision.ignored) result = true;
    else if (decision.unignored) result = false;
  }
  return result;
}

function relativeIgnorePath(base: string, path: string): string | undefined {
  if (base === "" || base === ".") return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : undefined;
}

function globRegex(pattern: string): RegExp {
  return new RegExp(`^(?:${expandBraces(pattern).map(globSource).join("|")})$`);
}

function globSource(pattern: string): string {
  const normalized = normalizePath(pattern).replace(/^\.\//, "");
  let source = "";
  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i]!;
    if (char === "*") {
      if (normalized[i + 1] === "*") {
        i += 1;
        if (normalized[i + 1] === "/") { i += 1; source += "(?:.*/)?"; }
        else source += ".*";
      } else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else if (char === "[") {
      const end = normalized.indexOf("]", i + 1);
      if (end < 0) source += "\\[";
      else { source += normalized.slice(i, end + 1); i = end; }
    } else source += /[\\^$+.()|{}]/.test(char) ? `\\${char}` : char;
  }
  return source;
}

function expandBraces(pattern: string): string[] {
  const open = pattern.indexOf("{");
  if (open < 0) return [pattern];
  const close = pattern.indexOf("}", open + 1);
  if (close < 0) return [pattern];
  const choices = pattern.slice(open + 1, close).split(",");
  if (choices.length < 2) return [pattern];
  return choices.flatMap((choice) => expandBraces(pattern.slice(0, open) + choice + pattern.slice(close + 1)));
}

function typeExtension(type: string): string[] | undefined {
  return ({
    c: [".c", ".h"], cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], cs: [".cs"],
    css: [".css"], dart: [".dart"], go: [".go"], html: [".htm", ".html"], java: [".java"], js: [".js", ".jsx", ".mjs", ".cjs"],
    json: [".json", ".jsonc"], kotlin: [".kt", ".kts"], lua: [".lua"], md: [".md", ".markdown", ".mdx"], php: [".php"], py: [".py", ".pyi"],
    ruby: [".rb"], rust: [".rs"], sh: [".sh", ".bash", ".zsh", ".fish"], sql: [".sql"], swift: [".swift"],
    text: [".txt"], toml: [".toml"], ts: [".ts", ".tsx", ".mts", ".cts"], xml: [".xml"], yaml: [".yaml", ".yml"],
    javascript: [".js", ".jsx", ".mjs", ".cjs"], markdown: [".md", ".markdown", ".mdx"],
    python: [".py", ".pyi"], typescript: [".ts", ".tsx", ".mts", ".cts"],
  } as Record<string, string[]>)[type];
}

function scope(root: string, path = "."): string {
  const candidate = resolve(root, path);
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Path is outside the workspace");
  return candidate;
}

function normalizedRelative(root: string, path: string): string {
  const value = normalizePath(relative(root, path));
  return value === "" ? "." : value;
}

function normalizePath(path: string): string { return path.replaceAll("\\", "/"); }
function comparePaths(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function abort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }

interface StreamParser { push(chunk: Buffer): boolean; finish(): void }

class SearchSpawnError extends Error {
  constructor(message: string, readonly fallbackSafe: boolean) { super(message); }
}

function delimitedParser(delimiter: number, onRecord: (record: Buffer) => boolean): StreamParser {
  let pending: Buffer = Buffer.alloc(0);
  let stopped = false;
  return {
    push(chunk) {
      if (stopped) return false;
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      let offset = 0;
      while (true) {
        const end = pending.indexOf(delimiter, offset);
        if (end < 0) break;
        if (!onRecord(pending.subarray(offset, end))) { stopped = true; return false; }
        offset = end + 1;
      }
      pending = pending.subarray(offset);
      return true;
    },
    finish() {
      if (!stopped && pending.length > 0) onRecord(pending);
      pending = Buffer.alloc(0);
    },
  };
}

function runStreaming(
  executable: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  maxBytes: number,
  parser: StreamParser,
): Promise<{ code: number | null; stderr: string; stoppedEarly: boolean }> {
  return new Promise((resolvePromise, reject) => {
    abort(signal);
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stderr = Buffer.alloc(0);
    let observedOutput = false;
    let stoppedEarly = false;
    let parseError: Error | undefined;
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      observedOutput = true;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) {
        parseError = new Error(`ripgrep output exceeded the ${maxBytes} byte search limit`);
        child.kill();
        return;
      }
      try {
        if (!parser.push(chunk)) { stoppedEarly = true; child.kill(); }
      } catch (error) {
        parseError = error instanceof Error ? error : new Error(String(error));
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      observedOutput = true;
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr = Buffer.concat([stderr, chunk]);
      else { parseError = new Error(`ripgrep stderr exceeded the ${maxBytes} byte search limit`); child.kill(); }
    });
    child.once("error", (error) => reject(new SearchSpawnError(error.message, !observedOutput)));
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else if (parseError !== undefined) reject(parseError);
      else resolvePromise({ code, stderr: stderr.toString("utf8"), stoppedEarly });
    });
  });
}

function rgBytes(value: RgText): Buffer | undefined {
  if (value.text !== undefined) return Buffer.from(value.text);
  if (value.bytes !== undefined) {
    if (!isStrictBase64(value.bytes)) throw new Error("ripgrep bytes payload is malformed base64");
    return Buffer.from(value.bytes, "base64");
  }
  return undefined;
}

function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

function decodeUtf8(value: Buffer, label: string): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { throw new Error(`${label} is not valid UTF-8`); }
}

function tryDecodeUtf8(value: Buffer): string | undefined {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
  catch { return undefined; }
}

async function readBoundedFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Buffer | undefined> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) return undefined;
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(path, "r"); }
  catch { return undefined; }
  const buffer = Buffer.allocUnsafe(maxBytes + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      abort(signal);
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  } finally {
    await handle.close();
  }
  return offset > maxBytes ? undefined : buffer.subarray(0, offset);
}
