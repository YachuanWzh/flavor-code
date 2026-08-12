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

  it("uses Anthropic image blocks without exposing the key in errors", async () => {
    const fetch = vi.fn(async (_url: string | URL, _request?: RequestInit) => new Response(JSON.stringify({ error: { message: "invalid key sk-secret" } }), { status: 401 }));
    const client = createD2cJudgeClient(fetch);
    await expect(client.evaluate({ protocol: "anthropic", baseURL: "https://api.anthropic.com", apiKey: "sk-secret", model: "claude-vision", passThreshold: 80 }, input))
      .rejects.not.toThrow(/sk-secret/);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(request!.headers).toMatchObject({ "x-api-key": "sk-secret" });
  });
});
