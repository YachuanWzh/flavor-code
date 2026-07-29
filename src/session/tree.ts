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
    this.#nodes = document.nodes;
    this.#leafId = document.leafId;
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
    return new SessionHistory(options, document);
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
