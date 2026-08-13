import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const NAMES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"] as const;
const ROOT_NAMES = ["AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"] as const;

export interface WorkspaceInstructionOptions {
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

interface InstructionDocument { path: string; depth: number; content: string; digest: string }

export class WorkspaceInstructions {
  readonly #root: string;
  readonly #maxFileBytes: number;
  readonly #maxTotalBytes: number;
  readonly #seen = new Map<string, Map<string, string>>();

  constructor(workspace: string, options: WorkspaceInstructionOptions = {}) {
    this.#root = resolve(workspace);
    this.#maxFileBytes = options.maxFileBytes ?? 64 * 1024;
    this.#maxTotalBytes = options.maxTotalBytes ?? 256 * 1024;
  }

  async baseline(scope = "main"): Promise<string> {
    const documents = await this.#readDirectories([{ path: this.#root, depth: 0 }], ROOT_NAMES);
    return this.#format(this.#newOrChanged(documents, scope));
  }

  async discover(paths: readonly string[], scope = "main"): Promise<string[]> {
    const directories = new Map<string, number>();
    for (const path of paths) {
      const absolute = resolve(this.#root, path);
      if (!within(this.#root, absolute)) continue;
      const targetDirectory = await directoryForPath(absolute);
      let current = targetDirectory;
      while (within(this.#root, current)) {
        const depth = depthOf(this.#root, current);
        directories.set(current, depth);
        if (current === this.#root) break;
        current = dirname(current);
      }
    }
    const ordered = [...directories].map(([path, depth]) => ({ path, depth })).sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    const changed = this.#newOrChanged(await this.#readDirectories(ordered, NAMES), scope);
    const formatted = this.#format(changed);
    return formatted === "" ? [] : [formatted];
  }

  #newOrChanged(documents: readonly InstructionDocument[], scope: string): InstructionDocument[] {
    const seen = this.#seen.get(scope) ?? new Map<string, string>();
    this.#seen.set(scope, seen);
    const changed: InstructionDocument[] = [];
    for (const document of documents) {
      if (seen.get(document.path) === document.digest) continue;
      seen.set(document.path, document.digest);
      changed.push(document);
    }
    return changed;
  }

  async #readDirectories(
    directories: readonly { path: string; depth: number }[],
    names: readonly string[],
  ): Promise<InstructionDocument[]> {
    const result: InstructionDocument[] = [];
    let physicalRoot: string;
    try { physicalRoot = await realpath(this.#root); } catch { return result; }
    for (const directory of directories) {
      for (const name of names) {
        const path = resolve(directory.path, name);
        try {
          const info = await lstat(path);
          if (!info.isFile() && !info.isSymbolicLink()) continue;
          const physical = await realpath(path);
          if (!within(physicalRoot, physical)) continue;
          const bytes = await readFile(path);
          const clipped = bytes.subarray(0, this.#maxFileBytes);
          const suffix = bytes.length > clipped.length ? `\n\n[Instruction truncated at ${this.#maxFileBytes} bytes]` : "";
          const content = clipped.toString("utf8") + suffix;
          result.push({
            path,
            depth: directory.depth,
            content,
            digest: createHash("sha256").update(bytes).digest("hex"),
          });
        } catch { /* Missing, unreadable, or racing instruction files are ignored. */ }
      }
    }
    return result;
  }

  #format(documents: readonly InstructionDocument[]): string {
    if (documents.length === 0) return "";
    const selected: InstructionDocument[] = [];
    let bytes = 0;
    // Under pressure, deeper instructions are retained first, then rendered in normal order.
    for (const document of [...documents].sort((a, b) => b.depth - a.depth)) {
      const size = Buffer.byteLength(document.content);
      if (bytes + size > this.#maxTotalBytes) continue;
      bytes += size;
      selected.push(document);
    }
    selected.sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path));
    return selected.map((document) => {
      const display = relative(this.#root, document.path) || document.path;
      return `<workspace-instructions path="${display}">\n${document.content}\n</workspace-instructions>`;
    }).join("\n\n");
  }
}

async function directoryForPath(path: string): Promise<string> {
  try { return (await lstat(path)).isDirectory() ? path : dirname(path); }
  catch { return dirname(path); }
}

function depthOf(root: string, path: string): number {
  const delta = relative(root, path);
  return delta === "" ? 0 : delta.split(sep).length;
}

function within(root: string, candidate: string): boolean {
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}
