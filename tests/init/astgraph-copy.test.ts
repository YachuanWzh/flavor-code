import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { copyAstgraphPlugin } from "src/init/project.js";

describe("astgraph plugin distribution", () => {
  const workspace = mkdtempSync(join(tmpdir(), "flavor-init-astgraph-"));

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("copies the plugin runtime and vendored grammars into the workspace", async () => {
    await copyAstgraphPlugin(workspace);
    const pluginDir = join(workspace, ".flavor", "plugins", "astgraph");
    expect(existsSync(join(pluginDir, "flavor-plugin.json"))).toBe(true);
    expect(existsSync(join(pluginDir, "index.js"))).toBe(true);
    expect(existsSync(join(pluginDir, "db.mjs"))).toBe(true);
    expect(existsSync(join(pluginDir, "vendor", "tree-sitter.wasm"))).toBe(true);
    expect(existsSync(join(pluginDir, "vendor", "tree-sitter-typescript.wasm"))).toBe(true);
    expect(existsSync(join(pluginDir, "vendor", "zod", "index.js"))).toBe(true);
  });

  it("does not overwrite an existing plugin installation", async () => {
    await copyAstgraphPlugin(workspace);
    const pluginDir = join(workspace, ".flavor", "plugins", "astgraph");
    const manifest = join(pluginDir, "flavor-plugin.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(manifest, "{\"name\":\"astgraph\",\"touched\":true}", "utf8");

    await copyAstgraphPlugin(workspace);
    const content = (await import("node:fs")).readFileSync(manifest, "utf8");
    expect(content).toContain("\"touched\":true");
  });
});
