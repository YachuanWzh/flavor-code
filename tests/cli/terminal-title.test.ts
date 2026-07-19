import { describe, expect, it } from "vitest";

import { setInteractiveProcessTitle } from "../../src/cli.js";

describe("interactive terminal identity", () => {
  it("labels the foreground process as flavor", () => {
    const target = { title: "node" };

    setInteractiveProcessTitle(target);

    expect(target.title).toBe("flavor");
  });
});
