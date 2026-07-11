import { describe, expect, it } from "vitest";

import { ModelRegistry, parseModelId } from "../../src/models/registry.js";
import type { ModelAdapter } from "../../src/models/types.js";

describe("parseModelId", () => {
  it("resolves provider-prefixed model ids", () => {
    expect(parseModelId("openai:gpt-example")).toEqual({
      provider: "openai",
      model: "gpt-example",
    });
  });

  it.each(["missing-prefix", ":model", "provider:"])(
    "rejects malformed id %s",
    (id) => expect(() => parseModelId(id)).toThrow(/provider:model/),
  );
});

it("registers an adapter and resolves its provider-neutral model name", () => {
  const adapter: ModelAdapter = {
    async *stream() {
      yield {
        type: "done",
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  };

  const registry = new ModelRegistry().register("openai", adapter);

  expect(registry.get("openai:gpt-example")).toEqual({
    adapter,
    model: "gpt-example",
  });
  expect(() => registry.get("anthropic:claude-example")).toThrow(/anthropic/);
});

it("unregisters only the adapter that owns a provider", () => {
  const first: ModelAdapter = { async *stream() {} };
  const second: ModelAdapter = { async *stream() {} };
  const registry = new ModelRegistry().register("one", first);
  expect(registry.has("one")).toBe(true);
  expect(registry.unregister("one", second)).toBe(false);
  expect(registry.unregister("one", first)).toBe(true);
  expect(registry.has("one")).toBe(false);
});
