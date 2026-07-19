import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { setInteractiveProcessTitle } from "../../src/cli.js";

describe("interactive terminal identity", () => {
  it("makes VS Code use the OSC sequence title instead of the node process name", async () => {
    const settings = JSON.parse(
      await readFile(resolve(".vscode/settings.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(settings["terminal.integrated.tabs.title"]).toBe("${sequence}");
  });

  it("labels the foreground process as flavor", () => {
    const target = { title: "node" };

    setInteractiveProcessTitle(target);

    expect(target.title).toBe("flavor");
  });
});
