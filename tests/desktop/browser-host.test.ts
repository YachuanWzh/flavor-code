import { describe, expect, it } from "vitest";

import { BrowserHost, type BrowserEventPayload } from "../../src/desktop/browser/browser-host.js";
import type { BrowserViewLike } from "../../src/desktop/browser/browser-tab.js";
import { validateBrowserBounds } from "../../src/desktop/browser/browser-security.js";
import { BrowserError, type BrowserBounds } from "../../src/desktop/browser/types.js";

class FakeWebContents {
  url = "about:blank";
  title = "";
  loading = false;
  destroyed = false;
  listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  removedListeners = 0;
  popupHandler: ((details: { url: string }) => { action: "allow" | "deny" }) | undefined;

  loadURL(url: string): Promise<void> {
    this.url = url;
    this.title = `Title of ${url}`;
    return Promise.resolve();
  }
  getURL(): string {
    return this.url;
  }
  getTitle(): string {
    return this.title;
  }
  isLoading(): boolean {
    return this.loading;
  }
  canGoBack(): boolean {
    return false;
  }
  canGoForward(): boolean {
    return false;
  }
  goBack(): void {}
  goForward(): void {}
  reload(): void {}
  on(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  }
  removeListener(event: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(event) ?? [];
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
    this.removedListeners += 1;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(undefined, ...args);
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: "allow" | "deny" }): void {
    this.popupHandler = handler;
  }
  debugger = {
    attach(): void {},
    detach(): void {},
    isAttached(): boolean {
      return false;
    },
    on(): void {},
    removeListener(): void {},
    sendCommand(): Promise<unknown> {
      return Promise.resolve({});
    },
  };
  close(): void {
    this.destroyed = true;
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
}

class FakeView implements BrowserViewLike {
  webContents = new FakeWebContents();
  bounds: BrowserBounds | undefined;
  visible = false;

  setBounds(bounds: BrowserBounds): void {
    this.bounds = bounds;
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
  }
}

interface Harness {
  host: BrowserHost;
  views: FakeView[];
  events: BrowserEventPayload[];
  attached: FakeView[];
  detached: FakeView[];
}

function harness(): Harness {
  const views: FakeView[] = [];
  const events: BrowserEventPayload[] = [];
  const attached: FakeView[] = [];
  const detached: FakeView[] = [];
  let counter = 0;
  const host = new BrowserHost({
    createView: () => {
      const view = new FakeView();
      views.push(view);
      return view;
    },
    attachView: (view) => attached.push(view as FakeView),
    detachView: (view) => detached.push(view as FakeView),
    emit: (event) => events.push(event),
    newTabId: () => `btab-${(counter += 1)}`,
  });
  return { host, views, events, attached, detached };
}

const BOUNDS: BrowserBounds = { x: 100, y: 40, width: 1_024, height: 768 };

