import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PluginHost } from "../../src/plugins/host.js";

const baseManifest = {
  version: "1.0.0",
  apiVersion: "1",
  main: "index.mjs",
  permissions: [],
  contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
} as const;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flavor-plugins-"));
  const global = join(root, "global");
  const project = join(root, "project");
  await Promise.all([mkdir(global), mkdir(project)]);
  return { root, global, project };
}

async function plugin(parent: string, name: string, source: string, manifest: Record<string, unknown> = {}) {
  const root = join(parent, name);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "flavor-plugin.json"), JSON.stringify({ ...baseManifest, name, ...manifest }));
  await writeFile(join(root, "index.mjs"), source);
  return root;
}

function registrations() {
  const active: string[] = [];
  const register = vi.fn((name: string) => {
    active.push(name);
    return () => { active.splice(active.indexOf(name), 1); };
  });
  return { active, register, callbacks: {
    command: register, tool: register, hook: register, skillRoot: register, modelAdapter: register,
  } };
}

describe("PluginHost", () => {
  it("discovers deterministically with project overrides and disabled plugins", async () => {
    const f = await fixture();
    await plugin(f.global, "zeta", "export function activate(ctx) { ctx.registerCommand('zeta', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "zeta" }] },
    });
    await plugin(f.global, "shared", "throw new Error('global override must not load')");
    await plugin(f.project, "shared", "export function activate(ctx) { ctx.registerCommand('shared', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "shared" }] },
    });
    await plugin(f.project, "disabled", "throw new Error('disabled must not load')");
    const r = registrations();
    const host = new PluginHost({
      globalPluginDirs: [f.global], projectPluginDirs: [f.project], disabledPlugins: ["disabled"],
      registrations: r.callbacks,
    });

    await host.loadAll();

    expect(host.loadedPlugins.map(({ name, source }) => [name, source])).toEqual([
      ["shared", "project"], ["zeta", "global"],
    ]);
    expect(r.active).toEqual(["shared", "zeta"]);
    expect(host.diagnostics).toEqual([]);
  });

  it("rejects unsupported APIs and isolates activation failures", async () => {
    const f = await fixture();
    await plugin(f.project, "bad-api", "export function activate() {}", { apiVersion: "2" });
    await plugin(f.project, "broken", "export function activate() { throw new Error('boom'); }");
    await plugin(f.project, "healthy", "export function activate(ctx) { ctx.registerTool('healthy', {}); }", {
      contributes: { ...baseManifest.contributes, tools: [{ name: "healthy" }] },
    });
    const r = registrations();
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: r.callbacks });

    await expect(host.loadAll()).resolves.toBeUndefined();

    expect(host.loadedPlugins.map(({ name }) => name)).toEqual(["healthy"]);
    expect(r.active).toEqual(["healthy"]);
    expect(host.diagnostics.map(({ plugin, message }) => [plugin, message])).toEqual([
      ["bad-api", expect.stringMatching(/apiVersion/i)],
      ["broken", expect.stringContaining("boom")],
    ]);
  });

  it("loads configured npm packages only through the injected resolver", async () => {
    const f = await fixture();
    const packageRoot = await plugin(f.root, "npm-plugin", "export function activate(ctx) { ctx.registerCommand('npm-command', {}); }", {
      name: "npm-plugin", contributes: { ...baseManifest.contributes, commands: [{ name: "npm-command" }] },
    });
    const resolver = vi.fn(async (specifier: string) => specifier === "my-plugin" ? packageRoot : undefined);
    const r = registrations();
    const host = new PluginHost({ npmPackages: ["my-plugin"], resolveNpmPackage: resolver, registrations: r.callbacks });

    await host.loadAll();

    expect(resolver).toHaveBeenCalledWith("my-plugin");
    expect(host.loadedPlugins).toMatchObject([{ name: "npm-plugin", source: "npm" }]);
  });

  it("validates declared contributions, detects conflicts, and rolls failed plugins back", async () => {
    const f = await fixture();
    await plugin(f.project, "alpha", "export function activate(ctx) { ctx.registerCommand('same', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "same" }] },
    });
    await plugin(f.project, "conflict", "export function activate(ctx) { ctx.registerCommand('same', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "same" }] },
    });
    await plugin(f.project, "undeclared", "export function activate(ctx) { ctx.registerTool('surprise', {}); }");
    const r = registrations();
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: r.callbacks });

    await host.loadAll();

    expect(host.loadedPlugins.map(({ name }) => name)).toEqual(["alpha"]);
    expect(r.active).toEqual(["same"]);
    expect(host.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ plugin: "conflict", message: expect.stringMatching(/conflict/i) }),
      expect.objectContaining({ plugin: "undeclared", message: expect.stringMatching(/not declared/i) }),
    ]));
  });

  it("provides scoped logging, redacted immutable config, mediated filesystem, lifecycle events, and idempotent unload", async () => {
    const f = await fixture();
    const readable = join(f.root, "readable.txt");
    await writeFile(readable, "safe");
    await plugin(f.project, "context", `export async function activate(ctx) {
      if (Object.keys(ctx).sort().join(',') !== 'config,logger,registerCommand,registerHook,registerModelAdapter,registerSkillRoot,registerTool,services') throw new Error('context leaked');
      ctx.logger.info('loaded');
      if (ctx.config.providers.openai.apiKey !== '[redacted]') throw new Error('secret leaked');
      await ctx.services.filesystem.readFile(${JSON.stringify(readable)}, 'utf8');
      ctx.registerCommand('context', {});
      return () => ctx.logger.info('deactivated');
    }`, {
      permissions: ["filesystem:read"],
      contributes: { ...baseManifest.contributes, commands: [{ name: "context" }] },
    });
    const r = registrations();
    const log = vi.fn();
    const lifecycle: string[] = [];
    const host = new PluginHost({
      projectPluginDirs: [f.project], registrations: r.callbacks,
      config: { providers: { openai: { apiKey: "secret" } } },
      logger: { debug: log, info: log, warn: log, error: log },
      authorizeFilesystem: async ({ plugin, operation, path }) => plugin === "context" && operation === "read" && path === readable,
      emitLifecycle: async (type) => { lifecycle.push(type); },
    });

    await host.loadAll();
    await host.unload("context");
    await host.unload("context");

    expect(r.active).toEqual([]);
    expect(lifecycle).toEqual(["PluginLoad", "PluginUnload"]);
    expect(log).toHaveBeenCalledWith("[plugin:context] loaded");
    expect(log).toHaveBeenCalledWith("[plugin:context] deactivated");
  });

  it("rejects malformed manifests and entry paths that escape through traversal or symlinks", async () => {
    const f = await fixture();
    await plugin(f.project, "traversal", "export function activate() {}", { main: "../index.mjs" });
    const outsideRoot = join(f.root, "outside");
    await mkdir(outsideRoot);
    await writeFile(join(outsideRoot, "index.mjs"), "export function activate() {}");
    const linkedRoot = await plugin(f.project, "linked", "export function activate() {}");
    await writeFile(join(linkedRoot, "flavor-plugin.json"), JSON.stringify({ ...baseManifest, name: "linked", main: "escape/index.mjs" }));
    await symlink(outsideRoot, join(linkedRoot, "escape"), "junction");
    const extra = await plugin(f.project, "extra", "export function activate() {}");
    await writeFile(join(extra, "flavor-plugin.json"), JSON.stringify({ ...baseManifest, name: "extra", unexpected: true }));
    await plugin(f.project, "skill-escape", "export function activate(ctx) { ctx.registerSkillRoot('skills', '../outside'); }", {
      contributes: { ...baseManifest.contributes, skillRoots: [{ name: "skills", path: "skills" }] },
    });
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: registrations().callbacks });

    await host.loadAll();

    expect(host.loadedPlugins).toEqual([]);
    expect(host.diagnostics).toHaveLength(4);
    expect(host.diagnostics.map(({ message }) => message).join(" ")).toMatch(/entry|unrecognized|unexpected/i);
  });
});
