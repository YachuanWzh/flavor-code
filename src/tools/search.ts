import { spawn } from "node:child_process";
import { opendir, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { rgPath as bundledRgPath } from "@vscode/ripgrep";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";

const DEFAULT_RESULT_LIMIT = 1_000;

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
  defaultLimit?: number;
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
      let paths: string[];
      if (options.forceNode === true) {
        paths = await nodeFiles(root, start, signal);
      } else {
        try {
          paths = await rgFiles(root, start, input.pattern, signal, options.rgPath ?? bundledRgPath);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          paths = await nodeFiles(root, start, signal);
        }
      }
      const matcher = globRegex(input.pattern);
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
        matches = await nodeGrep(root, start, input.glob, input.type, expression, context, signal);
      } else {
        try {
          matches = await rgGrep(root, start, input, context, signal, options.rgPath ?? bundledRgPath);
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          matches = await nodeGrep(root, start, input.glob, input.type, expression, context, signal);
        }
      }
      matches.sort((a, b) => comparePaths(a.path, b.path) || a.line - b.line || a.column - b.column);
      return { matches: matches.slice(0, limit), truncated: matches.length > limit };
    },
  };
}

async function rgFiles(root: string, start: string, pattern: string, signal: AbortSignal, executable: string): Promise<string[]> {
  const target = relative(root, start) || ".";
  const globs = expandBraces(pattern).flatMap((value) => ["--glob", value]);
  const output = await run(executable, ["--files", "--null", ...globs, "--", target], root, signal);
  if (output.code !== 0) throw new Error(output.stderr || `ripgrep exited with ${output.code}`);
  return output.stdout.split("\0").filter(Boolean).map((path) => normalizedRelative(root, resolve(root, path)));
}

async function rgGrep(
  root: string,
  start: string,
  input: z.infer<typeof GrepInput>,
  context: number,
  signal: AbortSignal,
  executable: string,
): Promise<GrepMatch[]> {
  const args = ["--json", "--line-number", "--column", "--context", String(context)];
  if (input.glob !== undefined) {
    for (const glob of expandBraces(input.glob)) args.push("--glob", glob);
  }
  if (input.type !== undefined) args.push("--type", input.type);
  args.push("--regexp", input.pattern, "--", relative(root, start) || ".");
  const output = await run(executable, args, root, signal);
  if (output.code !== 0 && output.code !== 1) throw new Error(output.stderr || `ripgrep exited with ${output.code}`);

  const matches: GrepMatch[] = [];
  for (const raw of output.stdout.split("\n")) {
    if (raw === "") continue;
    const event = JSON.parse(raw) as RgEvent;
    if (event.type !== "match") continue;
    const path = normalizePath(event.data.path.text).replace(/^\.\//, "");
    const text = event.data.lines.text.replace(/\r?\n$/, "");
    const startByte = event.data.submatches?.[0]?.start ?? 0;
    matches.push({
      path,
      line: event.data.line_number,
      column: Buffer.from(text).subarray(0, startByte).toString("utf8").length + 1,
      text,
      before: [],
      after: [],
    });
  }
  await hydrateContext(root, matches, context, signal);
  return matches;
}

async function hydrateContext(root: string, matches: GrepMatch[], context: number, signal: AbortSignal): Promise<void> {
  if (context === 0) return;
  const byPath = new Map<string, GrepMatch[]>();
  for (const match of matches) byPath.set(match.path, [...(byPath.get(match.path) ?? []), match]);
  for (const [path, pathMatches] of byPath) {
    abort(signal);
    const lines = (await readFile(resolve(root, path), "utf8")).replaceAll("\r\n", "\n").split("\n");
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
    path: { text: string };
    lines: { text: string };
    line_number: number;
    submatches?: Array<{ start: number }>;
  };
}

async function nodeGrep(
  root: string,
  start: string,
  glob: string | undefined,
  type: string | undefined,
  expression: RegExp,
  context: number,
  signal: AbortSignal,
): Promise<GrepMatch[]> {
  const files = await nodeFiles(root, start, signal);
  const matcher = glob === undefined ? undefined : globRegex(glob);
  const extension = type === undefined ? undefined : typeExtension(type);
  const matches: GrepMatch[] = [];
  for (const path of files.sort(comparePaths)) {
    abort(signal);
    if (matcher !== undefined && !matcher.test(path)) continue;
    if (extension !== undefined && !extension.some((suffix) => path.endsWith(suffix))) continue;
    let content: string;
    try { content = await readFile(resolve(root, path), "utf8"); }
    catch { continue; }
    if (content.includes("\0")) continue;
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
    }
  }
  return matches;
}

