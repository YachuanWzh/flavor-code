/**
 * Snapshot service: converts the Chromium accessibility tree into compact
 * semantic nodes with snapshot refs. DOM and Accessibility data come through
 * the tab's CDP transport; raw HTML is never sent to the model.
 * See md_docs/todo.md section 11.
 */

import { RefRegistry, renderSnapshot, type SnapshotRenderResult } from "./snapshot.js";
import {
  BROWSER_SNAPSHOT_MAX_NODES,
  type SnapshotNodeInput,
} from "./types.js";

/** Minimal structural view of CdpTransport.sendCommand (fake-testable). */
export interface SnapshotCommander {
  sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T>;
}

/** Raw CDP Accessibility.getFullAXTree node (subset we consume). */
export interface AxRawNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value?: { value?: unknown } }[];
  nodeInfo?: { backendDOMNodeId?: number };
}

/** Roles worth a line in the model-facing semantic tree. */
const KEPT_ROLES = new Set([
  "alert",
  "alertdialog",
  "article",
  "banner",
  "button",
  "checkbox",
  "combobox",
  "dialog",
  "document",
  "form",
  "heading",
  "image",
  "link",
  "list",
  "listbox",
  "listitem",
  "main",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "navigation",
  "option",
  "paragraph",
  "radio",
  "region",
  "searchbox",
  "slider",
  "spinbutton",
  "status",
  "switch",
  "tab",
  "table",
  "textbox",
  "toggle button",
  "tooltip",
  "tree",
  "treeitem",
]);

export const MAIN_FRAME_ID = "main";

export function axNodesToSnapshotInputs(
  nodes: readonly AxRawNode[],
  frameId: string = MAIN_FRAME_ID,
): SnapshotNodeInput[] {
  const out: SnapshotNodeInput[] = [];
  for (const node of nodes) {
    if (node.ignored === true) continue;
    const role = node.role?.value;
    const backendNodeId = node.nodeInfo?.backendDOMNodeId;
    if (role === undefined || backendNodeId === undefined) continue;
    if (!KEPT_ROLES.has(role)) continue;
    const name = typeof node.name?.value === "string" ? node.name.value : "";
    const rawValue = typeof node.value?.value === "string" || typeof node.value?.value === "number"
      ? String(node.value.value)
      : undefined;
    const protectedField = node.properties?.some(
      (property) => property.name === "protected" && property.value?.value === true,
    );
    const input: SnapshotNodeInput = {
      frameId,
      backendNodeId,
      role,
      name: name === "" ? role : name,
    };
    if (rawValue !== undefined && rawValue !== "") {
      input.value = rawValue;
      if (protectedField === true) input.redactValue = true;
    }
    out.push(input);
  }
  return out;
}

export interface CaptureSnapshotOptions {
  commander: SnapshotCommander;
  registry: RefRegistry;
  tabLabel: string;
  url: string;
  title: string;
  scope?: "viewport" | "full_page" | "subtree";
  rootBackendNodeId?: number;
  maxNodes?: number;
  signal?: AbortSignal;
}

export interface CapturedSnapshot extends SnapshotRenderResult {
  documentId: string;
}

interface DomSnapshotDocument {
  nodes?: { backendNodeId?: number[] };
  layout?: { nodeIndex?: number[]; bounds?: number[][] };
}

