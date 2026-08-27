import { describe, expect, it } from "vitest";

import type { ModelRegistry } from "../../src/models/registry.js";
import type { QuestionBridge } from "../../src/tools/ask-user-question.js";
import {
  buildExplainPrompt,
  explainCandidateLabel,
  explainWithModel,
  resolveExplainTarget,
  runExplain,
  selectExplainCandidate,
  type ExplainDeps,
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

const capturingRegistry = (text: string, captured: { prompt?: string }): ModelRegistry => ({
  get: () => ({
    adapter: {
      async * stream(input: { messages: { content: string }[] }) {
        captured.prompt = input.messages[0]!.content;
        yield { type: "text", text };
        yield { type: "done" };
      },
    },
    model: "cheap",
  }),
}) as unknown as ModelRegistry;

const graphNotIndexed: ExplainGraph = {
  async status() { return { available: false }; },
  async search() { return []; },
  async relations() { return { callers: [], callees: [] }; },
};

const explainDeps = (over: Partial<ExplainDeps> = {}): ExplainDeps => ({
  graph: fakeGraph([node("src/order.ts#cancelOrder", { startLine: 2, endLine: 3 })]),
  readFile: async () => "line1\nfunction cancelOrder() {}\nline3",
  history: async () => [{ hash: "a", date: "2026-08-01", author: "w", subject: "keep double-cancel safe" }],
  registry: fakeRegistry("解释正文"),
  modelId: () => "fake:cheap",
  language: "zh-CN",
  ...over,
});

const abort = () => new AbortController().signal;

describe("runExplain", () => {
  it("shows usage without a query", async () => {
    expect(await runExplain(explainDeps(), undefined, undefined, abort())).toContain("Usage: /explain");
  });
  it("points at /ast init when the graph is missing", async () => {
    expect(await runExplain(explainDeps({ graph: graphNotIndexed }), "cancelOrder", undefined, abort())).toContain("/ast init");
  });
  it("reports not-found with a sync hint", async () => {
    expect(await runExplain(explainDeps({ graph: fakeGraph([]) }), "zzz", undefined, abort())).toContain("/ast sync");
  });
  it("explains a unique hit and grounds the prompt in the source slice", async () => {
    const captured: { prompt?: string } = {};
    const out = await runExplain(explainDeps({ registry: capturingRegistry("解释正文", captured) }), "cancelOrder", "并发问题", abort());
    expect(out).toContain("解释正文");
    expect(out).toContain("src/order.ts#cancelOrder");
    expect(captured.prompt).toContain("function cancelOrder() {}");
    expect(captured.prompt).not.toContain("line1"); // only startLine..endLine is sliced
    expect(captured.prompt).toContain("keep double-cancel safe");
    expect(captured.prompt).toContain("并发问题");
  });
  it("asks the picker on ambiguity and explains the picked node", async () => {
    const candidates = [node("src/a.ts#run"), node("src/b.ts#run")];
    const { bridge } = fakeBridge({ 0: explainCandidateLabel(candidates[1]!) });
    const out = await runExplain(explainDeps({ graph: fakeGraph(candidates), questions: bridge }), "run", undefined, abort());
    expect(out).toContain("src/b.ts#run");
  });
  it("honours picker cancellation", async () => {
    const { bridge } = fakeBridge({ 0: "Cancel" });
    const out = await runExplain(explainDeps({ graph: fakeGraph([node("src/a.ts#run"), node("src/b.ts#run")]), questions: bridge }), "run", undefined, abort());
    expect(out).toContain("cancelled");
  });
  it("re-resolves a free-text picker answer", async () => {
    const searches: string[] = [];
    const graph: ExplainGraph = {
      async status() { return { available: true }; },
      async search(query) {
        searches.push(query);
        return searches.length === 1 ? [node("src/a.ts#run"), node("src/b.ts#run")] : [node("src/c.ts#runTwice")];
      },
      async relations() { return { callers: [], callees: [] }; },
    };
    const { bridge } = fakeBridge({ 0: "runTwice" });
    const out = await runExplain(explainDeps({ graph, questions: bridge }), "run", undefined, abort());
    expect(searches).toEqual(["run", "runTwice"]);
    expect(out).toContain("src/c.ts#runTwice");
  });
  it("stops asking after a second ambiguous round", async () => {
    const hits = [node("src/a.ts#run"), node("src/b.ts#run")];
    const { bridge } = fakeBridge({ 0: "run" });
    const out = await runExplain(explainDeps({ graph: fakeGraph(hits), questions: bridge }), "run", undefined, abort());
    expect(out).toContain("still ambiguous");
  });
  it("degrades when git history fails", async () => {
    const captured: { prompt?: string } = {};
    const out = await runExplain(explainDeps({
      history: async () => { throw new Error("not a git repository"); },
      registry: capturingRegistry("解释正文", captured),
    }), "cancelOrder", undefined, abort());
    expect(out).toContain("解释正文");
    expect(captured.prompt).toContain("(no history)");
  });
  it("surfaces model failures as text (same semantics as /review)", async () => {
    const boom = { get: () => ({ adapter: { async * stream() { yield { type: "error", error: { message: "provider down" } }; } }, model: "x" }) } as unknown as ModelRegistry;
    const out = await runExplain(explainDeps({ registry: boom }), "cancelOrder", undefined, abort());
    expect(out).toContain("/explain failed");
    expect(out).toContain("provider down");
  });
});
