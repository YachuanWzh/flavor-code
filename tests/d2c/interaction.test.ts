import { describe, expect, it, vi } from "vitest";

import { isLoopbackPreviewUrl, parseInteractionManifest, runInteractionManifest, type D2cInteractionDriver } from "../../src/d2c/interaction.js";

const raw = JSON.stringify({ schemaVersion: 1, product: "Demo", deterministic: true, pages: [{ url: "orders.html", scenarios: [{ id: "orders-filter", steps: [
  { action: "fill", selector: "#search", value: "PO-1" },
  { expect: "count", selector: "#rows tr", value: 1 },
] }] }] });

describe("D2C interaction acceptance", () => {
  it("validates deterministic manifests and rejects unsafe page URLs", () => {
    expect(parseInteractionManifest(raw).pages[0]?.scenarios[0]?.id).toBe("orders-filter");
    expect(() => parseInteractionManifest(JSON.stringify({ schemaVersion: 1, product: "x", deterministic: true,
      pages: [{ url: "https://evil.example/", scenarios: [] }] }))).toThrow(/url|page/i);
    expect(() => parseInteractionManifest(JSON.stringify({ schemaVersion: 1, product: "x", deterministic: false, pages: [] }))).toThrow(/deterministic/i);
    for (const url of ["../secrets.html", "/absolute.html", "foo\\bar.html", "#fragment", "http://localhost:1/x"]) {
      expect(() => parseInteractionManifest(JSON.stringify({ schemaVersion: 1, product: "x", deterministic: true,
        pages: [{ url, scenarios: [] }] }))).toThrow();
    }
  });

  it("permits only loopback HTTP preview addresses", () => {
    expect(isLoopbackPreviewUrl("http://127.0.0.1:4173/")).toBe(true);
    expect(isLoopbackPreviewUrl("http://localhost:5173/orders.html")).toBe(true);
    expect(isLoopbackPreviewUrl("https://127.0.0.1:4173/")).toBe(false);
    expect(isLoopbackPreviewUrl("http://0.0.0.0:4173/")).toBe(false);
    expect(isLoopbackPreviewUrl("http://example.com/")).toBe(false);
    expect(isLoopbackPreviewUrl("http://user:pass@localhost:4173/")).toBe(false);
    expect(isLoopbackPreviewUrl("not a url")).toBe(false);
  });

  it("executes actions and assertions and requires observable API traffic", async () => {
    const actions: unknown[] = [];
    const driver: D2cInteractionDriver = {
      load: vi.fn(async () => undefined),
      action: vi.fn(async (step) => { actions.push(step); }),
      assertion: vi.fn(async () => ({ passed: true })),
      apiRequestCount: () => 1,
      close: vi.fn(async () => undefined),
    };
    const result = await runInteractionManifest(parseInteractionManifest(raw), "http://127.0.0.1:4173/", async () => driver);
    expect(result).toMatchObject({ passed: true, total: 1, failures: 0, apiRequestCount: 1 });
    expect(result.scenarios[0]).toMatchObject({ id: "orders-filter", pageUrl: "http://127.0.0.1:4173/orders.html", passed: true });
    expect(actions).toHaveLength(1);
    expect(driver.close).toHaveBeenCalledOnce();
  });

  it("reports assertion failures, driver errors and static pages without API calls", async () => {
    const results = await Promise.all([
      runInteractionManifest(parseInteractionManifest(raw), "http://localhost:4173/", async () => ({
        load: async () => undefined, action: async () => undefined,
        assertion: async () => ({ passed: false, actual: "0" }), apiRequestCount: () => 1, close: async () => undefined,
      })),
      runInteractionManifest(parseInteractionManifest(raw), "http://localhost:4173/", async () => ({
        load: async () => undefined, action: async () => { throw new Error("element missing"); },
        assertion: async () => ({ passed: true }), apiRequestCount: () => 1, close: async () => undefined,
      })),
      runInteractionManifest(parseInteractionManifest(raw), "http://localhost:4173/", async () => ({
        load: async () => undefined, action: async () => undefined,
        assertion: async () => ({ passed: true }), apiRequestCount: () => 0, close: async () => undefined,
      })),
    ]);
    expect(results[0]?.scenarios[0]?.failure).toMatch(/expected|actual/i);
    expect(results[1]?.scenarios[0]?.failure).toContain("element missing");
    expect(results[2]?.scenarios[0]?.failure).toMatch(/api/i);
    expect(results.every((item) => !item.passed)).toBe(true);
  });

  it("creates an isolated driver per scenario and supports explicitly static scenarios", async () => {
    const manifest = parseInteractionManifest(JSON.stringify({
      schemaVersion: 1, product: "mixed", deterministic: true,
      pages: [{ url: "index.html", requireApi: false, scenarios: [
        { id: "keyboard", steps: [{ action: "key", value: "Escape" }, { expect: "visible", selector: "main" }] },
        { id: "hover", requireApi: true, steps: [{ action: "hover", selector: "button" }, { expect: "class", selector: "button", value: "active" }] },
      ] }],
    }));
    const closes: Array<ReturnType<typeof vi.fn>> = [];
    let created = 0;
    const result = await runInteractionManifest(manifest, "http://localhost:5173/", async () => {
      created += 1;
      const close = vi.fn(async () => undefined); closes.push(close);
      return { load: async () => undefined, action: async () => undefined, assertion: async () => ({ passed: true }),
        apiRequestCount: () => created === 1 ? 0 : 2, close };
    });
    expect(result).toMatchObject({ passed: true, total: 2, failures: 0, apiRequestCount: 2 });
    expect(created).toBe(2);
    expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true);
  });
});
