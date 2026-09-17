/**
 * BrowserSpace: pure tab-set and ownership bookkeeping for one desktop task.
 * The Electron host (BrowserHost) owns the actual WebContentsViews; this class
 * holds only the metadata so ownership and label rules are unit testable.
 * See md_docs/todo.md sections 5 and 6.
 */

import {
  BrowserError,
  BROWSER_TAB_LIMIT,
  type BrowserOwnership,
  type BrowserSpaceSummary,
  type BrowserTabSummary,
} from "./types.js";

interface SpaceTabRecord {
  id: string;
  label: string;
  title: string;
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  crashed: boolean;
}

export interface BrowserSpaceOptions {
  id: string;
  taskId?: string;
}

export const BLANK_URL = "about:blank";

export class BrowserSpace {
  readonly id: string;
  readonly taskId: string | undefined;
  ownership: BrowserOwnership = "agent";

  private readonly tabs = new Map<string, SpaceTabRecord>();
  private activeTabId: string | undefined;

  constructor(options: BrowserSpaceOptions) {
    this.id = options.id;
    this.taskId = options.taskId;
  }

  get size(): number {
    return this.tabs.size;
  }

  get isEmpty(): boolean {
    return this.tabs.size === 0;
  }

  /** Registers a new tab and assigns the lowest free p<N> label. */
  addTab(tabId: string, initial?: { url?: string; title?: string }): BrowserTabSummary {
    if (this.tabs.has(tabId)) {
      throw new BrowserError("unknown-tab", `Browser tab ${tabId} already exists`);
    }
    if (this.tabs.size >= BROWSER_TAB_LIMIT) {
      throw new BrowserError("unknown-tab", `Browser space is full (${BROWSER_TAB_LIMIT} tabs max)`);
    }
    const record: SpaceTabRecord = {
      id: tabId,
      label: this.nextLabel(),
      title: initial?.title ?? "",
      url: initial?.url ?? BLANK_URL,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      crashed: false,
    };
    this.tabs.set(tabId, record);
    this.activeTabId = tabId;
    return toSummary(record);
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new BrowserError("unknown-tab", `No browser tab ${tabId} in space ${this.id}`);
    }
    this.tabs.delete(tabId);
    if (this.activeTabId === tabId) {
      const next = [...this.tabs.values()].at(-1);
      this.activeTabId = next?.id;
    }
  }

  setActiveTab(tabId: string): void {
    if (!this.tabs.has(tabId)) {
      throw new BrowserError("unknown-tab", `No browser tab ${tabId} in space ${this.id}`);
    }
    this.activeTabId = tabId;
  }

  get activeTab(): BrowserTabSummary | undefined {
    const record = this.activeTabId === undefined ? undefined : this.tabs.get(this.activeTabId);
    return record === undefined ? undefined : toSummary(record);
  }

  /** Applies a host-reported state update for an existing tab. */
  updateTab(tabId: string, patch: Partial<Omit<SpaceTabRecord, "id" | "label">>): BrowserTabSummary {
    const record = this.tabs.get(tabId);
    if (!record) {
      throw new BrowserError("unknown-tab", `No browser tab ${tabId} in space ${this.id}`);
    }
    Object.assign(record, patch);
    return toSummary(record);
  }

  findTabByLabel(label: string): BrowserTabSummary | undefined {
    for (const record of this.tabs.values()) {
      if (record.label === label) return toSummary(record);
    }
    return undefined;
  }

  requireTab(tabId: string): BrowserTabSummary {
    const record = this.tabs.get(tabId);
    if (!record) {
      throw new BrowserError("unknown-tab", `No browser tab ${tabId} in space ${this.id}`);
    }
    return toSummary(record);
  }

  handOff(): void {
    this.ownership = "user";
  }

  /** Only the user UI path may restore agent control; tools must not call this. */
  takeControl(): void {
    this.ownership = "agent";
  }

  assertAgentControl(): void {
    if (this.ownership !== "agent") {
      throw new BrowserError(
        "user-controlled",
        `The user is controlling browser space ${this.id}; ask them to hand control back. This is not retryable.`,
        false,
      );
    }
  }

  summary(): BrowserSpaceSummary {
    return {
      id: this.id,
      ...(this.taskId === undefined ? {} : { taskId: this.taskId }),
      ownership: this.ownership,
      ...(this.activeTabId === undefined ? {} : { activeTabId: this.activeTabId }),
      tabs: [...this.tabs.values()].map(toSummary),
    };
  }

  private nextLabel(): string {
    const used = new Set([...this.tabs.values()].map((tab) => tab.label));
    for (let n = 1; n <= BROWSER_TAB_LIMIT; n += 1) {
      const label = `p${n}`;
      if (!used.has(label)) return label;
    }
    throw new BrowserError("unknown-tab", `No free tab labels in space ${this.id}`);
  }
}

function toSummary(record: SpaceTabRecord): BrowserTabSummary {
  const { id, label, title, url, loading, canGoBack, canGoForward, crashed } = record;
  return {
    id,
    label,
    title,
    url,
    loading,
    canGoBack,
    canGoForward,
    ...(crashed ? { crashed: true } : {}),
  };
}
