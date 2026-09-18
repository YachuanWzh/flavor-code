/**
 * BrowserTab wraps one remote-content WebContentsView behind narrow structural
 * interfaces so lifecycle logic is unit-testable without Electron. Remote pages
 * must never receive preload, node integration or Flavor IPC surfaces
 * (md_docs/todo.md sections 7 and 15).
 */

import { CdpTransport, type CdpDebuggerLike } from "./cdp-transport.js";
import { BrowserError, type BrowserBounds } from "./types.js";
import { validateBrowserBounds, validateBrowserNavigationUrl, type UrlPolicyOptions } from "./browser-security.js";

export interface BrowserWebContentsLike {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  on(event: string, listener: (...args: unknown[]) => void): void;
  removeListener(event: string, listener: (...args: unknown[]) => void): void;
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "allow" | "deny" }): void;
  debugger: CdpDebuggerLike;
  close(): void;
  isDestroyed(): boolean;
}

export interface BrowserViewLike {
  webContents: BrowserWebContentsLike;
  setBounds(bounds: BrowserBounds): void;
  setVisible(visible: boolean): void;
}

export interface BrowserTabEvents {
  onStateChange(tabId: string): void;
  onPopup(tabId: string, url: string): void;
  onCrashed(tabId: string): void;
  /**
   * Main-document generation changed (real navigation, not in-page routing).
   * All snapshot refs bound to the previous document must die.
   */
  onDocumentChange(tabId: string): void;
}

export interface BrowserTabOptions {
  id: string;
  urlPolicy?: UrlPolicyOptions;
}

export class BrowserTab {
  readonly id: string;
  readonly view: BrowserViewLike;

  private readonly events: BrowserTabEvents;
  private readonly urlPolicy: UrlPolicyOptions;
  private transport: CdpTransport | undefined;
  private destroyed = false;
  private lastBounds: BrowserBounds | undefined;
  private userInputAllowed = false;
  private agentInputDepth = 0;

