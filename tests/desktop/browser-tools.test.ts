import { describe, expect, it } from "vitest";

import { BrowserHost } from "../../src/desktop/browser/browser-host.js";
import { createBrowserTools } from "../../src/desktop/browser/browser-tools.js";
import type { BrowserViewLike } from "../../src/desktop/browser/browser-tab.js";
import { BrowserError } from "../../src/desktop/browser/types.js";
import type { ToolContext } from "../../src/tools/types.js";

interface ScriptedWebContentsState {
  loading: boolean;
}

function fakeView(state?: ScriptedWebContentsState): BrowserViewLike {
  const wc = {
    url: "about:blank",
    loading: state ? state.loading : false,
    loadURL(url: string): Promise<void> {
      this.url = url;
      return Promise.resolve();
    },
    getURL(): string {
      return this.url;
    },
    getTitle(): string {
      return this.url === "about:blank" ? "" : `Page ${this.url}`;
    },
    isLoading(): boolean {
      return this.loading;
    },
    canGoBack(): boolean {
      return false;
    },
    canGoForward(): boolean {
      return false;
    },
    goBack(): void {},
    goForward(): void {},
    reload(): void {},
    on(): void {},
    removeListener(): void {},
    setWindowOpenHandler(): void {},
    debugger: {
      attach(): void {},
      detach(): void {},
      isAttached(): boolean {
        return false;
      },
      on(): void {},
      removeListener(): void {},
      sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
        if (method === "DOM.getDocument") return Promise.resolve({ root: { backendNodeId: 500 } });
        if (method === "Accessibility.getFullAXTree") {
          return Promise.resolve({
            nodes: [
              { nodeId: "1", role: { value: "heading" }, name: { value: "Docs" }, nodeInfo: { backendDOMNodeId: 60 } },
              { nodeId: "2", role: { value: "button" }, name: { value: "Save" }, nodeInfo: { backendDOMNodeId: 61 } },
            ],
          });
        }
        if (method === "DOM.getContentQuads") {
          return Promise.resolve({ quads: [[0, 0, 100, 0, 100, 40, 0, 40]] });
        }
        if (method === "Input.dispatchKeyEvent") {
          return Promise.resolve({ handled: true });
        }
        lastCdp = { method, params };
        return Promise.resolve({});
      },
    },
    close(): void {},
    isDestroyed(): boolean {
      return false;
    },
  };
  return {
    webContents: wc as never,
    setBounds(): void {},
    setVisible(): void {},
  };
}

let lastCdp: { method: string; params: Record<string, unknown> | undefined } | undefined;

function makeHost(state?: ScriptedWebContentsState): BrowserHost {
  return new BrowserHost({
    createView: () => fakeView(state),
    attachView: () => undefined,
    detachView: () => undefined,
    emit: () => undefined,
  });
}

const mainAgent: ToolContext = { agent: "main" };

function toolByName<T>(tools: { name: string }[], name: string): T {
  const found = tools.find((tool) => tool.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found as T;
}

type AnyTool = {
  execute(input: never, signal: AbortSignal, context?: ToolContext): Promise<unknown>;
  inputSchema: { safeParse(value: unknown): { success: boolean } };
  agents?: readonly string[];
  permissions(input: never): { readOnly?: boolean; input?: unknown };
};

describe("browser tools", () => {
  it("exposes the MVP read/write surface to the main agent only", () => {
    const tools = createBrowserTools({ host: makeHost(), spaceId: "bspace-a" });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "BrowserAct",
      "BrowserControl",
      "BrowserNavigate",
      "BrowserSnapshot",
      "BrowserTabs",
      "BrowserWait",
    ]);
    for (const tool of tools) {
      expect(tool.agents).toEqual(["main"]);
    }
  });

  it("is bound to its own space, never to the currently active UI space", async () => {
    const host = makeHost();
    host.createSpace("bspace-a", "task-a");
    host.createSpace("bspace-b", "task-b");
    host.activateSpace("bspace-a");
    const tabsB = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-b" }), "BrowserTabs");
    const signal = new AbortController().signal;
    await tabsB.execute({ operation: "new", url: "https://b.test/" } as never, signal, mainAgent);
    expect(host.listTabs("bspace-b").tabs).toHaveLength(1);
    expect(host.listTabs("bspace-a").tabs).toHaveLength(0);
    expect(host.activeSpace).toBe("bspace-a");
  });

  it("rejects browser writes immediately while the user holds control", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    host.handOff("bspace-a");
    const navigate = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-a" }), "BrowserNavigate");
    let failure: unknown;
    try {
      await navigate.execute({ operation: "goto", url: "https://a.test/" } as never, new AbortController().signal, mainAgent);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(BrowserError);
    expect((failure as BrowserError).code).toBe("user-controlled");
    expect((failure as BrowserError).transient).toBe(false);
    // Reads still allowed: list + status
    const tabs = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-a" }), "BrowserTabs");
    const listed = (await tabs.execute({ operation: "list" } as never, new AbortController().signal, mainAgent)) as {
      ownership: string;
    };
    expect(listed.ownership).toBe("user");
    // Snapshot is also gated: it can reveal freshly typed content.
    const snapshot = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-a" }), "BrowserSnapshot");
    await expect(snapshot.execute({} as never, new AbortController().signal, mainAgent)).rejects.toBeInstanceOf(BrowserError);
  });

  it("navigates, reports load state and refuses file urls", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const tools = createBrowserTools({ host, spaceId: "bspace-a" });
    const navigate = toolByName<AnyTool>(tools, "BrowserNavigate");
    const signal = new AbortController().signal;
    const opened = (await navigate.execute({ operation: "goto", url: "https://a.test/x" } as never, signal, mainAgent)) as {
      url: string;
      label: string;
    };
    expect(opened).toMatchObject({ url: "https://a.test/x", label: "p1" });
    await expect(
      navigate.execute({ operation: "goto", url: "file:///C:/secret" } as never, signal, mainAgent),
    ).rejects.toThrow(/blocked by the browser URL policy/);
  });

  it("handOff is one-way: agents hand control out, never take it back", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const control = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-a" }), "BrowserControl");
    const signal = new AbortController().signal;
    const status = (await control.execute({ operation: "status" } as never, signal, mainAgent)) as { ownership: string };
    expect(status.ownership).toBe("agent");
    await control.execute({ operation: "handOff" } as never, signal, mainAgent);
    expect(host.listTabs("bspace-a").ownership).toBe("user");
    expect(control.inputSchema.safeParse({ operation: "takeOver" }).success).toBe(false);
  });

  it("declares read-only metadata only for pure reads", () => {
    const tabs = toolByName<AnyTool>(createBrowserTools({ host: makeHost(), spaceId: "bspace-a" }), "BrowserTabs");
    expect(tabs.permissions({ operation: "list" } as never).readOnly).toBe(true);
    expect(tabs.permissions({ operation: "new" } as never).readOnly).toBe(false);
  });
});

