/**
 * Snapshot ref registry and model-readable snapshot rendering.
 * Refs are bound to a document generation: after any main-frame navigation,
 * reload or document replacement, every old ref must fail as stale. Stale refs
 * never fall back to screen coordinates. See md_docs/todo.md section 11.
 */

import { redactSnapshotValue } from "./browser-security.js";
import {
  BrowserError,
  BROWSER_SNAPSHOT_MAX_BYTES,
  BROWSER_SNAPSHOT_MAX_NODES,
  type BrowserElementRef,
  type SnapshotNode,
  type SnapshotNodeInput,
} from "./types.js";

interface RegistryEntry {
  ref: number;
  frameId: string;
  backendNodeId: number;
}

export class RefRegistry {
  private readonly spaceId: string;
  private readonly tabId: string;
  private documentId: string | undefined;
  private entries = new Map<number, RegistryEntry>();
  private byNode = new Map<string, number>();
  private nextRef = 1;

  constructor(spaceId: string, tabId: string) {
    this.spaceId = spaceId;
    this.tabId = tabId;
  }

  get document(): string | undefined {
    return this.documentId;
  }

  /**
   * Full snapshot against a document: replaces the whole registry. If the
   * document id changed, every previous ref is dropped unconditionally.
   */
  replaceDocument(documentId: string, nodes: readonly SnapshotNodeInput[]): SnapshotNode[] {
    this.documentId = documentId;
    this.entries = new Map();
    this.byNode = new Map();
    this.nextRef = 1;
    return this.mergeSubtree(documentId, nodes);
  }

  /**
   * Partial/subtree snapshot: merges by frame+backend-node identity, keeping
   * previously allocated ref numbers for known nodes.
   */
  mergeSubtree(documentId: string, nodes: readonly SnapshotNodeInput[]): SnapshotNode[] {
    if (this.documentId === undefined) {
      throw new BrowserError("stale-ref", "No snapshot document; take a fresh BrowserSnapshot");
    }
    if (documentId !== this.documentId) {
      throw new BrowserError(
        "stale-ref",
        "Element reference set belongs to a stale document; take a fresh BrowserSnapshot",
      );
    }
    const out: SnapshotNode[] = [];
    for (const node of nodes) {
      const key = nodeKey(node.frameId, node.backendNodeId);
      let ref = this.byNode.get(key);
      if (ref === undefined) {
        ref = this.nextRef;
        this.nextRef += 1;
        this.byNode.set(key, ref);
        this.entries.set(ref, { ref, frameId: node.frameId, backendNodeId: node.backendNodeId });
      }
      out.push({ ...node, ref });
    }
    return out;
  }

  /** Main-frame navigation / reload / document replacement: all refs die. */
  invalidateDocument(): void {
    this.documentId = undefined;
    this.entries = new Map();
    this.byNode = new Map();
    this.nextRef = 1;
  }

  /** A subframe navigated: only that frame's refs die. */
  invalidateFrame(frameId: string): void {
    for (const [ref, entry] of this.entries) {
      if (entry.frameId === frameId) {
        this.entries.delete(ref);
        this.byNode.delete(nodeKey(entry.frameId, entry.backendNodeId));
      }
    }
  }

  resolve(ref: number): BrowserElementRef {
    const entry = this.entries.get(ref);
    if (!entry || this.documentId === undefined) {
      throw new BrowserError("stale-ref", `Element reference @${ref} is stale; take a fresh BrowserSnapshot`);
    }
    return {
      ref: entry.ref,
      spaceId: this.spaceId,
      tabId: this.tabId,
      documentId: this.documentId,
      frameId: entry.frameId,
      backendNodeId: entry.backendNodeId,
    };
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface SnapshotRenderInput {
  tabLabel: string;
  url: string;
  title: string;
  documentId: string;
  nodes: readonly SnapshotNode[];
  maxNodes?: number;
  maxBytes?: number;
}

export interface SnapshotRenderResult {
  text: string;
  nodeCount: number;
  truncated: boolean;
}

/**
 * Renders the compact model-facing snapshot text. Enforces node and byte caps
 * with an explicit truncation marker; never emits raw HTML or password values.
 */
export function renderSnapshot(input: SnapshotRenderInput): SnapshotRenderResult {
  const maxNodes = Math.min(input.maxNodes ?? BROWSER_SNAPSHOT_MAX_NODES, BROWSER_SNAPSHOT_MAX_NODES);
  const maxBytes = Math.min(input.maxBytes ?? BROWSER_SNAPSHOT_MAX_BYTES, BROWSER_SNAPSHOT_MAX_BYTES);
  const header = [
    `Page ${input.tabLabel}`,
    `URL: ${singleLine(input.url, 2_048)}`,
    `Title: ${singleLine(input.title, 300)}`,
    `Document: ${singleLine(input.documentId, 128)}`,
  ];
  const lines: string[] = [...header];
  let bytes = header.reduce((total, line) => total + Buffer.byteLength(line) + 1, 0);
  let emitted = 0;
  let truncated = false;
  for (const node of input.nodes) {
    if (emitted >= maxNodes) {
      truncated = true;
      break;
    }
    const line = formatNodeLine(node);
    const size = Buffer.byteLength(line) + 1;
    if (bytes + size > maxBytes) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += size;
    emitted += 1;
  }
  if (truncated) {
    lines.push(`[truncated: ${input.nodes.length - emitted} more nodes omitted]`);
  }
  return { text: lines.join("\n"), nodeCount: emitted, truncated };
}

function formatNodeLine(node: SnapshotNode): string {
  const parts = [`@${node.ref} ${singleLine(node.role, 64)} ${quoteAttr(singleLine(node.name, 200))}`];
  const value = formatValue(node);
  if (value !== undefined) parts.push(`value=${value}`);
  return parts.join(" ");
}

function formatValue(node: SnapshotNode): string | undefined {
  if (node.value === undefined || node.value === "") return undefined;
  if (node.redactValue) return '"[REDACTED]"';
  // The accessible name is the field identity for redaction purposes.
  return quoteAttr(singleLine(redactSnapshotValue(node.name, node.value), 200));
}

function quoteAttr(text: string): string {
  return `"${text.replace(/[\\"]/g, "")}"`;
}

function singleLine(text: string, maxLength: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxLength ? collapsed.slice(0, maxLength) : collapsed;
}

function nodeKey(frameId: string, backendNodeId: number): string {
  return `${frameId}:${backendNodeId}`;
}
