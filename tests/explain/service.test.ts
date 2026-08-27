import { describe, expect, it } from "vitest";

import type { ModelRegistry } from "../../src/models/registry.js";
import type { QuestionBridge } from "../../src/tools/ask-user-question.js";
import {
  buildExplainPrompt,
  explainCandidateLabel,
  explainWithModel,
  resolveExplainTarget,
  selectExplainCandidate,
  type ExplainGraph,
  type ExplainNode,
} from "../../src/explain/service.js";

export const node = (id: string, over: Partial<ExplainNode> = {}): ExplainNode => ({
  id, kind: "function", name: id.split("#")[1] ?? id, qualifiedName: id,
  filePath: id.split("#")[0] ?? "src/order.ts", language: "typescript", startLine: 1, endLine: 10, ...over,
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

interface FakeBridge {
  bridge: QuestionBridge;
  asked: { header: string; question: string; options: { label: string; description: string }[] }[];
}

function fakeBridge(answer: Record<number, string>): FakeBridge {
  const asked: FakeBridge["asked"] = [];
  return {
    asked,
    bridge: {
      ask: async (questions: unknown[]) => {
        asked.push(...(questions as FakeBridge["asked"]));
        return answer;
      },
    } as unknown as QuestionBridge,
  };
}

describe("selectExplainCandidate", () => {
  it("asks with up to 3 candidates plus cancel and maps the answer back", async () => {
    const candidates = [node("src/a.ts#run"), node("src/b.ts#run"), node("src/c.ts#run"), node("src/d.ts#run")];
    const { asked, bridge } = fakeBridge({ 0: explainCandidateLabel(candidates[1]!) });
    const outcome = await selectExplainCandidate(candidates, bridge, new AbortController().signal);
    expect(outcome).toEqual({ kind: "picked", node: candidates[1] });
    const question = asked[0]!;
    expect(question.options).toHaveLength(4); // 3 shown candidates + Cancel (schema max)
    expect(question.options[3]!.label).toBe("Cancel");
    expect(question.options[0]!.description).toContain("src/a.ts:1-10");
  });
  it("reports cancellation for the cancel choice", async () => {
    const { bridge } = fakeBridge({ 0: "Cancel" });
    expect(await selectExplainCandidate([node("src/a.ts#run"), node("src/b.ts#run")], bridge, new AbortController().signal))
      .toEqual({ kind: "cancelled" });
  });
  it("reports free-text input as a re-usable query", async () => {
    const { bridge } = fakeBridge({ 0: "runWithRetry" });
    expect(await selectExplainCandidate([node("src/a.ts#run"), node("src/b.ts#run")], bridge, new AbortController().signal))
      .toEqual({ kind: "typed", query: "runWithRetry" });
  });
});

describe("buildExplainPrompt", () => {
  it("includes anchor source, callers and git history", () => {
    const anchor = node("src/order.ts#cancelOrder", { startLine: 3, endLine: 6 });
    const prompt = buildExplainPrompt({
      anchor,
      anchorSource: "export function cancelOrder(id: string) {\n  return db.delete(id);\n}",
      callers: [{ name: "adminCancel", filePath: "src/admin.ts", startLine: 8 }],
      callees: [{ name: "delete", filePath: "src/db.ts", startLine: 2 }],
      history: [{ date: "2026-08-01", author: "wangzh", subject: "fix(order): guard double cancel" }],
      focus: "错误处理",
      language: "zh-CN",
    });
    expect(prompt).toContain("src/order.ts#cancelOrder");
    expect(prompt).toContain("db.delete(id)");
    expect(prompt).toContain("adminCancel");
    expect(prompt).toContain("guard double cancel");
    expect(prompt).toContain("错误处理");
    expect(prompt).toContain("zh-CN");
  });
  it("marks missing relations and history explicitly", () => {
    const prompt = buildExplainPrompt({
      anchor: node("src/a.ts#run"), anchorSource: "function run() {}",
      callers: [], callees: [], history: [], language: "en-US",
    });
    expect(prompt).toContain("(none)");
    expect(prompt).toContain("(no history)");
  });
  it("truncates oversized source slices", () => {
    const prompt = buildExplainPrompt({
      anchor: node("src/big.ts#run"), anchorSource: "x".repeat(30_000),
      callers: [], callees: [], history: [], language: "en-US",
    });
    expect(prompt).toContain("(truncated)");
    expect(prompt.length).toBeLessThan(28_000);
  });
});

const fakeRegistry = (text: string): ModelRegistry => ({
  get: () => ({
    adapter: { async * stream() { yield { type: "text", text }; yield { type: "done" }; } },
    model: "cheap",
  }),
}) as unknown as ModelRegistry;

describe("explainWithModel", () => {
  it("streams one text answer", async () => {
    const out = await explainWithModel({ registry: fakeRegistry("这是解释。"), modelId: () => "fake:cheap" }, "prompt", new AbortController().signal);
    expect(out).toBe("这是解释。");
  });
  it("throws when the model yields no text", async () => {
    const blank = { get: () => ({ adapter: { async * stream() { yield { type: "done" }; } }, model: "x" }) } as unknown as ModelRegistry;
    await expect(explainWithModel({ registry: blank, modelId: () => "fake:cheap" }, "p", new AbortController().signal))
      .rejects.toThrow("no text");
  });
  it("throws on a stream error event", async () => {
    const boom = { get: () => ({ adapter: { async * stream() { yield { type: "error", error: { message: "down" } }; } }, model: "x" }) } as unknown as ModelRegistry;
    await expect(explainWithModel({ registry: boom, modelId: () => "fake:cheap" }, "p", new AbortController().signal))
      .rejects.toThrow("down");
  });
});
