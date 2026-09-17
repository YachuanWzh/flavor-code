/**
 * BrowserHost: the single owner of browser state in the main process. Agent
 * tools and the user UI must both go through this host so there is never a
 * second shadow copy of browser state. Views are parented to the window's
 * content view; visibility is arbitrated here (Renderer only expresses intent).
 * See md_docs/todo.md sections 5, 6 and 8.
 */

import { actViaRef, type ActCommandOptions, type ActRequest } from "./act-service.js";
import { BrowserSpace } from "./browser-space.js";
import { BrowserTab, type BrowserViewLike } from "./browser-tab.js";
import { validateBrowserNavigationUrl, type UrlPolicyOptions } from "./browser-security.js";
import { captureSnapshot, type CaptureSnapshotOptions } from "./snapshot-service.js";
import { RefRegistry } from "./snapshot.js";
import {
  BrowserError,
  type BrowserBounds,
  type BrowserSpaceSummary,
  type BrowserTabSummary,
} from "./types.js";

export type BrowserEventPayload =
  | { kind: "tabs-changed"; spaceId: string }
  | { kind: "tab-state"; spaceId: string; tabId: string }
  | { kind: "ownership-changed"; spaceId: string; ownership: "agent" | "user" };

export interface BrowserHostDeps {
  /** Creates a securely-configured remote-content view (production: WebContentsView). */
  createView(): BrowserViewLike;
  /** Attaches / detaches a view to the focused window's content view. */
  attachView(view: BrowserViewLike): void;
  detachView(view: BrowserViewLike): void;
  emit(event: BrowserEventPayload): void;
  urlPolicy?: UrlPolicyOptions;
  newTabId?(): string;
}

function registryKey(spaceId: string, tabId: string): string {
  return `${spaceId}|${tabId}`;
}

interface SpaceState {
  space: BrowserSpace;
  tabs: Map<string, BrowserTab>;
  panelVisible: boolean;
  bounds: BrowserBounds | undefined;
  /** True while a global modal / approval dialog hides the native view. */
  modalVisible: boolean;
}

export class BrowserHost {
  private readonly deps: BrowserHostDeps;
  private readonly spaces = new Map<string, SpaceState>();
  private readonly registries = new Map<string, RefRegistry>();
  private activeSpaceId: string | undefined;
  private disposed = false;

  constructor(deps: BrowserHostDeps) {
    this.deps = deps;
  }

  createSpace(id: string, taskId?: string): void {
    this.assertAlive();
    if (this.spaces.has(id)) return;
    const space = new BrowserSpace({ id, ...(taskId === undefined ? {} : { taskId }) });
    this.spaces.set(id, { space, tabs: new Map(), panelVisible: false, bounds: undefined, modalVisible: false });
    this.activeSpaceId ??= id;
  }

  disposeSpace(spaceId: string): void {
    const state = this.spaces.get(spaceId);
    if (state === undefined) return;
    for (const tab of state.tabs.values()) {
      this.deps.detachView(tab.view);
      tab.destroy();
    }
    for (const key of [...this.registries.keys()]) {
      if (key.startsWith(`${spaceId}|`)) this.registries.delete(key);
    }
    state.tabs.clear();
    this.spaces.delete(spaceId);
    if (this.activeSpaceId === spaceId) {
      this.activeSpaceId = this.spaces.keys().next().value;
      this.relayout();
    }
  }

  activateSpace(spaceId: string | undefined): void {
    this.assertAlive();
    if (spaceId !== undefined && !this.spaces.has(spaceId)) {
      throw new BrowserError("unknown-space", `No browser space ${spaceId}`);
    }
    this.activeSpaceId = spaceId;
    this.relayout();
  }

  get activeSpace(): string | undefined {
    return this.activeSpaceId;
  }

  listTabs(spaceId: string): BrowserSpaceSummary {
    return this.state(spaceId).space.summary();
  }

  /** Lazily keeps a visible anchor tab so the panel is never empty (spec: p1). */
  ensureSpaceTab(spaceId: string): BrowserTabSummary {
    const state = this.state(spaceId);
    const existing = state.space.activeTab ?? state.space.summary().tabs[0];
    if (existing !== undefined) return existing;
    return this.newTab(spaceId);
  }

