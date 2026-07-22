import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { ProjectMcpConfigManager } from "../../src/mcp/config-manager.js";

describe("project MCP configuration manager", () => {
  it("creates, lists, renames, toggles, and deletes validated services without losing other config", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-mcp-config-"));
    const path = join(workspace, ".flavor", "flavor.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ language: "zh-CN" }));
    const manager = new ProjectMcpConfigManager(workspace);

    await manager.create("docs", { url: "https://mcp.example.com/mcp", headers: { Authorization: "${MCP_TOKEN}" } });
    await manager.create("local", { command: "node", args: ["server.mjs"], env: { MODE: "test" } });
    expect(await manager.list()).toEqual([
      expect.objectContaining({ name: "docs", transport: "http", enabled: true }),
      expect.objectContaining({ name: "local", transport: "stdio", enabled: true }),
    ]);

    await manager.update("local", "workspace", {
      command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."], cwd: ".", timeoutMs: 5_000,
    });
    await manager.setEnabled("docs", false);
    await manager.update("docs", "docs", { url: "https://new.example.com/mcp" });
    await manager.delete("workspace");

    expect(await manager.list()).toEqual([
      expect.objectContaining({ name: "docs", enabled: false, config: expect.objectContaining({
        url: "https://new.example.com/mcp", disabled: true,
      }) }),
    ]);
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.language).toBe("zh-CN");
    expect(stored.mcpServers.docs.headers.Authorization).toBe("${MCP_TOKEN}");
    expect(stored.mcpServers.workspace).toBeUndefined();
  });

  it("refuses duplicate creates, missing updates/deletes, and invalid mixed transports", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-mcp-config-errors-"));
    const manager = new ProjectMcpConfigManager(workspace);
    await manager.create("docs", { command: "node" });

    await expect(manager.create("docs", { command: "bun" })).rejects.toThrow(/already exists/i);
    await expect(manager.update("missing", "next", { command: "node" })).rejects.toThrow(/not found/i);
    await expect(manager.delete("missing")).rejects.toThrow(/not found/i);
    await expect(manager.create("mixed", { command: "node", url: "https://example.com" } as never)).rejects.toThrow();
  });

  it("serializes concurrent mutations and keeps a recoverable backup", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-mcp-config-lock-"));
    const manager = new ProjectMcpConfigManager(workspace);

    await Promise.all([
      manager.create("alpha", { command: "node", args: ["alpha.mjs"] }),
      manager.create("beta", { url: "https://beta.example.com/mcp" }),
    ]);

    expect((await manager.list()).map((server) => server.name)).toEqual(["alpha", "beta"]);
    expect(JSON.parse(await readFile(`${manager.path}.bak`, "utf8"))).toHaveProperty("mcpServers");
  });
});
