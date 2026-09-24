import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { updatePlainTextFile } from "../config/protected-file.js";

/** User-maintained rules; only explicit /global commands write this file. */
export class GlobalInstructions {
  static readonly MAX_BYTES = 64 * 1024;
  static readonly MAX_RULE_BYTES = 4 * 1024;

  readonly path: string;
  #content: string | undefined;

  constructor(home: string) {
    this.path = join(home, ".flavor-code", "GLOBAL.md");
  }

  get content(): string | undefined { return this.#content; }

  async refresh(): Promise<void> {
    let info;
    try { info = await lstat(this.path); }
    catch (error) {
      if (isMissing(error)) { this.#content = undefined; return; }
      throw error;
    }
    if (!info.isFile()) throw new Error(`Global instructions must be a regular file: ${this.path}`);
    if (info.size > GlobalInstructions.MAX_BYTES) {
      throw new Error(`Global instructions exceed ${GlobalInstructions.MAX_BYTES} bytes: ${this.path}`);
    }
    const bytes = await readFile(this.path);
    if (bytes.length > GlobalInstructions.MAX_BYTES) {
      throw new Error(`Global instructions exceed ${GlobalInstructions.MAX_BYTES} bytes: ${this.path}`);
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
    this.#content = content || undefined;
  }

  async remember(input: string): Promise<"added" | "already-present"> {
    const rule = input.trim();
    if (!rule || /[\r\n]/u.test(rule)) throw new Error("Global rules must be one non-empty line.");
    if (Buffer.byteLength(rule, "utf8") > GlobalInstructions.MAX_RULE_BYTES) {
      throw new Error(`Global rule exceeds ${GlobalInstructions.MAX_RULE_BYTES} bytes.`);
    }
    let added = false;
    const next = await updatePlainTextFile(this.path, async (current) => {
      const exists = await regularFileExists(this.path);
      const base = exists ? current ?? "" : "";
      validateDocument(base);
      if (ruleLines(base).some((item) => item.text.toLocaleLowerCase() === rule.toLocaleLowerCase())) return base;
      const eol = base.includes("\r\n") ? "\r\n" : "\n";
      const nextContent = base.length === 0
        ? `# Global instructions${eol}${eol}- ${rule}${eol}`
        : `${base}${base.endsWith(eol) ? "" : eol}${eol}- ${rule}${eol}`;
      validateDocument(nextContent);
      added = true;
      return nextContent;
    }, GlobalInstructions.MAX_BYTES);
    this.#content = next?.trim() || undefined;
    return added ? "added" : "already-present";
  }

  async forget(input: string): Promise<"removed" | "not-found" | "ambiguous"> {
    const query = input.trim().toLocaleLowerCase();
    if (!query || /[\r\n]/u.test(query)) throw new Error("Specify one global rule to forget.");
    if (!await regularFileExists(this.path)) return "not-found";
    let result: "removed" | "not-found" | "ambiguous" = "not-found";
    const next = await updatePlainTextFile(this.path, async (current) => {
      if (!await regularFileExists(this.path)) return undefined;
      const base = current ?? "";
      validateDocument(base);
      const entries = ruleLines(base);
      const exact = entries.filter((entry) => entry.text.toLocaleLowerCase() === query);
      const matches = exact.length > 0
        ? exact
        : entries.filter((entry) => entry.text.toLocaleLowerCase().includes(query));
      if (matches.length === 0) return base;
      if (matches.length > 1) { result = "ambiguous"; return base; }
      const match = matches[0]!;
      result = "removed";
      const remaining = `${base.slice(0, match.start)}${base.slice(match.end)}`;
      return remaining.trim() === "# Global instructions" ? "" : remaining;
    }, GlobalInstructions.MAX_BYTES);
    this.#content = next?.trim() || undefined;
    return result;
  }
}

interface RuleLine { text: string; start: number; end: number }

function ruleLines(content: string): RuleLine[] {
  return [...content.matchAll(/^[ \t]*[-*+][ \t]+([^\r\n]+)(?:\r?\n|$)/gmu)].map((match) => ({
    text: match[1]!.trim(),
    start: match.index,
    end: match.index + match[0].length,
  }));
}

function validateDocument(content: string): string {
  if (Buffer.byteLength(content, "utf8") > GlobalInstructions.MAX_BYTES) {
    throw new Error(`Global instructions exceed ${GlobalInstructions.MAX_BYTES} bytes.`);
  }
  return content;
}

async function regularFileExists(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw new Error(`Global instructions must be a regular file: ${path}`);
    if (info.size > GlobalInstructions.MAX_BYTES) {
      throw new Error(`Global instructions exceed ${GlobalInstructions.MAX_BYTES} bytes: ${path}`);
    }
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
