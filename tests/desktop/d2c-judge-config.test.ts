import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createD2cJudgeConfigStore } from "../../src/desktop/d2c-judge-config.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("D2C judge configuration", () => {
  it("encrypts the API key at rest and never exposes it from the renderer view", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-judge-config-")); dirs.push(dir);
    const path = join(dir, "d2c-judge.json");
    const store = createD2cJudgeConfigStore(path);
    const view = await store.save({ protocol: "openai-compatible", baseURL: "https://judge.example.com/v1",
      apiKey: "sk-super-secret", model: "vision-pro", passThreshold: 82 });
    expect(view).toEqual({ configured: true, protocol: "openai-compatible", baseURL: "https://judge.example.com/v1",
      model: "vision-pro", passThreshold: 82 });
    expect(await readFile(path, "utf8")).not.toContain("sk-super-secret");
    await expect(store.load()).resolves.toMatchObject({ apiKey: "sk-super-secret", model: "vision-pro" });
  });

  it("rejects unsafe URLs and invalid thresholds", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-judge-config-")); dirs.push(dir);
    const store = createD2cJudgeConfigStore(join(dir, "d2c-judge.json"));
    await expect(store.save({ protocol: "openai-compatible", baseURL: "file:///tmp/model", apiKey: "x", model: "m", passThreshold: 80 })).rejects.toThrow();
    await expect(store.save({ protocol: "anthropic", baseURL: "https://api.example.com", apiKey: "x", model: "m", passThreshold: 101 })).rejects.toThrow();
  });
});