  constructor(view: BrowserViewLike, options: BrowserTabOptions, events: BrowserTabEvents) {
    this.id = options.id;
    this.view = view;
    this.events = events;
    this.urlPolicy = options.urlPolicy ?? {};
    const wc = view.webContents;
    wc.on("did-start-navigation", this.onNavigationChanged);
    wc.on("did-navigate", this.onNavigationChanged);
    wc.on("did-navigate", this.onDocumentChanged);
    wc.on("did-navigate-in-page", this.onNavigationChanged);
    wc.on("did-stop-loading", this.onNavigationChanged);
    wc.on("page-title-updated", this.onNavigationChanged);
    wc.on("render-process-gone", this.onRenderProcessGone);
    wc.on("before-input-event", this.onBeforeUserInput);
    wc.on("before-mouse-event", this.onBeforeUserInput);
    wc.setWindowOpenHandler((details) => {
      const decision = validateBrowserNavigationUrl(details.url, this.urlPolicy);
      if (decision.ok) this.events.onPopup(this.id, decision.url);
      return { action: "deny" };
    });
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get url(): string {
    return this.liveWebContents().getURL();
  }

  get title(): string {
    return this.liveWebContents().getTitle();
  }

  get loading(): boolean {
    return this.liveWebContents().isLoading();
  }

  get canGoBack(): boolean {
    return this.liveWebContents().canGoBack();
  }

  get canGoForward(): boolean {
    return this.liveWebContents().canGoForward();
  }

  async navigate(rawUrl: string): Promise<string> {
    const decision = validateBrowserNavigationUrl(rawUrl, this.urlPolicy);
    if (!decision.ok) {
      throw new BrowserError("invalid-url", `Navigation to ${describeDenial(decision.reason)} is blocked by the browser URL policy`);
    }
    await this.liveWebContents().loadURL(decision.url);
    return decision.url;
  }

  back(): void {
    const wc = this.liveWebContents();
    if (wc.canGoBack()) wc.goBack();
  }

  forward(): void {
    const wc = this.liveWebContents();
    if (wc.canGoForward()) wc.goForward();
  }

  reload(): void {
    this.liveWebContents().reload();
  }

  /** Native page input belongs to the user only after an explicit hand-off. */
  setUserInputAllowed(allowed: boolean): void {
    this.userInputAllowed = allowed;
  }

  /** Keep CDP-generated input working even if Electron surfaces it as a before-input event. */
  async runAgentInput<T>(operation: () => Promise<T>): Promise<T> {
    this.agentInputDepth += 1;
    try {
      return await operation();
    } finally {
      // Electron may surface a CDP-dispatched mouse/key event just after the
      // command promise resolves. Keep the agent gate open through that
      // dispatch turn or our physical-input guard will cancel the real click.
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      this.agentInputDepth -= 1;
    }
  }

  /** Host-side final arbitration of the native view geometry. */
  applyLayout(bounds: BrowserBounds | undefined, spaceActive: boolean): void {
    if (this.destroyed) return;
    const visible = spaceActive && bounds !== undefined && bounds.width > 0 && bounds.height > 0;
    if (bounds !== undefined && (this.lastBounds === undefined || !sameBounds(this.lastBounds, bounds))) {
      const check = validateBrowserBounds(bounds);
      if (!check.ok) {
        throw new BrowserError("invalid-bounds", `Rejected browser bounds: ${check.reason}`);
      }
      this.view.setBounds(bounds);
      this.lastBounds = bounds;
    }
    this.view.setVisible(visible);
  }

  cdp(): CdpTransport {
    if (this.destroyed) {
      throw new BrowserError("detached", "Browser tab is destroyed", false);
    }
    if (this.transport === undefined) {
      this.transport = new CdpTransport(this.liveWebContents().debugger);
    }
    return this.transport;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const wc = this.view.webContents;
    const bound: [string, (...args: unknown[]) => void][] = [
      ["did-start-navigation", this.onNavigationChanged],
      ["did-navigate", this.onNavigationChanged],
      ["did-navigate", this.onDocumentChanged],
      ["did-navigate-in-page", this.onNavigationChanged],
      ["did-stop-loading", this.onNavigationChanged],
      ["page-title-updated", this.onNavigationChanged],
      ["render-process-gone", this.onRenderProcessGone],
      ["before-input-event", this.onBeforeUserInput],
      ["before-mouse-event", this.onBeforeUserInput],
    ];
    for (const [event, listener] of bound) {
      try {
        wc.removeListener(event, listener);
      } catch {
        // destroyed webContents may refuse listener removal
      }
    }
    this.transport?.dispose();
    this.transport = undefined;
    try {
      wc.close();
    } catch {
      // already closed
    }
  }

  private readonly onNavigationChanged = (): void => {
    if (!this.destroyed) this.events.onStateChange(this.id);
  };

  private readonly onDocumentChanged = (): void => {
    if (!this.destroyed) this.events.onDocumentChange(this.id);
  };

  private readonly onRenderProcessGone = (): void => {
    if (this.destroyed) return;
    this.events.onCrashed(this.id);
  };

  private readonly onBeforeUserInput = (...args: unknown[]): void => {
    const event = args[0] as { preventDefault?: () => void } | undefined;
    if (!this.userInputAllowed && this.agentInputDepth === 0) event?.preventDefault?.();
  };

  private liveWebContents(): BrowserWebContentsLike {
    if (this.destroyed || this.view.webContents.isDestroyed()) {
      throw new BrowserError("detached", `Browser tab ${this.id} is no longer alive`, false);
    }
    return this.view.webContents;
  }
}

function describeDenial(reason: string): string {
  switch (reason) {
    case "protocol-denied":
      return "non-HTTP(S) protocol";
    case "credentials-denied":
      return "URL with embedded credentials";
    case "address-denied":
      return "private/link-local/metadata address";
    case "hostname-denied":
      return "unverifiable hostname";
    default:
      return "unparseable URL";
  }
}

function sameBounds(left: BrowserBounds, right: BrowserBounds): boolean {
  return left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