async function nodeFiles(root: string, start: string, signal: AbortSignal): Promise<string[]> {
  const ignores: IgnoreRule[] = [];
  const output: string[] = [];
  const delta = relative(root, start);
  const segments = delta === "" ? [] : delta.split(sep);
  let ancestor = root;
  for (let index = 0; index < segments.length; index += 1) {
    await loadIgnoreFile(ancestor, normalizedRelative(root, ancestor), ignores);
    ancestor = resolve(ancestor, segments[index]!);
  }
  async function walk(directory: string): Promise<void> {
    abort(signal);
    const relativeDirectory = normalizedRelative(root, directory);
    await loadIgnoreFile(directory, relativeDirectory, ignores);
    const handle = await opendir(directory);
    for await (const entry of handle) {
      abort(signal);
      const absolute = resolve(directory, entry.name);
      const path = normalizedRelative(root, absolute);
      if (entry.name === ".git" || ignored(path, entry.isDirectory(), ignores)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) output.push(path);
    }
  }
  await walk(start);
  return output;
}

async function loadIgnoreFile(directory: string, base: string, rules: IgnoreRule[]): Promise<void> {
  try {
    const ignoreText = await readFile(resolve(directory, ".gitignore"), "utf8");
    rules.push(...parseIgnores(ignoreText, base));
  } catch {
    // A directory without an ignore file has no additional local rules.
  }
}

interface IgnoreRule { negative: boolean; directoryOnly: boolean; regex: RegExp }

function parseIgnores(contents: string, base: string): IgnoreRule[] {
  return contents.replaceAll("\r\n", "\n").split("\n").flatMap((raw) => {
    if (raw === "" || raw.startsWith("#")) return [];
    const negative = raw.startsWith("!");
    const pattern = negative ? raw.slice(1) : raw;
    const directoryOnly = pattern.endsWith("/");
    const clean = directoryOnly ? pattern.slice(0, -1) : pattern;
    const rooted = clean.startsWith("/") ? clean.slice(1) : clean;
    const relativePattern = clean.includes("/") ? joinPath(base, rooted) : joinPath(base, `**/${rooted}`);
    return [{ negative, directoryOnly, regex: globRegex(relativePattern) }];
  });
}

function ignored(path: string, directory: boolean, rules: readonly IgnoreRule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if ((!rule.directoryOnly || directory) && rule.regex.test(path)) result = !rule.negative;
  }
  return result;
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
    css: [".css"], go: [".go"], html: [".htm", ".html"], java: [".java"], js: [".js", ".jsx", ".mjs", ".cjs"],
    json: [".json"], kotlin: [".kt", ".kts"], md: [".md", ".markdown"], php: [".php"], py: [".py"],
    ruby: [".rb"], rust: [".rs"], sh: [".sh", ".bash", ".zsh", ".fish"], sql: [".sql"], swift: [".swift"],
    toml: [".toml"], ts: [".ts", ".tsx"], xml: [".xml"], yaml: [".yaml", ".yml"],
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
function joinPath(left: string, right: string): string { return [left, right].filter((part) => part !== "" && part !== ".").join("/"); }
function comparePaths(a: string, b: string): number { return a.localeCompare(b, "en"); }
function abort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason; }

function run(executable: string, args: string[], cwd: string, signal: AbortSignal): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    abort(signal);
    const child = spawn(executable, args, { cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      if (signal.aborted) reject(signal.reason);
      else resolvePromise({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}
