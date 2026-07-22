import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadDesktopModels, saveDesktopModel } from "../../src/desktop/model-config.js";
import { AddDesktopModelInputSchema } from "../../src/desktop/contracts.js";

describe("desktop model configuration", () => {
  it("validates provider IDs, protocols and HTTP base URLs at the IPC boundary", () => {
    expect(AddDesktopModelInputSchema.parse({
      provider: "moonshot_ai", model: "kimi-k2", baseURL: "https://api.moonshot.cn/v1",
      apiKey: "secret", protocol: "openai-compatible",
    })).toMatchObject({ provider: "moonshot_ai", model: "kimi-k2" });
    expect(() => AddDesktopModelInputSchema.parse({
      provider: "bad vendor", model: "model", baseURL: "file:///tmp/model", apiKey: "secret", protocol: "openai-compatible",
    })).toThrow();
  });

  it("keeps the two DeepSeek defaults and lists encrypted custom providers", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-desktop-models-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const custom = await saveDesktopModel(workspace, home, {
      provider: "siliconflow", model: "qwen3-coder", baseURL: "https://api.siliconflow.cn/v1",
      apiKey: "secret", protocol: "openai-compatible",
    });

    const models = await loadDesktopModels(workspace, home);
    const globalRaw = await readFile(join(home, ".flavor-code", "flavor.json"), "utf8");
    const projectRaw = await readFile(join(workspace, ".flavor", "flavor.json"), "utf8");

    expect(models.map((model) => model.id)).toEqual([
      "anthropic:deepseek-v4-pro",
      "anthropic:deepseek-v4-flash",
      "siliconflow:qwen3-coder",
    ]);
    expect(custom).toMatchObject({ source: "custom", description: "siliconflow · OpenAI 兼容 API" });
    expect(globalRaw).toContain("flavor:v1:");
    expect(globalRaw).not.toContain("secret");
    expect(projectRaw).toContain("qwen3-coder");
    expect(projectRaw).not.toContain("secret");
  });
});