async function viewportBackendNodes(
  commander: SnapshotCommander,
  commandOptions: { signal?: AbortSignal },
): Promise<Set<number> | undefined> {
  try {
    const [viewport, snapshot] = await Promise.all([
      commander.sendCommand<{ result?: { value?: { width?: number; height?: number } } }>(
        "Runtime.evaluate",
        { expression: "({width: innerWidth, height: innerHeight})", returnByValue: true },
        commandOptions,
      ),
      commander.sendCommand<{ documents?: DomSnapshotDocument[] }>(
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [], includeDOMRects: true, includePaintOrder: false },
        commandOptions,
      ),
    ]);
    const width = viewport.result?.value?.width;
    const height = viewport.result?.value?.height;
    const document = snapshot.documents?.[0];
    const backendIds = document?.nodes?.backendNodeId;
    const nodeIndices = document?.layout?.nodeIndex;
    const bounds = document?.layout?.bounds;
    if (width === undefined || height === undefined || backendIds === undefined
      || nodeIndices === undefined || bounds === undefined) return undefined;
    const visible = new Set<number>();
    for (let index = 0; index < nodeIndices.length; index += 1) {
      const nodeIndex = nodeIndices[index];
      const rect = bounds[index];
      if (nodeIndex === undefined || rect === undefined) continue;
      const [x = 0, y = 0, rectWidth = 0, rectHeight = 0] = rect;
      if (rectWidth <= 0 || rectHeight <= 0 || x + rectWidth <= 0 || y + rectHeight <= 0
        || x >= width || y >= height) continue;
      const backendNodeId = backendIds[nodeIndex];
      if (backendNodeId !== undefined) visible.add(backendNodeId);
    }
    return visible.size === 0 ? undefined : visible;
  } catch {
    // Some targets do not expose DOMSnapshot. Falling back to the semantic
    // tree is safer than returning a misleading empty page.
    return undefined;
  }
}

/**
 * Takes a full snapshot of the tab's main frame, replaces the document's ref
 * generation and renders the compact model-facing text.
 */
export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<CapturedSnapshot> {
  const commandOptions = options.signal === undefined ? {} : { signal: options.signal };
  await options.commander.sendCommand("DOM.enable", undefined, commandOptions);
  await options.commander.sendCommand("Accessibility.enable", undefined, commandOptions);
  const document = await options.commander.sendCommand<{
    root: { backendNodeId?: number; nodeId?: number };
  }>("DOM.getDocument", { depth: 0 }, commandOptions);
  const documentRoot = document.root.backendNodeId ?? document.root.nodeId;
  if (documentRoot === undefined) {
    throw new Error("DOM.getDocument returned no document identity");
  }
  const documentId = String(documentRoot);
  const scope = options.scope ?? "full_page";
  let tree: { nodes?: AxRawNode[] };
  if (scope === "subtree") {
    if (options.rootBackendNodeId === undefined) throw new Error("Subtree snapshot requires a root node");
    const resolved = await options.commander.sendCommand<{ object?: { objectId?: string } }>(
      "DOM.resolveNode",
      { backendNodeId: options.rootBackendNodeId },
      commandOptions,
    );
    const objectId = resolved.object?.objectId;
    if (objectId === undefined) throw new Error("Subtree root can no longer be resolved");
    try {
      tree = await options.commander.sendCommand<{ nodes?: AxRawNode[] }>(
        "Accessibility.queryAXTree",
        { objectId },
        commandOptions,
      );
    } finally {
      await options.commander.sendCommand("Runtime.releaseObject", { objectId }, commandOptions).catch(() => undefined);
    }
  } else {
    tree = await options.commander.sendCommand<{ nodes?: AxRawNode[] }>(
      "Accessibility.getFullAXTree",
      undefined,
      commandOptions,
    );
  }
  let inputs = axNodesToSnapshotInputs(tree.nodes ?? []);
  if (scope === "viewport") {
    const visible = await viewportBackendNodes(options.commander, commandOptions);
    if (visible !== undefined) inputs = inputs.filter((node) => visible.has(node.backendNodeId));
  }
  const cap = Math.min(options.maxNodes ?? BROWSER_SNAPSHOT_MAX_NODES, BROWSER_SNAPSHOT_MAX_NODES);
  const truncatedByRequest = inputs.length > cap;
  const selected = inputs.slice(0, cap);
  const nodes = scope === "subtree" && options.registry.document === documentId
    ? options.registry.mergeSubtree(documentId, selected)
    : options.registry.replaceDocument(documentId, selected);
  const rendered = renderSnapshot({
    tabLabel: options.tabLabel,
    url: options.url,
    title: options.title,
    documentId,
    nodes,
    ...(options.maxNodes === undefined ? {} : { maxNodes: options.maxNodes }),
  });
  return {
    ...rendered,
    truncated: rendered.truncated || truncatedByRequest,
    documentId,
  };
}
