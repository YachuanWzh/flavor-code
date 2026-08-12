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
      if (script.includes("frame.src")) target.url = script.includes("index.html")
        ? "http://127.0.0.1:4400/index.html" : "http://127.0.0.1:4400/";
      return true;
    });
    const automation = createEmbeddedD2cAutomation(() => host, { navigationTimeoutMs: 100, pollIntervalMs: 1 });
    const result = await automation.run({ schemaVersion: 1, product: "form", deterministic: true,
      pages: [{ url: "index.html", scenarios: [{ id: "submit", requireApi: true, steps: [
        { action: "fill", selector: "#email", value: "a@example.com" },
        { action: "click", selector: "button[type=submit]" },
        { expect: "visible", selector: ".success" },
      ] }] }],
    }, "http://127.0.0.1:4400/", "http://127.0.0.1:4300/");
    expect(result.passed).toBe(true);
    expect(target.executeJavaScript).toHaveBeenCalled();

    await expect(automation.capture("http://127.0.0.1:4400/")).resolves.toEqual(Buffer.from("png"));
    expect(capturePage).toHaveBeenCalledWith({ x: 20, y: 80, width: 900, height: 600 });
  });
});
