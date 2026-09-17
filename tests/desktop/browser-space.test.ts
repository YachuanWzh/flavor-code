import { describe, expect, it } from "vitest";

import { BrowserSpace } from "../../src/desktop/browser/browser-space.js";
import { BrowserError, BROWSER_TAB_LIMIT } from "../../src/desktop/browser/types.js";

describe("browser space", () => {
  it("assigns p1..pN labels and reuses freed labels", () => {
    const space = new BrowserSpace({ id: "bspace-1", taskId: "task-1" });
    const first = space.addTab("btab-a");
    const second = space.addTab("btab-b");
    const third = space.addTab("btab-c");
    expect([first.label, second.label, third.label]).toEqual(["p1", "p2", "p3"]);
    space.closeTab("btab-b");
    expect(space.addTab("btab-d").label).toBe("p2");
    expect(space.activeTab?.id).toBe("btab-d");
  });

  it("moves the active tab when the active one closes", () => {
    const space = new BrowserSpace({ id: "bspace-2" });
    space.addTab("btab-a");
    space.addTab("btab-b");
    space.setActiveTab("btab-a");
    space.closeTab("btab-a");
    expect(space.activeTab?.id).toBe("btab-b");
    space.closeTab("btab-b");
    expect(space.activeTab).toBeUndefined();
    expect(space.isEmpty).toBe(true);
  });

  it("caps tabs at the hard limit", () => {
    const space = new BrowserSpace({ id: "bspace-3" });
    for (let i = 0; i < BROWSER_TAB_LIMIT; i += 1) {
      space.addTab(`btab-${i}`);
    }
    expect(() => space.addTab("btab-overflow")).toThrow(/full/);
  });

  it("tracks tab state updates and label lookup", () => {
    const space = new BrowserSpace({ id: "bspace-4" });
    const tab = space.addTab("btab-a", { url: "https://example.com", title: "Example" });
    expect(tab.url).toBe("https://example.com");
    space.updateTab("btab-a", { loading: true, canGoBack: true, crashed: true });
    const byLabel = space.findTabByLabel("p1");
    expect(byLabel).toMatchObject({ loading: true, canGoBack: true, crashed: true });
    expect(() => space.updateTab("btab-missing", { loading: false })).toThrow(BrowserError);
  });

  it("enforces ownership: agent writes stop while the user holds control", () => {
    const space = new BrowserSpace({ id: "bspace-5" });
    space.addTab("btab-a");
    expect(() => space.assertAgentControl()).not.toThrow();
    space.handOff();
    const error = ((): unknown => {
      try {
        space.assertAgentControl();
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(BrowserError);
    expect((error as BrowserError).code).toBe("user-controlled");
    expect((error as BrowserError).transient).toBe(false);
    space.takeControl();
    expect(() => space.assertAgentControl()).not.toThrow();
  });

  it("summarizes the space for IPC without leaking internals", () => {
    const space = new BrowserSpace({ id: "bspace-6", taskId: "task-9" });
    space.addTab("btab-a");
    const summary = space.summary();
    expect(summary).toEqual({
      id: "bspace-6",
      taskId: "task-9",
      ownership: "agent",
      activeTabId: "btab-a",
      tabs: [
        {
          id: "btab-a",
          label: "p1",
          title: "",
          url: "about:blank",
          loading: false,
          canGoBack: false,
          canGoForward: false,
        },
      ],
    });
  });
});
