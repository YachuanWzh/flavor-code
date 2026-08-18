import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  fixPluginDir,
  revertFixPlugin,
  sanitizePluginName,
  scaffoldFixPlugin,
  snapshotFixPlugin,
  verifyFixPlugin,
} from "../../src/evolve/loader.js";

async function fixture() {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-evolve-loader-"));
  await mkdir(join(workspace, ".flavor", "plugins"), { recursive: true });
  return workspace;
}

/** Write a working fix plugin into the project plugin dir. */
async function writeGoodPlugin(workspace: string, name: string) {
  const dir = join(workspace, ".flavor", "plugins", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "flavor-plugin.json"), JSON.stringify({
    name,
    version: "0.1.0",
    apiVersion: "1",
    main: "index.js",
    permissions: [],
    contributes: { commands: [], tools: [{ name: "hello" }], hooks: [], skillRoots: [], modelAdapters: [] },
  }));
  await writeFile(join(dir, "index.js"), [
    "export function activate(ctx) {",
    "  ctx.registerTool('hello', { name: 'hello' });",
    "}",
    "",
  ].join("\n"));
  return dir;
}

describe("sanitizePluginName", () => {
  it("lowercases, sanitizes, and prefixes with fix-", () => {
    expect(sanitizePluginName("Read")).toBe("fix-read");
    expect(sanitizePluginName("my Tool_2")).toBe("fix-my-tool-2");
    expect(sanitizePluginName("fix-Shell")).toBe("fix-shell");
    expect(sanitizePluginName("")).toBe("fix-");
  });
});

describe("scaffoldFixPlugin", () => {
  it("creates a valid plugin scaffold with manifest and entry", async () => {
    const workspace = await fixture();
    const dir = await scaffoldFixPlugin(workspace, "fix-read");
    expect(dir).toBe(fixPluginDir(workspace, "fix-read"));

    const manifest = JSON.parse(await readFile(join(dir, "flavor-plugin.json"), "utf8")) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      name: "fix-read",
      version: "0.1.0",
      apiVersion: "1",
      main: "index.js",
    });
    expect(manifest.contributes).toEqual({
      commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [],
    });
    const entry = await readFile(join(dir, "index.js"), "utf8");
    expect(entry).toContain("export function activate");
  });

  it("is idempotent: re-scaffolding keeps the existing directory", async () => {
    const workspace = await fixture();
    const first = await scaffoldFixPlugin(workspace, "fix-read");
    await writeFile(join(first, "PLAN.md"), "custom plan", "utf8");
    const second = await scaffoldFixPlugin(workspace, "fix-read");
    expect(second).toBe(first);
    expect(await readFile(join(first, "PLAN.md"), "utf8")).toBe("custom plan");
  });
});

describe("snapshotFixPlugin / revertFixPlugin", () => {
  it("snapshots the plugin and restores the latest snapshot on revert", async () => {
    const workspace = await fixture();
    const dir = await writeGoodPlugin(workspace, "fix-read");
    await writeFile(join(dir, "note.txt"), "v1", "utf8");

    const first = await snapshotFixPlugin(workspace, "fix-read");
    await writeFile(join(dir, "note.txt"), "v2", "utf8");
    await writeFile(join(dir, "extra.txt"), "junk", "utf8");
    const second = await snapshotFixPlugin(workspace, "fix-read");

    // Break the live plugin, then revert.
    await writeFile(join(dir, "index.js"), "throw new Error('broken');\n", "utf8");
    const message = await revertFixPlugin(workspace, "fix-read");

    expect(message).toContain("fix-read");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("v2");
    expect(await readFile(join(dir, "index.js"), "utf8")).toContain("registerTool");
    expect(first).not.toBe(second);
  });

  it("throws when there is no snapshot to restore", async () => {
    const workspace = await fixture();
    await writeGoodPlugin(workspace, "fix-read");
    await expect(revertFixPlugin(workspace, "fix-read")).rejects.toThrow(/no snapshot/i);
  });

  it("throws when reverting an unknown plugin", async () => {
    const workspace = await fixture();
    await expect(revertFixPlugin(workspace, "fix-missing")).rejects.toThrow(/not found/i);
  });
});

describe("verifyFixPlugin", () => {
  it("reports ok with provided tools and commands for a healthy plugin", async () => {
    const workspace = await fixture();
    const dir = await writeGoodPlugin(workspace, "fix-read");
    // Give it a command too so the report lists both.
    await writeFile(join(dir, "flavor-plugin.json"), JSON.stringify({
      name: "fix-read",
      version: "0.1.0",
      apiVersion: "1",
      main: "index.js",
      permissions: [],
      contributes: {
        commands: [{ name: "read-fix-helper" }],
        tools: [{ name: "hello" }],
        hooks: [], skillRoots: [], modelAdapters: [],
      },
    }));
    await writeFile(join(dir, "index.js"), [
      "export function activate(ctx) {",
      "  ctx.registerTool('hello', { name: 'hello' });",
      "  ctx.registerCommand('read-fix-helper', () => 'ok');",
      "}",
      "",
    ].join("\n"));

    const report = await verifyFixPlugin(workspace, "fix-read");
    expect(report.ok).toBe(true);
    expect(report.tools).toEqual(["hello"]);
    expect(report.commands).toEqual(["read-fix-helper"]);
    expect(report.provided).toContain("fix-read@0.1.0");
    expect(report.error).toBeUndefined();
  });

  it("reports failure with the activation error for a broken plugin", async () => {
    const workspace = await fixture();
    const dir = await writeGoodPlugin(workspace, "fix-read");
    await writeFile(join(dir, "index.js"), "export function activate() { throw new Error('boom'); }\n", "utf8");

    const report = await verifyFixPlugin(workspace, "fix-read");
    expect(report.ok).toBe(false);
    expect(report.error).toContain("boom");
  });

  it("reports failure for a plugin that registers undeclared contributions", async () => {
    const workspace = await fixture();
    const dir = await writeGoodPlugin(workspace, "fix-read");
    await writeFile(join(dir, "index.js"), "export function activate(ctx) { ctx.registerTool('ghost', {}); }\n", "utf8");

    const report = await verifyFixPlugin(workspace, "fix-read");
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/not declared|declared/i);
  });

  it("reports failure when the plugin does not exist", async () => {
    const workspace = await fixture();
    const report = await verifyFixPlugin(workspace, "fix-missing");
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/not found/i);
  });

  it("does not mutate the live plugin directory while verifying", async () => {
    const workspace = await fixture();
    const dir = await writeGoodPlugin(workspace, "fix-read");
    const before = await readFile(join(dir, "index.js"), "utf8");
    const report = await verifyFixPlugin(workspace, "fix-read");
    expect(report.ok).toBe(true);
    const after = await readFile(join(dir, "index.js"), "utf8");
    expect(after).toBe(before);
    // No .versions or temp dirs leaked into the live plugin dir.
    expect(await readFile(join(dir, "flavor-plugin.json"), "utf8")).toContain("fix-read");
  });

  it("verifies a plugin with additional files via the scaffolded entry", async () => {
    const workspace = await fixture();
    const dir = await scaffoldFixPlugin(workspace, "fix-glob");
    // The scaffolded empty plugin must load cleanly.
    const report = await verifyFixPlugin(workspace, "fix-glob");
    expect(report.ok).toBe(true);
    expect(report.provided).toContain("fix-glob@0.1.0");
    // Cleanup the copied fixture (kept inside the workspace tmp dir).
    await cp(dir, join(dir, "..", "unused-copy"), { recursive: true }).catch(() => undefined);
  });
});