  newTab(spaceId: string, rawUrl?: string): BrowserTabSummary {
    this.assertAlive();
    const state = this.state(spaceId);
    let target: string | undefined;
    if (rawUrl !== undefined) {
      const decision = validateBrowserNavigationUrl(rawUrl, this.deps.urlPolicy);
      if (!decision.ok) {
        throw new BrowserError("invalid-url", `Refused new tab: ${decision.reason}`);
      }
      target = decision.url;
    }
    const tabId = this.deps.newTabId?.() ?? `btab-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
    const summary = state.space.addTab(tabId, target === undefined ? {} : { url: target });
    const view = this.deps.createView();
    const tab = new BrowserTab(
      view,
      { id: tabId, ...(this.deps.urlPolicy === undefined ? {} : { urlPolicy: this.deps.urlPolicy }) },
      {
        onStateChange: () => {
          this.syncTabFromView(state, tabId);
          this.deps.emit({ kind: "tab-state", spaceId, tabId });
        },
        onPopup: (_fromTabId, url) => {
          // Popups open inside the same space once agent control allows it;
          // while the user controls the browser the popup stays suppressed by
          // the URL policy check above (only http(s) reaches here).
          this.newTab(spaceId, url);
        },
        onCrashed: () => {
          state.space.updateTab(tabId, { crashed: true, loading: false });
          this.registries.get(registryKey(spaceId, tabId))?.invalidateDocument();
          this.deps.emit({ kind: "tab-state", spaceId, tabId });
        },
        onDocumentChange: () => {
          this.registries.get(registryKey(spaceId, tabId))?.invalidateDocument();
        },
      },
    );
    this.deps.attachView(view);
    state.tabs.set(tabId, tab);
    if (target !== undefined) {
      void tab.navigate(target).catch(() => {
        // The URL was policy-validated above; transport failures surface via
        // tab state events and the next snapshot, not here.
      });
    }
    this.deps.emit({ kind: "tabs-changed", spaceId });
    this.relayout();
    return state.space.requireTab(tabId);
  }

  closeTab(spaceId: string, tabId: string): void {
    const state = this.state(spaceId);
    const tab = state.tabs.get(tabId);
    if (tab === undefined) {
      throw new BrowserError("unknown-tab", `No browser tab ${tabId} in space ${spaceId}`);
    }
    this.deps.detachView(tab.view);
    tab.destroy();
    state.tabs.delete(tabId);
    this.registries.delete(registryKey(spaceId, tabId));
    state.space.closeTab(tabId);
    if (state.space.isEmpty) {
      // Recreate a blank p1 anchor so the tab bar never collapses.
      this.newTab(spaceId);
    }
    this.deps.emit({ kind: "tabs-changed", spaceId });
    this.relayout();
  }

  activateTab(spaceId: string, tabId: string): void {
    const state = this.state(spaceId);
    this.tab(state, tabId);
    state.space.setActiveTab(tabId);
    this.deps.emit({ kind: "tabs-changed", spaceId });
    this.relayout();
  }

  async navigate(spaceId: string, tabId: string, url: string): Promise<BrowserTabSummary> {
    const state = this.state(spaceId);
    await this.tab(state, tabId).navigate(url);
    // Sync from the live view immediately; did-navigate may still be pending.
    this.syncTabFromView(state, tabId);
    this.deps.emit({ kind: "tab-state", spaceId, tabId });
    return state.space.requireTab(tabId);
  }

  history(spaceId: string, tabId: string, direction: "back" | "forward" | "reload"): void {
    const state = this.state(spaceId);
    const tab = this.tab(state, tabId);
    if (direction === "back") tab.back();
    else if (direction === "forward") tab.forward();
    else tab.reload();
    this.deps.emit({ kind: "tab-state", spaceId, tabId });
  }

  tabSummary(spaceId: string, tabId: string): BrowserTabSummary {
    return this.state(spaceId).space.requireTab(tabId);
  }

  cdpFor(spaceId: string, tabId: string) {
    return this.tab(this.state(spaceId), tabId).cdp();
  }

  registryFor(spaceId: string, tabId: string): RefRegistry {
    const key = registryKey(spaceId, tabId);
    let registry = this.registries.get(key);
    if (registry === undefined) {
      this.tab(this.state(spaceId), tabId); // fails fast for dead tabs
      registry = new RefRegistry(spaceId, tabId);
      this.registries.set(key, registry);
    }
    return registry;
  }

  /** Takes a semantic snapshot; the tab's CDP transport supplies AX data. */
  async capture(
    spaceId: string,
    tabId: string,
    options: Omit<CaptureSnapshotOptions, "commander" | "registry" | "tabLabel" | "url" | "title">,
  ): Promise<{ tab: BrowserTabSummary; snapshot: Awaited<ReturnType<typeof captureSnapshot>> }> {
    const state = this.state(spaceId);
    const tab = this.tab(state, tabId);
    const summary = state.space.requireTab(tabId);
    this.syncTabFromView(state, tabId);
    const snapshot = await captureSnapshot({
      commander: tab.cdp(),
      registry: this.registryFor(spaceId, tabId),
      tabLabel: summary.label,
      url: summary.url,
      title: summary.title,
      ...options,
    });
    return { tab: this.state(spaceId).space.requireTab(tabId), snapshot };
  }

  async act(
    spaceId: string,
    tabId: string,
    request: ActRequest,
    options: ActCommandOptions = {},
  ): Promise<{ action: ActRequest["action"]; ref: number }> {
    const tab = this.tab(this.state(spaceId), tabId);
    return actViaRef(tab.cdp(), this.registryFor(spaceId, tabId), request, options);
  }

  setBounds(spaceId: string, bounds: BrowserBounds): void {
    const state = this.state(spaceId);
    state.bounds = bounds;
    this.relayout();
  }

  setPanelVisible(spaceId: string, visible: boolean): void {
    const state = this.state(spaceId);
    state.panelVisible = visible;
    this.relayout();
  }

  /** Global modals hide native views so they can never sit over dialogs. */
  setModalVisible(visible: boolean): void {
    for (const state of this.spaces.values()) {
      state.modalVisible = visible;
    }
    this.relayout();
  }

  handOff(spaceId: string): void {
    const state = this.state(spaceId);
    state.space.handOff();
    this.deps.emit({ kind: "ownership-changed", spaceId, ownership: "user" });
    this.relayout();
  }

  takeControl(spaceId: string): void {
    const state = this.state(spaceId);
    state.space.takeControl();
    this.deps.emit({ kind: "ownership-changed", spaceId, ownership: "agent" });
  }

  /** Only the active space's active tab is ever visible. */
  private relayout(): void {
    for (const [spaceId, state] of this.spaces) {
      const isActive = spaceId === this.activeSpaceId;
      const showTabs = isActive && state.panelVisible && !state.modalVisible;
      const activeTabId = state.space.summary().activeTabId;
      for (const [tabId, tab] of state.tabs) {
        if (tab.isDestroyed) continue;
        const showTab = showTabs && tabId === activeTabId;
        try {
          tab.applyLayout(showTab ? state.bounds : undefined, showTab);
        } catch {
          // A dying view mid-relayout must not break other tabs.
        }
      }
    }
  }

  private syncTabFromView(state: SpaceState, tabId: string): void {
    const tab = state.tabs.get(tabId);
    if (tab === undefined || tab.isDestroyed) return;
    state.space.updateTab(tabId, {
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
      canGoBack: tab.canGoBack,
      canGoForward: tab.canGoForward,
    });
  }

  /** Agent tools must call this before any page-mutating operation. */
  assertAgentControl(spaceId: string): void {
    this.state(spaceId).space.assertAgentControl();
  }

  hasSpace(spaceId: string): boolean {
    return this.spaces.has(spaceId);
  }

  private state(spaceId: string): SpaceState {
    const state = this.spaces.get(spaceId);
    if (state === undefined) {
      throw new BrowserError("unknown-space", `No browser space ${spaceId}`);
    }
    return state;
  }

  private tab(state: SpaceState, tabId: string): BrowserTab {
    const tab = state.tabs.get(tabId);
    if (tab === undefined || tab.isDestroyed) {
      throw new BrowserError("unknown-tab", `No live browser tab ${tabId} in space ${state.space.id}`);
    }
    return tab;
  }

  private assertAlive(): void {
    if (this.disposed) throw new BrowserError("detached", "Browser host is disposed", false);
  }

  disposeAll(): void {
    if (this.disposed) return;
    for (const spaceId of [...this.spaces.keys()]) this.disposeSpace(spaceId);
    this.disposed = true;
  }
}
