import { describe, expect, it } from "vitest";

import { createExecutionEnvironment } from "../../src/execution/factory.js";

describe("createExecutionEnvironment", () => {
  it("returns undefined for local mode so the existing shell path remains compatible", () => {
    expect(createExecutionEnvironment("/work", { mode: "local" })).toBeUndefined();
  });

  it("creates a docker environment for docker mode", () => {
    expect(createExecutionEnvironment("/work", { mode: "docker", image: "node:24" })?.kind).toBe("docker");
  });
});
