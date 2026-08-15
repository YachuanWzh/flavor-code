import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { activate } from "../../../src/init/astgraph/index.js";

const workspace = mkdtempSync(join(tmpdir(), "astgraph-plugin-"));

function write(relPath, content) {
  mkdirSync(join(workspace, relPath, ".."), { recursive: true });
  writeFileSync(join(workspace, relPath), content, "utf8");
}

/** Minimal stand-in for the flavor-code PluginContext. */
function createHostContext() {
  const commands = new Map();
  const tools = new Map();
  const hooks = new Map();
  return {
    commands, tools, hooks,
    context: {
      workspace,
      signal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      registerCommand: (name, handler) => { commands.set(name, handler); return () => commands.delete(name); },
      registerTool: (name, tool) => { tools.set(name, tool); return () => tools.delete(name); },
      registerHook: (name, handler) => { hooks.set(name, handler); return () => hooks.delete(name); },
    },
  };
}

let host;
let deactivate;

beforeEach(async () => {
  host = createHostContext();
  deactivate = await activate(host.context);
  // The host emits SessionStart with the workspace; tools/hooks cache it there.
  await host.hooks.get("SessionStart")({
    version: 1, type: "SessionStart", payload: { workspace },
  }, AbortSignal.timeout(5_000));
});

afterAll(async () => {
  if (deactivate !== undefined) await deactivate();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("astgraph plugin wiring", () => {
  it("registers the command, five tools and two hooks", () => {
    expect([...host.commands.keys()]).toEqual(["ast"]);
    expect([...host.tools.keys()].sort()).toEqual(["ast_callees", "ast_callers", "ast_context", "ast_impact", "ast_search"]);
    expect([...host.hooks.keys()].sort()).toEqual(["PostToolUse", "SessionStart"]);
    // Query tools are pure reads: they must carry the read-only declaration so
    // the permission engine allows them like Read/Glob/Grep without approval.
    for (const tool of host.tools.values()) expect(tool.readOnly).toBe(true);
  });

  it("/ast help returns usage without requiring an index", async () => {
    const result = await host.commands.get("ast")(["help"], { workspace, signal: AbortSignal.timeout(1000) });
    expect(result.usage.length).toBeGreaterThanOrEqual(5);
  });

  it("/ast init builds the graph and tools query it", async () => {
    write("src/util.ts", "export function helper(): void {}\n");
    write("src/main.ts", `import { helper } from "./util.js";\nexport function main(): void { helper(); }\n`);

    const initResult = await host.commands.get("ast")(["init"], { workspace, signal: AbortSignal.timeout(30_000) });
    expect(initResult.files).toBe(2);

    const searchTool = host.tools.get("ast_search");
    const parsed = searchTool.inputSchema.parse({ query: "helper" });
    const searchOut = await searchTool.execute(parsed, AbortSignal.timeout(10_000));
    expect(searchOut.results.some((node) => node.id === "src/util.ts#helper")).toBe(true);

    const callersTool = host.tools.get("ast_callers");
    const callersOut = await callersTool.execute(callersTool.inputSchema.parse({ id: "src/util.ts#helper" }), AbortSignal.timeout(10_000));
    expect(callersOut.callers.map((node) => node.id)).toContain("src/main.ts#main");

    const contextTool = host.tools.get("ast_context");
    const contextOut = await contextTool.execute(contextTool.inputSchema.parse({ id: "src/main.ts#main" }), AbortSignal.timeout(10_000));
    expect(contextOut.context.some((entry) => entry.filePath === "src/util.ts")).toBe(true);

    const status = await host.commands.get("ast")(["status"], { workspace, signal: AbortSignal.timeout(10_000) });
    expect(status.indexed).toBe(true);
    expect(status.nodes).toBeGreaterThanOrEqual(2);
  });

  it("PostToolUse hook re-syncs edited files", async () => {
    write("src/extra.ts", "export function fresh(): void {}\n");
    await host.commands.get("ast")(["sync"], { workspace, signal: AbortSignal.timeout(30_000) });

    write("src/extra.ts", "export function fresh(): void {}\nexport function fresh2(): void {}\n");
    const hook = host.hooks.get("PostToolUse");
    const decision = await hook({
      version: 1,
      type: "PostToolUse",
      payload: { tool: "Write", input: { path: join(workspace, "src/extra.ts") }, output: {} },
    }, AbortSignal.timeout(30_000));
    expect(decision.decision).toBe("allow");

    // Sync is serialized on an internal promise; wait one tick for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = await host.commands.get("ast")(["search", "fresh2"], { workspace, signal: AbortSignal.timeout(10_000) });
    expect(result.results.some((node) => node.id === "src/extra.ts#fresh2")).toBe(true);
  });

  it("tools report a clear error before init on a fresh workspace", async () => {
    const freshWorkspace = mkdtempSync(join(tmpdir(), "astgraph-fresh-"));
    const freshHost = createHostContext();
    freshHost.context.workspace = freshWorkspace;
    const freshDeactivate = await activate(freshHost.context);
    await freshHost.hooks.get("SessionStart")({
      version: 1, type: "SessionStart", payload: { workspace: freshWorkspace },
    }, AbortSignal.timeout(5_000));
    try {
      const out = await freshHost.tools.get("ast_search").execute({ query: "anything" }, AbortSignal.timeout(5_000));
      expect(out.ok).toBe(false);
      expect(out.error).toContain("/ast init");
    } finally {
      await freshDeactivate();
      rmSync(freshWorkspace, { recursive: true, force: true });
    }
  });
});
