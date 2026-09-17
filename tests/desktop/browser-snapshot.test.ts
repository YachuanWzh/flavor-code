import { describe, expect, it } from "vitest";

import { RefRegistry, renderSnapshot } from "../../src/desktop/browser/snapshot.js";
import { BrowserError, type SnapshotNodeInput } from "../../src/desktop/browser/types.js";

const nodes: SnapshotNodeInput[] = [
  { frameId: "f1", backendNodeId: 10, role: "heading", name: "Sign in" },
  { frameId: "f1", backendNodeId: 11, role: "textbox", name: "Email", value: "" },
  { frameId: "f1", backendNodeId: 12, role: "textbox", name: "Password", value: "hunter2", redactValue: true },
  { frameId: "f1", backendNodeId: 13, role: "button", name: "Continue" },
];

describe("ref registry", () => {
  it("allocates refs on a full snapshot and resolves them to node identities", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    const taken = registry.replaceDocument("doc-a", nodes);
    expect(taken.map((node) => node.ref)).toEqual([1, 2, 3, 4]);
    expect(registry.resolve(3)).toEqual({
      ref: 3,
      spaceId: "bspace-1",
      tabId: "btab-1",
      documentId: "doc-a",
      frameId: "f1",
      backendNodeId: 12,
    });
  });

  it("merges subtrees by node identity and keeps prior ref numbers", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    registry.replaceDocument("doc-a", nodes);
    const merged = registry.mergeSubtree("doc-a", [
      { frameId: "f1", backendNodeId: 13, role: "button", name: "Continue" },
      { frameId: "f1", backendNodeId: 99, role: "link", name: "Help" },
    ]);
    expect(merged[0]?.ref).toBe(4); // existing identity keeps its ref
    expect(merged[1]?.ref).toBe(5); // new identity gets the next number
  });

  it("invalidates all refs after a document change and rejects stale merges", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    registry.replaceDocument("doc-a", nodes);
    registry.invalidateDocument();
    expect(() => registry.resolve(1)).toThrow(/stale/i);
    expect(() => registry.mergeSubtree("doc-a", nodes)).toThrow(BrowserError);
    registry.replaceDocument("doc-b", nodes);
    // A brand-new document allocates fresh refs bound to the new generation.
    expect(registry.resolve(1).documentId).toBe("doc-b");
  });

  it("invalidates only the navigating frame", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    registry.replaceDocument("doc-a", [
      { frameId: "f1", backendNodeId: 1, role: "button", name: "Main" },
      { frameId: "f2", backendNodeId: 2, role: "button", name: "Frame" },
    ]);
    registry.invalidateFrame("f2");
    expect(() => registry.resolve(2)).toThrow(/stale/i);
    expect(registry.resolve(1).backendNodeId).toBe(1);
  });

  it("refuses merges targeting a different document generation", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    registry.replaceDocument("doc-a", nodes);
    expect(() => registry.mergeSubtree("doc-newer", nodes)).toThrow(/stale document/i);
  });
});

describe("snapshot rendering", () => {
  it("renders compact lines and never emits password values", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    const taken = registry.replaceDocument("doc-a", nodes);
    const result = renderSnapshot({
      tabLabel: "p1",
      url: "https://example.com/login",
      title: "Sign in",
      documentId: "doc-a",
      nodes: taken,
    });
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("Page p1");
    expect(result.text).toContain('@1 heading "Sign in"');
    expect(result.text).toContain('@3 textbox "Password" value="[REDACTED]"');
    expect(result.text).not.toContain("hunter2");
    expect(result.text).not.toContain("<html");
  });

  it("redacts secret-looking values in free text", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    const taken = registry.replaceDocument("doc-a", [
      { frameId: "f1", backendNodeId: 1, role: "textbox", name: "api_key", value: "sk-live-abc" },
    ]);
    const result = renderSnapshot({
      tabLabel: "p1",
      url: "https://example.com",
      title: "",
      documentId: "doc-a",
      nodes: taken,
    });
    expect(result.text).not.toContain("sk-live-abc");
    expect(result.text).toContain("[REDACTED]");
  });

  it("truncates by node budget with an explicit marker", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    const many: SnapshotNodeInput[] = Array.from({ length: 12 }, (_, i) => ({
      frameId: "f1",
      backendNodeId: i + 1,
      role: "text",
      name: `n${i}`,
    }));
    const taken = registry.replaceDocument("doc-a", many);
    const result = renderSnapshot({
      tabLabel: "p1",
      url: "https://example.com",
      title: "many",
      documentId: "doc-a",
      nodes: taken,
      maxNodes: 5,
    });
    expect(result.nodeCount).toBe(5);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("truncated");
  });

  it("truncates by byte budget", () => {
    const registry = new RefRegistry("bspace-1", "btab-1");
    const wide: SnapshotNodeInput[] = Array.from({ length: 50 }, (_, i) => ({
      frameId: "f1",
      backendNodeId: i + 1,
      role: "text",
      name: "x".repeat(200),
    }));
    const taken = registry.replaceDocument("doc-a", wide);
    const result = renderSnapshot({
      tabLabel: "p1",
      url: "https://example.com",
      title: "wide",
      documentId: "doc-a",
      nodes: taken,
      maxNodes: 2_000,
      maxBytes: 1_200,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(1_200 + 64);
  });
});
