import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

import { registerMemoryCommands } from "../../src/memory/cli.js";
import type { MemoryEntry } from "../../src/memory/types.js";

function entry(id: string, type: MemoryEntry["type"], content: string): MemoryEntry {
  return { id, type, content };
}

describe("flavor memory CLI", () => {
  it("lists memory in human and JSON formats", async () => {
    const output: string[] = [];
    const manager = {
      snapshot: vi.fn(async () => ({ enabled: true, path: "C:\\work\\.flavor\\memory\\MEMORY.md", entries: [entry("abc123abc123", "project", "Use pnpm.")] })),
      remember: vi.fn(), update: vi.fn(), delete: vi.fn(),
    };
    const program = new Command().exitOverride();
    registerMemoryCommands(program, { open: async () => manager, cwd: () => "C:\\work", home: () => "C:\\home", write: (text) => output.push(text) });

    await program.parseAsync(["node", "flavor", "memory", "list"]);
    expect(output.join("")).toContain("abc123abc123  project  Use pnpm.");
    output.length = 0;
    await program.parseAsync(["node", "flavor", "memory", "list", "--json"]);

    expect(JSON.parse(output.join(""))).toEqual(expect.objectContaining({ entries: [expect.objectContaining({ content: "Use pnpm." })] }));
  });

  it("adds, updates, deletes, and prints the backing file path", async () => {
    const output: string[] = [];
    const manager = {
      snapshot: vi.fn(async () => ({ enabled: true, path: "C:\\work\\.flavor\\memory\\MEMORY.md", entries: [] })),
      remember: vi.fn(async () => entry("111111111111", "project", "Use pnpm for scripts.")),
      update: vi.fn(async () => entry("222222222222", "feedback", "Never commit automatically.")),
      delete: vi.fn(async () => true),
    };
    const program = new Command().exitOverride();
    registerMemoryCommands(program, { open: async () => manager, cwd: () => "C:\\work", home: () => "C:\\home", write: (text) => output.push(text) });

    await program.parseAsync(["node", "flavor", "memory", "add", "project", "Use", "pnpm", "for", "scripts."]);
    await program.parseAsync(["node", "flavor", "memory", "update", "111111111111", "feedback", "Never", "commit", "automatically."]);
    await program.parseAsync(["node", "flavor", "memory", "delete", "222222222222"]);
    await program.parseAsync(["node", "flavor", "memory", "path"]);

    expect(manager.remember).toHaveBeenCalledWith({ type: "project", content: "Use pnpm for scripts." });
    expect(manager.update).toHaveBeenCalledWith("111111111111", { type: "feedback", content: "Never commit automatically." });
    expect(manager.delete).toHaveBeenCalledWith("222222222222");
    expect(output.at(-1)).toBe("C:\\work\\.flavor\\memory\\MEMORY.md\n");
  });
});