describe("browser host", () => {
  it("creates spaces per task with lazily created anchor tabs", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a", "task-1");
    host.createSpace("bspace-b", "task-2");
    const tab = host.ensureSpaceTab("bspace-a");
    expect(tab.label).toBe("p1");
    expect(views).toHaveLength(1);
    expect(host.listTabs("bspace-b").tabs).toHaveLength(0);
    // idempotent space creation
    host.createSpace("bspace-a");
    expect(host.listTabs("bspace-a").taskId).toBe("task-1");
  });

  it("enforces URL policy on navigate and rejects dangerous protocols", async () => {
    const { host } = harness();
    host.createSpace("bspace-a");
    const tab = host.newTab("bspace-a");
    await expect(host.navigate("bspace-a", tab.id, "file:///C:/Windows/win.ini")).rejects.toBeInstanceOf(BrowserError);
    await expect(host.navigate("bspace-a", tab.id, "https://example.com/x")).resolves.toMatchObject({
      url: "https://example.com/x",
    });
  });

  it("refuses unsafe new-tab urls before creating a view", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    expect(() => host.newTab("bspace-a", "javascript:alert(1)")).toThrow(/Refused new tab/);
    expect(views).toHaveLength(0);
  });

  it("only shows the active space's active tab, and only when the panel is visible", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    host.createSpace("bspace-b");
    const tabA = host.newTab("bspace-a", "https://a.test/");
    const tabB = host.newTab("bspace-b", "https://b.test/");
    host.setBounds("bspace-a", BOUNDS);
    host.setBounds("bspace-b", BOUNDS);

    host.setPanelVisible("bspace-a", true);
    host.activateSpace("bspace-a");
    const viewA = views[0]!;
    const viewB = views[1]!;
    expect(viewA.visible).toBe(true);
    expect(viewB.visible).toBe(false);
    expect(viewA.bounds).toEqual(BOUNDS);

    // A global modal hides every native view.
    host.setModalVisible(true);
    expect(viewA.visible).toBe(false);
    host.setModalVisible(false);
    expect(viewA.visible).toBe(true);

    // Tab switching inside the space moves visibility.
    const second = host.newTab("bspace-a");
    expect(host.listTabs("bspace-a").activeTabId).toBe(second.id);
    expect(views[2]!.visible).toBe(true);
    host.activateTab("bspace-a", tabA.id);
    expect(views[2]!.visible).toBe(false);
    expect(viewA.visible).toBe(true);
    void tabB;
  });

  it("hides views for background spaces so tabs keep running unseen", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    host.createSpace("bspace-b");
    host.setPanelVisible("bspace-a", true);
    host.setPanelVisible("bspace-b", true);
    host.newTab("bspace-a", "https://a.test/");
    host.newTab("bspace-b", "https://b.test/");
    host.activateSpace("bspace-b");
    host.setBounds("bspace-b", BOUNDS);
    expect(views[0]!.visible).toBe(false);
    expect(views[1]!.visible).toBe(true);
  });

  it("rejects oversized renderer bounds", () => {
    const { host } = harness();
    host.createSpace("bspace-a");
    expect(validateBrowserBounds({ x: 0, y: 0, width: 10_000_000, height: 10 }).ok).toBe(false);
    host.setBounds("bspace-a", { x: 0, y: 0, width: 10, height: 10 });
    expect(() => host.ensureSpaceTab("bspace-a")).not.toThrow();
  });

  it("turns policy-safe popups into new tabs in the same space", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    host.newTab("bspace-a", "https://a.test/");
    const opener = views[0]!;
    expect(opener.webContents.popupHandler).toBeDefined();
    const decision = opener.webContents.popupHandler!({ url: "https://a.test/docs" });
    expect(decision.action).toBe("deny");
    expect(host.listTabs("bspace-a").tabs).toHaveLength(2);
    const evil = opener.webContents.popupHandler!({ url: "file:///C:/evil" });
    expect(evil.action).toBe("deny");
    expect(host.listTabs("bspace-a").tabs).toHaveLength(2);
  });

  it("recreates a p1 anchor when the last tab closes", () => {
    const { host } = harness();
    host.createSpace("bspace-a");
    const first = host.newTab("bspace-a", "https://a.test/");
    host.closeTab("bspace-a", first.id);
    const summary = host.listTabs("bspace-a");
    expect(summary.tabs).toHaveLength(1);
    expect(summary.tabs[0]?.label).toBe("p1");
    expect(summary.tabs[0]?.url).toBe("about:blank");
  });

  it("syncs tab metadata from webContents events", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    const tab = host.newTab("bspace-a", "https://a.test/");
    const view = views[0]!;
    view.webContents.loading = true;
    view.webContents.title = "A Page";
    view.webContents.emit("did-stop-loading");
    const summary = host.listTabs("bspace-a");
    expect(summary.tabs[0]).toMatchObject({ title: "A Page" });
    void tab;
  });

  it("marks crashed tabs and keeps them until the user closes them", () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    host.newTab("bspace-a", "https://a.test/");
    views[0]!.webContents.emit("render-process-gone");
    expect(host.listTabs("bspace-a").tabs[0]?.crashed).toBe(true);
  });

  it("enforces ownership for agent writes but never for user UI actions", () => {
    const { host } = harness();
    host.createSpace("bspace-a");
    const tab = host.newTab("bspace-a");
    host.handOff("bspace-a");
    expect(() => host.assertAgentControl("bspace-a")).toThrow(BrowserError);
    // user UI path keeps working
    host.setBounds("bspace-a", BOUNDS);
    host.setPanelVisible("bspace-a", true);
    expect(host.listTabs("bspace-a").ownership).toBe("user");
    host.takeControl("bspace-a");
    expect(() => host.assertAgentControl("bspace-a")).not.toThrow();
    void tab;
  });

  it("destroys views, listeners and debugger state when a space dies", () => {
    const { host, views, detached } = harness();
    host.createSpace("bspace-a");
    host.createSpace("bspace-b");
    host.newTab("bspace-a", "https://a.test/");
    host.newTab("bspace-b", "https://b.test/");
    host.disposeSpace("bspace-a");
    expect(detached).toHaveLength(1);
    expect(views[0]!.webContents.destroyed).toBe(true);
    expect(views[0]!.webContents.removedListeners).toBeGreaterThanOrEqual(6);
    expect(() => host.listTabs("bspace-a")).toThrow(/No browser space/);
    // active space falls back to a remaining one
    expect(host.activeSpace).toBe("bspace-b");
    host.disposeAll();
    expect(views[1]!.webContents.destroyed).toBe(true);
    expect(() => host.createSpace("bspace-c")).toThrow(/disposed/);
  });

  it("announces agent activity with a friendly label before acting", async () => {
    const { host, views, events } = harness();
    host.createSpace("bspace-a");
    const tab = host.newTab("bspace-a", "https://example.com/");
    const seen: string[] = [];
    const fakeDebugger = views[0]!.webContents.debugger as unknown as {
      sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    };
    fakeDebugger.sendCommand = (method: string) => {
      seen.push(method);
      if (method === "DOM.getContentQuads") {
        return Promise.resolve({ quads: [[0, 0, 10, 0, 10, 5, 0, 5]] });
      }
      if (method === "DOM.describeNode") {
        return Promise.resolve({ node: { nodeName: "BUTTON", attributes: ["aria-label", "提交订单"] } });
      }
      return Promise.resolve({});
    };
    host.registryFor("bspace-a", tab.id).replaceDocument("doc-1", [
      { frameId: "main", backendNodeId: 77, role: "button", name: "提交订单" },
    ]);
    await host.act("bspace-a", tab.id, { action: "click", ref: 1 });
    expect(events).toContainEqual({
      kind: "activity",
      spaceId: "bspace-a",
      tabId: tab.id,
      action: "click",
      label: "点击 p1「提交订单」",
    });
    // The panel is hidden: activity is announced, but no visual is injected.
    expect(seen).not.toContain("Runtime.evaluate");
  });

  it("plays in-page visuals for the active visible panel", async () => {
    const { host, views } = harness();
    host.createSpace("bspace-a");
    const tab = host.newTab("bspace-a", "https://example.com/");
    const expressions: string[] = [];
    const fakeDebugger = views[0]!.webContents.debugger as unknown as {
      sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
    };
    fakeDebugger.sendCommand = (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.getContentQuads") {
        return Promise.resolve({ quads: [[0, 0, 10, 0, 10, 5, 0, 5]] });
      }
      if (method === "Runtime.evaluate") expressions.push(String(params?.expression ?? ""));
      return Promise.resolve({});
    };
    host.setBounds("bspace-a", BOUNDS);
    host.setPanelVisible("bspace-a", true);
    host.registryFor("bspace-a", tab.id).replaceDocument("doc-2", [
      { frameId: "main", backendNodeId: 88, role: "button", name: "保存" },
    ]);
    await host.act("bspace-a", tab.id, { action: "click", ref: 1 });
    expect(expressions).toHaveLength(1);
    expect(expressions[0]).toContain('"cursor"');
    expect(expressions[0]).toContain('"click"');
    void tab;
  });

  it("unknown spaces and tabs produce typed errors", () => {
    const { host } = harness();
    expect(() => host.listTabs("bspace-missing")).toThrowError(
      expect.objectContaining({ code: "unknown-space" }),
    );
    host.createSpace("bspace-a");
    expect(() => host.closeTab("bspace-a", "btab-nope")).toThrowError(
      expect.objectContaining({ code: "unknown-tab" }),
    );
  });
});
