import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ContextSnapshot } from "../context/manager.js";
import { WorkspaceCheckpointStore } from "./checkpoint.js";

export interface SessionTreeNode {
  id: string;
  parentId: string | null;
  createdAt: string;
  prompt: string;
  checkpointId: string;
  context: ContextSnapshot;
}

interface TreeDocument {
  version: 1;
  sessionId: string;
  leafId: string | null;
  nodes: SessionTreeNode[];
}

/** Rewind history duplicates full context snapshots, so it must stay bounded. */
export const MAX_SESSION_HISTORY_NODES = 100;
export const MAX_SESSION_HISTORY_CONTEXT_CHARS = 2_000_000;

export interface SessionHistoryOptions {
  workspace: string;
  sessionId: string;
  restoreContext?(snapshot: ContextSnapshot): void | Promise<void>;
}

export class SessionHistory {
  readonly #path: string;
  readonly #checkpoints: WorkspaceCheckpointStore;
  readonly #restoreContext: ((snapshot: ContextSnapshot) => void | Promise<void>) | undefined;
  readonly #nodes: SessionTreeNode[];
  #leafId: string | null;
  #unrevert: { checkpointId: string; context: ContextSnapshot; leafId: string | null } | undefined;

  private constructor(options: SessionHistoryOptions, document: TreeDocument) {
    this.#path = join(resolve(options.workspace), ".flavor", "session-trees", options.sessionId, "tree.json");
    this.#checkpoints = new WorkspaceCheckpointStore({ workspace: options.workspace });
    this.#restoreContext = options.restoreContext;
    this.#nodes = boundedNodes(document.nodes);
    this.#leafId = document.leafId !== null && this.#nodes.some((node) => node.id === document.leafId)
      ? document.leafId
      : (this.#nodes.at(-1)?.id ?? null);
  }

  static async open(options: SessionHistoryOptions): Promise<SessionHistory> {
    const path = join(resolve(options.workspace), ".flavor", "session-trees", options.sessionId, "tree.json");
    let document: TreeDocument = { version: 1, sessionId: options.sessionId, leafId: null, nodes: [] };
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as TreeDocument;
      validate(parsed, options.sessionId);
      document = parsed;
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
    const history = new SessionHistory(options, document);
    if (history.#nodes.length !== document.nodes.length) await history.#persist();
    return history;
  }

  get leafId(): string | null { return this.#leafId; }
  tree(): readonly SessionTreeNode[] { return this.#nodes.map((node) => structuredClone(node)); }

  async append(input: { prompt: string; context: ContextSnapshot; label?: string }): Promise<SessionTreeNode> {
    const checkpoint = await this.#checkpoints.create(input.label);
    const node: SessionTreeNode = {
      id: `turn-${Date.now()}-${randomUUID().slice(0, 8)}`,
      parentId: this.#leafId,
      createdAt: new Date().toISOString(),
      prompt: input.prompt,
      checkpointId: checkpoint.id,
      context: structuredClone(input.context),
    };
    this.#nodes.push(node);
    this.#leafId = node.id;
    this.#boundNodes();
    await this.#persist();
    return structuredClone(node);
  }

  async checkpoint(label: string | undefined, context: ContextSnapshot): Promise<SessionTreeNode> {
    return this.append({ prompt: label?.trim() || "Manual checkpoint", context, ...(label === undefined ? {} : { label }) });
  }

  async moveTo(nodeId: string): Promise<void> {
    this.#node(nodeId);
    this.#leafId = nodeId;
    await this.#persist();
  }

  async fork(nodeId: string): Promise<ContextSnapshot> {
    const node = this.#node(nodeId);
    this.#leafId = node.id;
    await this.#restoreContext?.(structuredClone(node.context));
    await this.#persist();
    return structuredClone(node.context);
  }

  async rewind(nodeId: string, currentContext: ContextSnapshot): Promise<void> {
    const node = this.#node(nodeId);
    const current = await this.#checkpoints.create("pre-rewind");
    this.#unrevert = { checkpointId: current.id, context: structuredClone(currentContext), leafId: this.#leafId };
    await this.#checkpoints.restore(node.checkpointId);
    await this.#restoreContext?.(structuredClone(node.context));
    this.#leafId = node.id;
    await this.#persist();
  }

  async unrevert(): Promise<void> {
    const slot = this.#unrevert;
    if (slot === undefined) throw new Error("No rewind can be undone");
    await this.#checkpoints.restore(slot.checkpointId);
    await this.#restoreContext?.(structuredClone(slot.context));
    this.#leafId = slot.leafId;
    this.#unrevert = undefined;
    await this.#persist();
  }

  #node(id: string): SessionTreeNode {
    const node = this.#nodes.find((candidate) => candidate.id === id);
    if (node === undefined) throw new Error(`Unknown session tree node: ${id}`);
    return node;
  }

  #boundNodes(): void {
    const bounded = boundedNodes(this.#nodes);
    this.#nodes.splice(0, this.#nodes.length, ...bounded);
    if (this.#leafId !== null && !this.#nodes.some((node) => node.id === this.#leafId)) {
      this.#leafId = this.#nodes.at(-1)?.id ?? null;
    }
  }

  async #persist(): Promise<void> {
    const document: TreeDocument = {
      version: 1,
      sessionId: basenameSession(this.#path),
      leafId: this.#leafId,
      nodes: this.#nodes,
    };
    await mkdir(dirname(this.#path), { recursive: true });
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#path);
  }
}

function boundedNodes(input: readonly SessionTreeNode[]): SessionTreeNode[] {
  const recent = input.slice(-MAX_SESSION_HISTORY_NODES);
  let contextChars = 0;
  let start = recent.length;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const node = recent[index]!;
    const size = JSON.stringify(node.context).length;
    if (start < recent.length && contextChars + size > MAX_SESSION_HISTORY_CONTEXT_CHARS) break;
    contextChars += size;
    start = index;
  }
  const retained = recent.slice(start).map((node) => structuredClone(node));
  const ids = new Set(retained.map((node) => node.id));
  for (const node of retained) {
    if (node.parentId !== null && !ids.has(node.parentId)) node.parentId = null;
  }
  return retained;
}

function validate(value: TreeDocument, sessionId: string): void {
  if (value.version !== 1 || value.sessionId !== sessionId || !Array.isArray(value.nodes)) {
    throw new Error("Invalid session tree");
  }
  const ids = new Set(value.nodes.map((node) => node.id));
  if (ids.size !== value.nodes.length) throw new Error("Invalid session tree: duplicate node");
  if (value.leafId !== null && !ids.has(value.leafId)) throw new Error("Invalid session tree leaf");
  for (const node of value.nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) throw new Error("Invalid session tree parent");
  }
}

function basenameSession(path: string): string {
  return path.replaceAll("\\", "/").split("/").at(-2)!;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
