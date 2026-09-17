import { describe, expect, it } from "vitest";

import { axNodesToSnapshotInputs, captureSnapshot, type AxRawNode, type SnapshotCommander } from "../../src/desktop/browser/snapshot-service.js";
import { RefRegistry } from "../../src/desktop/browser/snapshot.js";

const axTree: AxRawNode[] = [
  {
    nodeId: "1",
    role: { value: "WebArea" },
    name: { value: "Example" },
    nodeInfo: { backendDOMNodeId: 1 },
  },
  {
    nodeId: "2",
    role: { value: "heading" },
    name: { value: "Sign in" },
    nodeInfo: { backendDOMNodeId: 2 },
  },
  {
    nodeId: "3",
    role: { value: "textbox" },
    name: { value: "Email" },
    value: { value: "alice@example.com" },
    nodeInfo: { backendDOMNodeId: 3 },
  },
  {
    nodeId: "4",
    role: { value: "textbox" },
    name: { value: "Password" },
    value: { value: "s3cret!" },
    properties: [{ name: "protected", value: { value: true } }],
    nodeInfo: { backendDOMNodeId: 4 },
  },
  {
    nodeId: "5",
    role: { value: "button" },
    name: { value: "Continue" },
    nodeInfo: { backendDOMNodeId: 5 },
    ignored: true,
  },
  {
    nodeId: "6",
    role: { value: "generic" },
    name: { value: "wrapper" },
    nodeInfo: { backendDOMNodeId: 6 },
  },
  {
    nodeId: "7",
    role: { value: "link" },
    name: { value: "Forgot?" },
    // no backend id -> unresolvable, dropped
  },
];

describe("ax tree conversion", () => {
  it("keeps semantic nodes, drops ignored/generic/unresolved ones", () => {
    const inputs = axNodesToSnapshotInputs(axTree);
    expect(inputs.map((node) => `${node.role}:${node.name}`)).toEqual([
      "heading:Sign in",
      "textbox:Email",
      "textbox:Password",
    ]);
    expect(inputs[1]?.value).toBe("alice@example.com");
    expect(inputs[2]?.redactValue).toBe(true);
    expect(inputs[0]?.backendNodeId).toBe(2);
  });
});

class FakeCommander implements SnapshotCommander {
  calls: string[] = [];
  constructor(private readonly responses: Record<string, unknown>) {}
  sendCommand<T>(method: string): Promise<T> {
    this.calls.push(method);
    return Promise.resolve(this.responses[method] as T);
  }
}

describe("captureSnapshot", () => {
  it("enables CDP domains, allocates refs and renders compact text", async () => {
    const commander = new FakeCommander({
      "DOM.getDocument": { root: { backendNodeId: 4242 } },
      "Accessibility.getFullAXTree": { nodes: axTree },
    });
    const registry = new RefRegistry("bspace-1", "btab-1");
    const result = await captureSnapshot({
      commander,
      registry,
      tabLabel: "p1",
      url: "https://example.com/login",
      title: "Sign in",
    });
    expect(commander.calls).toEqual([
      "DOM.enable",
      "Accessibility.enable",
      "DOM.getDocument",
      "Accessibility.getFullAXTree",
    ]);
    expect(result.documentId).toBe("4242");
    expect(result.text).toContain('@1 heading "Sign in"');
    expect(result.text).toContain('@3 textbox "Password" value="[REDACTED]"');
    expect(result.text).not.toContain("s3cret!");
    expect(result.truncated).toBe(false);
    // refs resolve to backend node identities for the action service
    expect(registry.resolve(2)).toMatchObject({ backendNodeId: 3, documentId: "4242" });
  });

  it("a re-capture replaces the document generation and ref numbers restart", async () => {
    const commander = new FakeCommander({
      "DOM.getDocument": { root: { backendNodeId: 99 } },
      "Accessibility.getFullAXTree": { nodes: axTree.slice(1, 3) },
    });
    const registry = new RefRegistry("bspace-1", "btab-1");
    const first = await captureSnapshot({ commander, registry, tabLabel: "p1", url: "u", title: "t" });
    expect(first.text).toContain("@2");
    const second = await captureSnapshot({ commander, registry, tabLabel: "p1", url: "u", title: "t" });
    expect(second.text).toContain("@1");
    expect(second.text).toContain("@2");
  });

  it("applies the requested node cap and marks truncation", async () => {
    const commander = new FakeCommander({
      "DOM.getDocument": { root: { backendNodeId: 1 } },
      "Accessibility.getFullAXTree": { nodes: axTree },
    });
    const registry = new RefRegistry("bspace-1", "btab-1");
    const result = await captureSnapshot({
      commander,
      registry,
      tabLabel: "p1",
      url: "u",
      title: "t",
      maxNodes: 2,
    });
    expect(result.truncated).toBe(true);
    expect(result.nodeCount).toBe(2);
  });
});
