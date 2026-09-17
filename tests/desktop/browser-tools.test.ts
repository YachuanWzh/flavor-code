import { describe, expect, it } from "vitest";

import { BrowserHost } from "../../src/desktop/browser/browser-host.js";
import type { BrowserViewLike } from "../../src/desktop/browser/browser-tab.js";
import { createBrowserTools } from "../../src/desktop/browser/browser-tools.js";
import { BrowserError } from "../../src/desktop/browser/types.js";
import type { ToolContext } from "../../src/tools/types.js";

function fakeView(): BrowserViewLike {
  const wc = {
    url: "about:blank",
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
      return false;
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
      sendCommand(): Promise<unknown> {
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

function makeHost(): BrowserHost {
  return new BrowserHost({
    createView: fakeView,
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
  it("exposes only the three MVP tools to the main agent", () => {
    const tools = createBrowserTools({ host: makeHost(), spaceId: "bspace-a" });
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "BrowserControl",
      "BrowserNavigate",
      "BrowserTabs",
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
