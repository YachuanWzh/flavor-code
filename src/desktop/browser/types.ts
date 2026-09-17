/**
 * Internal domain types for the built-in browser. These deliberately avoid
 * Electron instances so the pure logic (space, snapshot refs, security) can be
 * unit tested without a real app. See md_docs/todo.md sections 5-11.
 */

export type BrowserOwnership = "agent" | "user";

export interface BrowserTabSummary {
  id: string;
  /** Stable short label shown to the agent and UI, e.g. "p1", "p2". */
  label: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed?: boolean;
}

export interface BrowserSpaceSummary {
  id: string;
  taskId?: string;
  ownership: BrowserOwnership;
  activeTabId?: string;
  tabs: readonly BrowserTabSummary[];
}

/** A snapshot element reference bound to one document generation. */
export interface BrowserElementRef {
  ref: number;
  spaceId: string;
  tabId: string;
  documentId: string;
  frameId: string;
  backendNodeId: number;
}

/** Input record for registering one snapshot node into the ref registry. */
export interface SnapshotNodeInput {
  frameId: string;
  backendNodeId: number;
  role: string;
  name: string;
  value?: string;
  /** True for password-like inputs; value must never be emitted. */
  redactValue?: boolean;
}

/** A node after ref allocation, ready for model rendering. */
export interface SnapshotNode extends SnapshotNodeInput {
  ref: number;
}

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type BrowserErrorCode =
  | "unknown-tab"
  | "unknown-space"
  | "user-controlled"
  | "stale-ref"
  | "invalid-url"
  | "invalid-bounds"
  | "bad-locator"
  | "detached";

export class BrowserError extends Error {
  readonly code: BrowserErrorCode;
  /** Transient errors may be retried by BrowserWait; permanent ones must not. */
  readonly transient: boolean;

  constructor(code: BrowserErrorCode, message: string, transient = false) {
    super(message);
    this.name = "BrowserError";
    this.code = code;
    this.transient = transient;
  }
}

export const BROWSER_TAB_LIMIT = 20;
export const BROWSER_SNAPSHOT_MAX_NODES = 500;
export const BROWSER_SNAPSHOT_MAX_BYTES = 40 * 1024;
