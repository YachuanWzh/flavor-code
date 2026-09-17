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
  maxNodes?: number;
  signal?: AbortSignal;
}

export interface CapturedSnapshot extends SnapshotRenderResult {
  documentId: string;
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
  const tree = await options.commander.sendCommand<{ nodes?: AxRawNode[] }>(
    "Accessibility.getFullAXTree",
    undefined,
    commandOptions,
  );
  const inputs = axNodesToSnapshotInputs(tree.nodes ?? []);
  const cap = Math.min(options.maxNodes ?? BROWSER_SNAPSHOT_MAX_NODES, BROWSER_SNAPSHOT_MAX_NODES);
  const truncatedByRequest = inputs.length > cap;
  const nodes = options.registry.replaceDocument(documentId, inputs.slice(0, cap));
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
