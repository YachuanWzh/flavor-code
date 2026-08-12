import { describe, expect, it, vi } from "vitest";

import {
  createEmbeddedD2cAutomation,
  findD2cPreviewFrame,
  type D2cEmbeddedFrame,
  type D2cEmbeddedHost,
} from "../../src/desktop/d2c-embedded-runner.js";

function frame(url: string): D2cEmbeddedFrame {
  return { url, isDestroyed: () => false, executeJavaScript: vi.fn(async (script: string) => {
    if (script.includes("document.readyState")) return "complete";
    if (script.includes("performance.getEntriesByType")) return 2;
    if (script.includes("step.expect")) return { passed: true, actual: "true" };
    if (script.includes("const clean =")) return { url: "index.html", title: "Demo", viewport: { width: 900, height: 600 }, headings: ["Demo"], bodyText: "打开",
      elements: [{ selector: "#open", tag: "button", text: "打开", visible: true, disabled: false }] };
    return undefined;
  }) };
}

describe("embedded Electron D2C automation", () => {
  it("selects only a frame from the controller-owned loopback origin", () => {
    const target = frame("http://127.0.0.1:4400/form");
    expect(findD2cPreviewFrame([frame("file:///renderer/index.html"), target], "http://127.0.0.1:4400/")).toBe(target);
    expect(() => findD2cPreviewFrame([frame("https://evil.test")], "http://127.0.0.1:4400/")).toThrow(/embedded|frame/i);
  });

  it("runs against the existing iframe and captures its visible rectangle without creating a window", async () => {
    const target = frame("http://127.0.0.1:4400/");
    const mainFrame = frame("file:///renderer/index.html");
    const capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from("png") }));
    const host: D2cEmbeddedHost = {
      isDestroyed: () => false,
      mainFrame: { ...mainFrame, get framesInSubtree() { return [mainFrame, target]; } },
      capturePage,
    };
    (mainFrame.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(async (script: string) => {
      if (script.includes("getBoundingClientRect")) return { x: 20, y: 80, width: 900, height: 600 };
      const assigned = /frame\.src = ("(?:\\.|[^"])*")/.exec(script)?.[1];
      if (assigned !== undefined) target.url = JSON.parse(assigned) as string;
      return true;
    });
    const automation = createEmbeddedD2cAutomation(() => host, {
      navigationTimeoutMs: 100,
      pollIntervalMs: 1,
      visualDelayMs: 0,
    });
    const result = await automation.run({ schemaVersion: 1, product: "form", deterministic: true,
      pages: [{ url: "index.html", scenarios: [{ id: "submit", requireApi: true, steps: [
        { action: "open", url: "index.html#/form" },
        { action: "fill", selector: "#email", value: "a@example.com" },
        { action: "blur", selector: "#email" },
        { action: "click", selector: "button[type=submit]" },
        { action: "wait", ms: 25 },
        { expect: "hidden", selector: ".loading" },
      ] }] }],
    }, "http://127.0.0.1:4400/", "http://127.0.0.1:4300/");
    expect(result.passed).toBe(true);
    expect(target.executeJavaScript).toHaveBeenCalled();

    const scripts = (target.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
      .map(([script]) => String(script));
    const actionScripts = scripts.filter((script) => script.includes("step.action"));
    expect(actionScripts).toHaveLength(4);
    expect(actionScripts.every((script) => script.includes("flavor-d2c-automation-visualizer"))).toBe(true);
    expect(actionScripts.every((script) => script.includes("scrollIntoView"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("自动验收"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("d2c-auto-pointer"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("clickObserved"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("element.disabled"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("clickDeadline") && script.includes("waiting for transient overlays"))).toBe(true);
    expect(actionScripts.some((script) => script.includes("scanPages") && script.includes("向后") && script.includes("向前"))).toBe(true);
    expect(actionScripts.some((script) => script.includes('step.action === "wait"') && script.includes("step.ms"))).toBe(true);
    expect(actionScripts.some((script) => script.includes('step.action === "blur"') && script.includes("element.blur"))).toBe(true);
    await expect(automation.run({ schemaVersion: 1, product: "form", deterministic: true,
      pages: [{ url: "index.html", scenarios: [{ id: "repeat", requireApi: false,
        steps: [{ action: "click", selector: "#again" }, { expect: "visible", selector: "main" }] }] }],
    }, "http://127.0.0.1:4400/", "http://127.0.0.1:4300/")).resolves.toMatchObject({ passed: true });
    const navigationUrls = (mainFrame.executeJavaScript as ReturnType<typeof vi.fn>).mock.calls
      .map(([script]) => /frame\.src = ("(?:\\.|[^"])*")/.exec(String(script))?.[1])
      .filter((value): value is string => value !== undefined)
      .map((value) => JSON.parse(value) as string)
      .filter((value) => value.includes("index.html"));
    expect(navigationUrls.some((value) => value.includes("#/form"))).toBe(true);
    expect(new Set(navigationUrls).size).toBe(navigationUrls.length);
    expect(navigationUrls.every((value) => value.includes("__flavor_d2c_run="))).toBe(true);

    const observations = await automation.observe({ schemaVersion: 1, product: "form", deterministic: true,
      pages: [{ url: "index.html", scenarios: [] }],
    }, "http://127.0.0.1:4400/");
    expect(observations).toMatchObject([{ url: "index.html", title: "Demo", elements: [{ selector: "#open" }] }]);
    expect(observations[0]?.screenshot).toEqual(Buffer.from("png"));

    await expect(automation.capture("http://127.0.0.1:4400/")).resolves.toEqual(Buffer.from("png"));
    expect(capturePage).toHaveBeenCalledWith({ x: 20, y: 80, width: 900, height: 600 });
  });

  it("continues after an authenticated page redirects the iframe to login", async () => {
    const target = frame("http://127.0.0.1:4400/");
    const mainFrame = frame("file:///renderer/index.html");
    const host: D2cEmbeddedHost = {
      isDestroyed: () => false,
      mainFrame: { ...mainFrame, get framesInSubtree() { return [mainFrame, target]; } },
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("png") })),
    };
    (mainFrame.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(async (script: string) => {
      const assigned = /frame\.src = ("(?:\\.|[^"])*")/.exec(script)?.[1];
      if (assigned !== undefined) {
        const requested = new URL(JSON.parse(assigned) as string);
        requested.hash = "/login";
        target.url = requested.toString();
      }
      return true;
    });
    const automation = createEmbeddedD2cAutomation(() => host, {
      navigationTimeoutMs: 100,
      pollIntervalMs: 1,
      visualDelayMs: 0,
    });

    await expect(automation.run({ schemaVersion: 1, product: "protected", deterministic: true,
      pages: [{ url: "index.html#/stock-in", requireApi: false, scenarios: [{ id: "login-first", steps: [
        { action: "fill", selector: "#username", value: "admin" },
        { expect: "visible", selector: "#login-form" },
      ] }] }],
    }, "http://127.0.0.1:4400/", "http://127.0.0.1:4300/")).resolves.toMatchObject({ passed: true });
    expect(target.url).toContain("#/login");
    expect(target.url).toContain("__flavor_d2c_run=1");
  });

  it("uses the contract login prefix before observing a protected page", async () => {
    let authenticated = false;
    const target = frame("http://127.0.0.1:4400/");
    (target.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(async (script: string) => {
      if (script.includes("document.readyState")) return "complete";
      if (script.includes('"selector":"#login-btn"')) {
        authenticated = true;
        const current = new URL(target.url); current.hash = "/dashboard"; target.url = current.toString();
      }
      if (script.includes("data-nav='stock-in'")) {
        const current = new URL(target.url); current.hash = "/stock-in"; target.url = current.toString();
      }
      if (script.includes("const clean =")) return { url: "index.html#/stock-in", title: "入库管理", viewport: { width: 900, height: 600 }, headings: ["入库管理"], bodyText: "新建入库单", elements: [] };
      return undefined;
    });
    const mainFrame = frame("file:///renderer/index.html");
    (mainFrame.executeJavaScript as ReturnType<typeof vi.fn>).mockImplementation(async (script: string) => {
      if (script.includes("getBoundingClientRect")) return { x: 0, y: 0, width: 900, height: 600 };
      const assigned = /frame\.src = ("(?:\\.|[^"])*")/.exec(script)?.[1];
      if (assigned !== undefined) {
        const requested = new URL(JSON.parse(assigned) as string);
        if (!authenticated && requested.hash !== "#/login") requested.hash = "/login";
        target.url = requested.toString();
      }
      return true;
    });
    const host: D2cEmbeddedHost = {
      isDestroyed: () => false,
      mainFrame: { ...mainFrame, get framesInSubtree() { return [mainFrame, target]; } },
      capturePage: vi.fn(async () => ({ toPNG: () => Buffer.from("protected-page") })),
    };
    const automation = createEmbeddedD2cAutomation(() => host, { navigationTimeoutMs: 100, pollIntervalMs: 1, visualDelayMs: 0 });
    const observations = await automation.observe({ schemaVersion: 1, product: "protected", deterministic: true,
      pages: [{ url: "index.html#/stock-in", scenarios: [{ id: "login-and-open-stock-in", requireApi: false, steps: [
        { action: "open", url: "index.html#/login" },
        { action: "fill", selector: "#username", value: "admin" },
        { action: "fill", selector: "#password", value: "123456" },
        { action: "click", selector: "#login-btn" },
        { action: "wait", ms: 1 },
        { action: "click", selector: "a[data-nav='stock-in']" },
        { expect: "visible", selector: "#stock-in-page" },
      ] }] }],
    }, "http://127.0.0.1:4400/");

    expect(observations).toMatchObject([{ url: "index.html#/stock-in", title: "入库管理", bodyText: "新建入库单" }]);
    expect(target.url).toContain("#/stock-in");
    expect(authenticated).toBe(true);
  });
});
