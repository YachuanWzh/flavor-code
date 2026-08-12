import { describe, expect, it, vi } from "vitest";

import { createD2cJudgeClient } from "../../src/desktop/d2c-judge-client.js";

const input = { prompt: "judge this", designPng: Buffer.from("design"), implementationPng: Buffer.from("implementation") };

describe("D2C judge multimodal client", () => {
  it("sends two images to an OpenAI-compatible chat completion endpoint", async () => {
    const fetch = vi.fn(async (_url: string | URL, _request?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      visualScore: 90, interactionScore: 88, confidence: "high", summary: "ok", strengths: [], issues: [],
    }) } }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = createD2cJudgeClient(fetch);
    await expect(client.evaluate({ protocol: "openai-compatible", baseURL: "https://api.example.com/v1", apiKey: "sk-secret", model: "vision", passThreshold: 80 }, input))
      .resolves.toMatchObject({ visualScore: 90, interactionScore: 88 });
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.example.com/v1/chat/completions");
    expect(request!.headers).toMatchObject({ Authorization: "Bearer sk-secret" });
    const body = JSON.parse(String(request!.body));
    expect(body.messages[0].content.filter((item: { type: string }) => item.type === "image_url")).toHaveLength(2);
  });

  it("uses page screenshots to plan executable autonomous journeys", async () => {
    const plan = { summary: "覆盖菜单", pageAnalyses: [{ url: "index.html", pageType: "大屏", goals: ["打开下钻"], risks: [] }],
      manifest: { schemaVersion: 1, product: "screen", deterministic: true, pages: [{ url: "index.html", requireApi: false,
        scenarios: [{ id: "drill-down", requireApi: false, steps: [{ action: "click", selector: "#drill" }, { expect: "visible", selector: "#drawer" }] }] }] } };
    const fetch = vi.fn(async (_url: string | URL, _request?: RequestInit) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 }));
    const client = createD2cJudgeClient(fetch);
    await expect(client.planInteractions({ protocol: "openai-compatible", baseURL: "https://api.example.com/v1", apiKey: "key", model: "vision", passThreshold: 80 },
      { prompt: "plan", screenshots: [Buffer.from("page")], observedPages: ["index.html"] }))
      .resolves.toMatchObject({ model: "vision", manifest: { pages: [{ scenarios: [{ id: "drill-down" }] }] } });
    const body = JSON.parse(String(fetch.mock.calls[0]![1]!.body));
    expect(body.messages[0].content.filter((item: { type: string }) => item.type === "image_url")).toHaveLength(1);
  });

  it("uses Anthropic image blocks without exposing the key in errors", async () => {
    const fetch = vi.fn(async (_url: string | URL, _request?: RequestInit) => new Response(JSON.stringify({ error: { message: "invalid key sk-secret" } }), { status: 401 }));
    const client = createD2cJudgeClient(fetch);
    await expect(client.evaluate({ protocol: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "sk-secret", model: "claude-vision", passThreshold: 80 }, input))
      .rejects.not.toThrow(/sk-secret/);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(request!.headers).toMatchObject({ "x-api-key": "sk-secret" });
  });

  it("retries a transient fetch failure and preserves useful network diagnostics", async () => {
    const plan = { summary: "覆盖菜单", pageAnalyses: [{ url: "index.html", pageType: "后台", goals: ["查询"], risks: [] }],
      manifest: { schemaVersion: 1, product: "screen", deterministic: true, pages: [{ url: "index.html", requireApi: false,
        scenarios: [{ id: "search", requireApi: false, steps: [{ action: "click", selector: "#search" }, { expect: "visible", selector: "#result" }] }] }] } };
    const failure = new TypeError("fetch failed", { cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }) });
    const fetch = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }] }), { status: 200 }));
    const client = createD2cJudgeClient(fetch, async () => undefined);
    await expect(client.planInteractions({ protocol: "openai-compatible", baseURL: "https://judge.example.com/v1", apiKey: "secret", model: "vision", passThreshold: 80 },
      { prompt: "plan", screenshots: [Buffer.from("page")], observedPages: ["index.html"] })).resolves.toMatchObject({ summary: "覆盖菜单" });
    expect(fetch).toHaveBeenCalledTimes(2);

    const alwaysFails = createD2cJudgeClient(vi.fn(async () => { throw failure; }), async () => undefined);
    await expect(alwaysFails.planInteractions({ protocol: "openai-compatible", baseURL: "https://judge.example.com/v1", apiKey: "secret", model: "vision", passThreshold: 80 },
      { prompt: "plan", screenshots: [Buffer.from("page")], observedPages: ["index.html"] }))
      .rejects.toThrow(/judge\.example\.com.*fetch failed.*socket disconnected/i);
  });
});
