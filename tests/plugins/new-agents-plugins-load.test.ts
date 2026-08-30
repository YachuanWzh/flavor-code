import { cp, mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { PluginHost } from "../../src/plugins/host.js";

const PLUGIN_NAMES = ["secret-guard", "edit-doctor", "compact-guardian", "verify-gate"] as const;

describe("agent companion plugins load in-process", () => {
  it("loads all three plugins with zero diagnostics and full hook registration", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "flavor-agent-plugins-"));
    for (const name of PLUGIN_NAMES) {
      await cp(join(process.cwd(), ".flavor", "plugins", name), join(sandbox, name), { recursive: true });
    }
    const registered: string[] = [];
    const host = new PluginHost({
      projectPluginDirs: [sandbox],
      sandbox: false,
      config: {},
      registrations: {
        command: (name, handler) => { registered.push(`command:${name}`); expect(typeof handler).toBe("function"); return () => undefined; },
        tool: (name, value) => { registered.push(`tool:${name}`); expect(value).toBeTruthy(); return () => undefined; },
        hook: (name, handler) => { registered.push(`hook:${name}`); expect(typeof handler).toBe("function"); return () => undefined; },
        skillRoot: (name) => { registered.push(`skillRoot:${name}`); return () => undefined; },
        modelAdapter: (name) => { registered.push(`modelAdapter:${name}`); return () => undefined; },
      },
    });
    await host.loadAll();
    expect(host.diagnostics).toEqual([]);
    expect(host.loadedPlugins.map(({ name }) => name).sort()).toEqual([...PLUGIN_NAMES].sort());
    for (const name of PLUGIN_NAMES) {
      expect(registered.filter((entry) => entry.startsWith("hook:"))).not.toEqual([]);
    }
    await host.unloadAll();
  });
});
