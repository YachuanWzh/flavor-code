import { access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runPluginInSandbox, startPluginSandbox } from "../../src/plugins/worker-host.js";

describe("runPluginInSandbox", () => {
  it("runs a simple plugin and returns registration results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, `
      export function activate(ctx) {
        ctx.registerTool("my-tool", { name: "my-tool", description: "test", execute: async (input) => ({ input }) });
        ctx.registerCommand("my-command", (args) => args.join(":"));
      }
    `);
    try {
      const result = await runPluginInSandbox({
        entryPath: entry,
        pluginName: "test-plugin",
        pluginVersion: "0.1.0",
        activationTimeoutMs: 10_000,
      });
      expect(result.ok).toBe(true);
      expect(result.name).toBe("test-plugin");
      expect(result.version).toBe("0.1.0");
      expect(result.registeredTools).toContain("my-tool");
      expect(result.registeredCommands).toContain("my-command");
      expect(result.registeredHooks).toEqual([]);
      expect(result.registeredSkillRoots).toEqual([]);
      expect(result.registeredModelAdapters).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns an error when the plugin throws during activation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, `
      export function activate(ctx) {
        throw new Error("sandbox-test-error");
      }
    `);
    try {
      const result = await runPluginInSandbox({
        entryPath: entry,
        pluginName: "broken-plugin",
        pluginVersion: "0.1.0",
        activationTimeoutMs: 10_000,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/sandbox-test-error/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("blocks ESM imports of Node.js internals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    const escape = join(dir, "..", "sandbox-escape.txt");
    await writeFile(entry, `
      export async function activate() {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(${JSON.stringify(escape)}, "pwned");
      }
    `);
    try {
      const result = await runPluginInSandbox({
        entryPath: entry,
        pluginName: "escape-plugin",
        pluginVersion: "0.1.0",
        activationTimeoutMs: 5_000,
      });
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/blocks external module import.*node:fs/i);
      await expect(access(escape)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(escape, { force: true });
    }
  });

  it("times out when a plugin hangs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, `
      export function activate(ctx) {
        // hang forever — never calls back
        return new Promise(() => {});
      }
    `);
    try {
      await expect(runPluginInSandbox({
        entryPath: entry,
        pluginName: "hanging-plugin",
        pluginVersion: "0.1.0",
        activationTimeoutMs: 500,
      })).rejects.toThrow(/timed out/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not expose process, Buffer, fetch, or code generation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, `
      export function activate(ctx) {
        if (typeof process !== "undefined" || typeof Buffer !== "undefined" || typeof fetch !== "undefined") throw new Error("host global leaked");
        let generated = false;
        try { Function("return 1")(); generated = true; } catch {}
        if (generated) throw new Error("code generation leaked");
      }
    `);
    try {
      const result = await runPluginInSandbox({
        entryPath: entry,
        pluginName: "mem-plugin",
        pluginVersion: "0.1.0",
        activationTimeoutMs: 30_000,
        maxOldSpaceMb: 128,
      });
      expect(result.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps the sandbox alive and invokes registered handlers through RPC", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-worker-test-"));
    const entry = join(dir, "index.js");
    await writeFile(entry, `export function activate(ctx) {
      ctx.registerCommand("join", (args) => args.join("/"));
      return () => undefined;
    }`);
    const session = await startPluginSandbox({ entryPath: entry, pluginName: "rpc", pluginVersion: "1.0.0" });
    try { expect(await session.invoke("command", "join", [["a", "b"], { workspace: "test" }])).toBe("a/b"); }
    finally { await session.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
});
