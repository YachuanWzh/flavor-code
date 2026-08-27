import { describe, expect, it } from "vitest";

import { resolveExplainTarget, type ExplainGraph, type ExplainNode } from "../../src/explain/service.js";

export const node = (id: string, over: Partial<ExplainNode> = {}): ExplainNode => ({
  id, kind: "function", name: id.split("#")[1] ?? id, qualifiedName: id,
  filePath: "src/order.ts", language: "typescript", startLine: 1, endLine: 10, ...over,
});

export const fakeGraph = (hits: ExplainNode[], origin?: ExplainNode): ExplainGraph => ({
  async status() { return { available: true }; },
  async search() { return hits; },
  async relations(id) {
    return {
      ...(id === origin?.id ? { origin } : {}),
      callers: [], callees: [], impact: [],
    } as Awaited<ReturnType<ExplainGraph["relations"]>>;
  },
});

describe("resolveExplainTarget", () => {
  it("prefers an exact node-id match", async () => {
    const anchor = node("src/order.ts#cancelOrder");
    const out = await resolveExplainTarget(fakeGraph([], anchor), "src/order.ts#cancelOrder");
    expect(out).toEqual({ kind: "resolved", node: anchor });
  });
  it("resolves a unique name search hit", async () => {
    const hit = node("src/a.ts#parse");
    expect(await resolveExplainTarget(fakeGraph([hit]), "parse")).toEqual({ kind: "resolved", node: hit });
  });
  it("reports ambiguity with candidates", async () => {
    const hits = [node("src/a.ts#run"), node("src/b.ts#run")];
    expect(await resolveExplainTarget(fakeGraph(hits), "run")).toEqual({ kind: "ambiguous", candidates: hits });
  });
  it("reports not-found", async () => {
    expect(await resolveExplainTarget(fakeGraph([]), "zzz")).toEqual({ kind: "not-found", query: "zzz" });
  });
});