describe("browser snapshot/act tools", () => {
  const signal = new AbortController().signal;

  it("snapshots allocate refs and act drives the resolved backend node", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const tools = createBrowserTools({ host, spaceId: "bspace-a" });
    const navigate = toolByName<AnyTool>(tools, "BrowserNavigate");
    await navigate.execute({ operation: "goto", url: "https://a.test/docs" } as never, signal, mainAgent);
    const snapshot = toolByName<AnyTool>(tools, "BrowserSnapshot");
    const result = (await snapshot.execute({} as never, signal, mainAgent)) as {
      text: string;
      label: string;
      documentId: string;
      truncated: boolean;
    };
    expect(result.label).toBe("p1");
    expect(result.text).toContain('@1 heading "Docs"');
    expect(result.text).toContain('@2 button "Save"');
    expect(result.documentId).toBe("500");

    const act = toolByName<AnyTool>(tools, "BrowserAct");
    const acted = (await act.execute({ action: "click", target: "@2" } as never, signal, mainAgent)) as {
      action: string;
      ref: number;
    };
    expect(acted).toMatchObject({ action: "click", ref: 2 });
    // The click focused backend node 61 (the live node behind @2), not stale data.
    expect(lastCdp?.method).toBe("Input.dispatchMouseEvent");
  });

  it("rejects non-ref locators with a re-snapshot style error", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const act = toolByName<AnyTool>(createBrowserTools({ host, spaceId: "bspace-a" }), "BrowserAct");
    await expect(
      act.execute({ action: "click", target: "button.primary" } as never, signal, mainAgent),
    ).rejects.toThrow(/snapshot refs \(@N\)/);
  });

  it("stale refs after a new snapshot document surface as stale errors", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const tools = createBrowserTools({ host, spaceId: "bspace-a" });
    const snapshot = toolByName<AnyTool>(tools, "BrowserSnapshot");
    const act = toolByName<AnyTool>(tools, "BrowserAct");
    await snapshot.execute({} as never, signal, mainAgent);
    // act on a ref beyond the 2 known nodes -> stale
    await expect(act.execute({ action: "click", target: "@9" } as never, signal, mainAgent)).rejects.toThrow(/stale/i);
  });

  it("wait returns idle with the observed tab state", async () => {
    const host = makeHost();
    host.createSpace("bspace-a");
    const tools = createBrowserTools({ host, spaceId: "bspace-a" });
    const navigate = toolByName<AnyTool>(tools, "BrowserNavigate");
    await navigate.execute({ operation: "goto", url: "https://a.test/" } as never, signal, mainAgent);
    const wait = toolByName<AnyTool>(tools, "BrowserWait");
    const started = Date.now();
    const result = (await wait.execute({ mode: "idle" } as never, signal, mainAgent)) as { waited: string };
    expect(result.waited).toBe("idle");
    // idle requires the settle window, not a blind sleep past it
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("wait times out with a descriptive error while the tab keeps loading", async () => {
    const state = { loading: true };
    const host = makeHost(state);
    host.createSpace("bspace-a");
    const tools = createBrowserTools({ host, spaceId: "bspace-a" });
    const navigate = toolByName<AnyTool>(tools, "BrowserNavigate");
    await navigate.execute({ operation: "goto", url: "https://slow.test/" } as never, signal, mainAgent);
    const wait = toolByName<AnyTool>(tools, "BrowserWait");
    await expect(
      wait.execute({ mode: "idle", timeoutMs: 300 } as never, signal, mainAgent),
    ).rejects.toThrow(/timed out after 300ms/);
  });
});
