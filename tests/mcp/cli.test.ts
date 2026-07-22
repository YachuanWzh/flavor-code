import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerMcpCommands } from "../../src/mcp/cli.js";

describe("flavor MCP CLI", () => {
  it("adds stdio and HTTP services with repeatable structured options", async () => {
    const output: string[] = [];
    const manager = {
      path: "C:\\work\\.flavor\\flavor.json",
      list: vi.fn(async () => []), create: vi.fn(async () => undefined), update: vi.fn(),
      setEnabled: vi.fn(), delete: vi.fn(),
    };
    const program = new Command().exitOverride();
    registerMcpCommands(program, { open: () => manager, write: (text) => output.push(text) });

    await program.parseAsync(["node", "flavor", "mcp", "add", "local", "--command", "npx", "--arg=-y", "--arg", "server", "--env", "TOKEN=${TOKEN}", "--cwd", ".", "--timeout", "5000"]);
    await program.parseAsync(["node", "flavor", "mcp", "add", "remote", "--url", "https://mcp.example.com/mcp", "--header", "Authorization=Bearer ${TOKEN}"]);

    expect(manager.create).toHaveBeenNthCalledWith(1, "local", {
      command: "npx", args: ["-y", "server"], env: { TOKEN: "${TOKEN}" }, cwd: ".", timeoutMs: 5_000,
    });
    expect(manager.create).toHaveBeenNthCalledWith(2, "remote", {
      url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer ${TOKEN}" },
    });
    expect(output.join("")).toContain("Added MCP service local");
  });

  it("lists, updates, toggles, deletes, and prints the shared project path", async () => {
    const output: string[] = [];
    const manager = {
      path: "C:\\work\\.flavor\\flavor.json",
      list: vi.fn(async () => [{ name: "docs", transport: "http", enabled: true, config: { url: "https://example.com", disabled: false, timeoutMs: 60_000 } }]),
      create: vi.fn(), update: vi.fn(async () => undefined), setEnabled: vi.fn(async () => undefined), delete: vi.fn(async () => undefined),
    };
    const program = new Command().exitOverride();
    registerMcpCommands(program, { open: () => manager, write: (text) => output.push(text) });

    await program.parseAsync(["node", "flavor", "mcp", "list"]);
    await program.parseAsync(["node", "flavor", "mcp", "update", "docs", "--url", "https://new.example.com/mcp"]);
    await program.parseAsync(["node", "flavor", "mcp", "disable", "docs"]);
    await program.parseAsync(["node", "flavor", "mcp", "enable", "docs"]);
    await program.parseAsync(["node", "flavor", "mcp", "delete", "docs"]);
    await program.parseAsync(["node", "flavor", "mcp", "path"]);

    expect(manager.update).toHaveBeenCalledWith("docs", "docs", { url: "https://new.example.com/mcp" });
    expect(manager.setEnabled).toHaveBeenNthCalledWith(1, "docs", false);
    expect(manager.setEnabled).toHaveBeenNthCalledWith(2, "docs", true);
    expect(manager.delete).toHaveBeenCalledWith("docs");
    expect(output.join("")).toContain("on   docs  http");
    expect(output.at(-1)).toBe("C:\\work\\.flavor\\flavor.json\n");
  });

  it("rejects mixed or absent transports before persistence", async () => {
    const manager = { path: "x", list: vi.fn(), create: vi.fn(), update: vi.fn(), setEnabled: vi.fn(), delete: vi.fn() };
    const program = new Command().exitOverride();
    registerMcpCommands(program, { open: () => manager, write: () => undefined });

    await expect(program.parseAsync(["node", "flavor", "mcp", "add", "bad", "--command", "node", "--url", "https://example.com"])).rejects.toThrow(/exactly one/i);
    expect(manager.create).not.toHaveBeenCalled();
  });
});
