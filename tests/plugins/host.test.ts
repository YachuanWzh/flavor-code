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
    expect(host.diagnostics).toEqual([
      expect.objectContaining({ plugin: "shared", message: expect.stringMatching(/global.*overridden.*project/i) }),
    ]);
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
      if (Object.keys(ctx).sort().join(',') !== 'config,logger,registerCommand,registerHook,registerModelAdapter,registerSkillRoot,registerTool,services,signal') throw new Error('context leaked');
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

  it("rejects duplicate names within a tier, reports cross-tier overrides, and uses project over npm over global", async () => {
    const f = await fixture();
    const secondGlobal = join(f.root, "global-two");
    await mkdir(secondGlobal);
    await plugin(f.global, "duplicate-a", "export function activate() {}", { name: "duplicate" });
    await plugin(secondGlobal, "duplicate-b", "export function activate() {}", { name: "duplicate" });
    await plugin(f.global, "shared", "export function activate() {}");
    const npmRoot = await plugin(f.root, "npm-shared", "export function activate() {}", { name: "shared" });
    await plugin(f.project, "shared", "export function activate() {}", { name: "shared" });
    const host = new PluginHost({
      globalPluginDirs: [secondGlobal, f.global], projectPluginDirs: [f.project], npmPackages: ["pkg"],
      resolveNpmPackage: async () => npmRoot, registrations: registrations().callbacks,
    });

    await host.loadAll();

    expect(host.loadedPlugins).toMatchObject([{ name: "shared", source: "project" }]);
    expect(host.diagnostics.filter(({ plugin }) => plugin === "duplicate")).toHaveLength(2);
    expect(host.diagnostics.filter(({ plugin, message }) => plugin === "shared" && /overrid/i.test(message))).toHaveLength(2);
  });

  it("rejects duplicate manifest arrays and unknown hook contribution names", async () => {
    const f = await fixture();
    await plugin(f.project, "duplicate", "export function activate() {}", {
      permissions: ["filesystem:read", "filesystem:read"],
      contributes: { ...baseManifest.contributes, commands: [{ name: "same" }, { name: "same" }] },
    });
    await plugin(f.project, "hook", "export function activate() {}", {
      contributes: { ...baseManifest.contributes, hooks: [{ name: "NotARealHook" }] },
    });
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: registrations().callbacks });

    await host.loadAll();

    expect(host.loadedPlugins).toEqual([]);
    expect(host.diagnostics).toHaveLength(2);
  });

  it("rejects oversized and non-UTF8 manifests", async () => {
    const f = await fixture();
    const oversized = await plugin(f.project, "oversized", "export function activate() {}");
    await writeFile(join(oversized, "flavor-plugin.json"), Buffer.alloc(64 * 1024 + 1, 0x20));
    const invalid = await plugin(f.project, "invalid-utf8", "export function activate() {}");
    await writeFile(join(invalid, "flavor-plugin.json"), Buffer.from([0xff, 0xfe]));
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: registrations().callbacks });

    await host.loadAll();

    expect(host.loadedPlugins).toEqual([]);
    expect(host.diagnostics).toHaveLength(2);
    expect(host.diagnostics.map(({ message }) => message).join(" ")).toMatch(/exceeds|encoded|utf-?8/i);
  });

  it("times out activation, aborts and deactivates its context, and continues loading", async () => {
    const f = await fixture();
    await plugin(f.project, "import-hanging", "await new Promise(() => {}); export function activate() {}");
    await plugin(f.project, "hanging", `export async function activate(ctx) {
      globalThis.hangingSignal = ctx.signal;
      ctx.registerCommand('early', {});
      ctx.signal.addEventListener('abort', () => {
        try { ctx.registerCommand('late', {}); } catch { globalThis.lateRejected = true; }
      }, { once: true });
      return new Promise(() => {});
    }`, { contributes: { ...baseManifest.contributes, commands: [{ name: "early" }, { name: "late" }] } });
    const r = registrations();
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: r.callbacks, activationTimeoutMs: 10 });

    await host.loadAll();
    expect(host.loadedPlugins).toEqual([]);
    expect(r.active).toEqual([]);
    expect(host.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ plugin: "hanging", message: expect.stringMatching(/timeout/i) })]));
    expect(host.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ plugin: "import-hanging", message: expect.stringMatching(/timeout/i) })]));
    expect((globalThis as Record<string, unknown>).lateRejected).toBe(true);
    expect(((globalThis as unknown as Record<string, AbortSignal | undefined>).hangingSignal)?.aborted).toBe(true);
    delete (globalThis as Record<string, unknown>).lateRejected;
    delete (globalThis as Record<string, unknown>).hangingSignal;
  });

  it("runs a disposer returned by activation after its timeout exactly once", async () => {
    const f = await fixture();
    await plugin(f.project, "late-cleanup", `export async function activate(ctx) {
      globalThis.lateEffect = true;
      return new Promise((resolve) => ctx.signal.addEventListener('abort', () => resolve(() => {
          globalThis.lateEffect = false;
          globalThis.lateCleanupCount = (globalThis.lateCleanupCount ?? 0) + 1;
          return new Promise(() => {});
        }), { once: true }));
    }`);
    await plugin(f.project, "healthy-late", "export function activate(ctx) { ctx.registerCommand('healthy-late', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "healthy-late" }] },
    });
    const r = registrations();
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: r.callbacks, activationTimeoutMs: 10, unloadTimeoutMs: 10 });

    await host.loadAll();
    await vi.waitFor(() => {
      expect((globalThis as Record<string, unknown>).lateCleanupCount).toBe(1);
      expect(host.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ plugin: "late-cleanup", message: expect.stringMatching(/late plugin activation cleanup timeout/i) }),
      ]));
    });

    expect(host.loadedPlugins.map(({ name }) => name)).toEqual(["healthy-late"]);
    expect(r.active).toEqual(["healthy-late"]);
    expect((globalThis as Record<string, unknown>).lateEffect).toBe(false);
    delete (globalThis as Record<string, unknown>).lateEffect;
    delete (globalThis as Record<string, unknown>).lateCleanupCount;
  });

  it("diagnoses invalid results and rejections from activation after its timeout", async () => {
    const f = await fixture();
    await plugin(f.project, "late-invalid", `export async function activate() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "not-a-disposer";
    }`);
    await plugin(f.project, "late-rejection", `export async function activate() {
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw new Error("late boom");
    }`);
    const host = new PluginHost({
      projectPluginDirs: [f.project], registrations: registrations().callbacks,
      activationTimeoutMs: 10, unloadTimeoutMs: 10,
    });

    await host.loadAll();
    await vi.waitFor(() => {
      expect(host.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ plugin: "late-invalid", message: expect.stringMatching(/late.*invalid disposer/i) }),
        expect.objectContaining({ plugin: "late-rejection", message: expect.stringMatching(/late.*rejected.*late boom/i) }),
      ]));
    });
  });

  it("prevents filesystem I/O when unload occurs during awaited authorization", async () => {
    const f = await fixture();
    const readable = join(f.root, "deferred-readable.txt");
    await writeFile(readable, "must-not-read");
    await plugin(f.project, "deferred-fs", `export function activate(ctx) {
      globalThis.deferredRead = ctx.services.filesystem.readFile(${JSON.stringify(readable)}, 'utf8');
    }`, { permissions: ["filesystem:read"] });
    let allow!: (value: boolean) => void;
    const authorization = new Promise<boolean>((resolve) => { allow = resolve; });
    const host = new PluginHost({
      projectPluginDirs: [f.project], registrations: registrations().callbacks,
      authorizeFilesystem: async () => authorization,
    });

    await host.loadAll();
    await host.unload("deferred-fs");
    allow(true);

    await expect((globalThis as unknown as Record<string, Promise<unknown>>).deferredRead).rejects.toThrow(/no longer active/i);
    delete (globalThis as Record<string, unknown>).deferredRead;
  });

  it("detects entry replacement during import and rolls registrations back", async () => {
    const f = await fixture();
    await plugin(f.project, "replaced", `import { writeFile } from 'node:fs/promises'; import { fileURLToPath } from 'node:url';
      await writeFile(fileURLToPath(import.meta.url), 'export function activate() {}\\n');
      export function activate(ctx) { ctx.registerCommand('replaced', {}); }`, {
      contributes: { ...baseManifest.contributes, commands: [{ name: "replaced" }] },
    });
    const r = registrations();
    const host = new PluginHost({ projectPluginDirs: [f.project], registrations: r.callbacks });

    await host.loadAll();

    expect(host.loadedPlugins).toEqual([]);
    expect(r.active).toEqual([]);
    expect(host.diagnostics[0]?.message).toMatch(/changed|identity/i);
  });

  it("bounds hanging unload disposers and lifecycle callbacks while continuing unloadAll", async () => {
    const f = await fixture();
    await plugin(f.project, "alpha", "export function activate(ctx) { ctx.registerCommand('alpha', {}); return () => new Promise(() => {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "alpha" }] },
    });
    await plugin(f.project, "beta", "export function activate(ctx) { ctx.registerCommand('beta', {}); }", {
      contributes: { ...baseManifest.contributes, commands: [{ name: "beta" }] },
    });
    const r = registrations();
    const host = new PluginHost({
      projectPluginDirs: [f.project], registrations: r.callbacks, unloadTimeoutMs: 10,
      emitLifecycle: (type, loaded) => type === "PluginUnload" && loaded.name === "beta" ? new Promise(() => {}) : undefined,
    });
    await host.loadAll();

    await host.unloadAll();

    expect(host.loadedPlugins).toEqual([]);
    expect(r.active).toEqual([]);
    expect(host.diagnostics.filter(({ message }) => /timeout/i.test(message))).toHaveLength(2);
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
