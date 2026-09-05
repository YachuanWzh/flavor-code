import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createLspTools, RealLspManager, type LspManager } from "../../src/tools/lsp.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function fakeManager(): LspManager {
  return {
    findReferences: async (_uri, line, character) => {
      if (line < 0) throw new Error("invalid position");
      return [
        { uri: "file:///project/src/foo.ts", range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } } },
        { uri: "file:///project/src/bar.ts", range: { start: { line: 10, character: 2 }, end: { line: 10, character: 7 } } },
      ];
    },
    hover: async (_uri, line, character) => {
      if (line === 999) return null; // no hover info
      return {
        contents: { kind: "markdown", language: "typescript", value: "```typescript\nconst x: number\n```" },
        range: { start: { line, character }, end: { line, character: character + 5 } },
      };
    },
    diagnostics: async (_uri) => {
      return [
        { range: { start: { line: 2, character: 10 }, end: { line: 2, character: 15 } }, severity: 1, message: "Type 'string' is not assignable to type 'number'.", source: "ts" },
        { range: { start: { line: 5, character: 0 }, end: { line: 5, character: 4 } }, severity: 2, message: "Unused variable 'foo'.", source: "eslint" },
      ];
    },
    dispose: () => {},
  };
}

describe("LSP tools", () => {
  it("renders array hover contents and native file URI paths", async () => {
    const workspace = join(tmpdir(), "flavor lsp unicode 中文");
    const path = join(workspace, "index.ts");
    const manager: LspManager = { ...fakeManager(),
      hover: async () => ({ contents: ["documentation", { language: "ts", value: "const x: number" }] }),
      findReferences: async () => [{ uri: pathToFileURL(path).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }],
    };
    const tools = createLspTools(workspace, { manager });
    const signal = new AbortController().signal;
    expect(await tools[0]!.execute({ file: "index.ts", line: 0, character: 0 }, signal)).toBe(`${path}:0:0`);
    expect(await tools[1]!.execute({ file: "index.ts", line: 0, character: 0 }, signal)).toBe("documentation\n\nconst x: number");
  });

  it("cancels an in-flight LSP wait promptly", async () => {
    const tools = createLspTools(tmpdir(), { manager: { ...fakeManager(), hover: async () => new Promise(() => {}) } });
    const controller = new AbortController();
    const result = tools[1]!.execute({ file: "x.ts", line: 0, character: 0 }, controller.signal);
    controller.abort(new Error("cancelled"));
    await expect(result).rejects.toThrow("cancelled");
  });
  it("LspFindRefs returns formatted reference locations", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const findRefs = tools[0]!;

    const result = await findRefs.execute({ file: "src/index.ts", line: 5, character: 3 }, new AbortController().signal);
    expect(result).toContain("/project/src/foo.ts:3:0");
    expect(result).toContain("/project/src/bar.ts:10:2");
  });

  it("LspFindRefs rejects invalid inputs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const findRefs = tools[0]!;

    // Negative line causes the fake manager to throw
    await expect(findRefs.execute({ file: "src/index.ts", line: -1, character: 0 }, new AbortController().signal)).rejects.toThrow("invalid position");
    // Non-negative values pass through
    const result = await findRefs.execute({ file: "src/index.ts", line: 0, character: 0 }, new AbortController().signal);
    expect(typeof result).toBe("string");
  });

  it("LspHover returns type information for a symbol", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const hover = tools[1]!;

    const result = await hover.execute({ file: "src/index.ts", line: 5, character: 3 }, new AbortController().signal);
    expect(result).toContain("```typescript");
    expect(result).toContain("const x: number");
    expect(result).toContain("```");
  });

  it("LspHover returns no-info message when symbol has no type info", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const hover = tools[1]!;

    const result = await hover.execute({ file: "src/index.ts", line: 999, character: 3 }, new AbortController().signal);
    expect(result).toBe("No hover information at src/index.ts:999:3");
  });

  it("LspDiagnostics returns formatted diagnostic messages", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const diag = tools[2]!;

    const result = await diag.execute({ file: "src/index.ts" }, new AbortController().signal);
    expect(result).toContain("[ERROR]");
    expect(result).toContain("Type 'string' is not assignable to type 'number'");
    expect(result).toContain("[WARNING]");
    expect(result).toContain("Unused variable 'foo'");
    expect(result).toContain("(ts)");
    expect(result).toContain("(eslint)");
  });

  it("LspDiagnostics reports no issues for clean files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-")); roots.push(workspace);
    const manager: LspManager = { ...fakeManager(), diagnostics: async () => [] };
    const tools = createLspTools(workspace, { manager });
    const diag = tools[2]!;

    const result = await diag.execute({ file: "src/index.ts" }, new AbortController().signal);
    expect(result).toBe("No diagnostics for src/index.ts");
  });

  it("tools expose correct metadata", () => {
    const workspace = join(tmpdir(), "flavor-lsp-meta");
    const tools = createLspTools(workspace, { manager: fakeManager() });
    expect(tools).toHaveLength(3);

    const names = tools.map((t) => t.name);
    expect(names).toEqual(["LspFindRefs", "LspHover", "LspDiagnostics"]);

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(10);
      expect(typeof tool.paths).toBe("function");
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("paths function resolves files within workspace", () => {
    const workspace = join(tmpdir(), "flavor-lsp-paths");
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const findRefs = tools[0]!;

    const paths = findRefs.paths({ file: "src/index.ts", line: 5, character: 3 });
    expect(paths[0]).toBe(join(workspace, "src/index.ts"));
  });

  it("paths function rejects files outside workspace", () => {
    const workspace = join(tmpdir(), "flavor-lsp-outside");
    const tools = createLspTools(workspace, { manager: fakeManager() });
    const findRefs = tools[0]!;

    expect(() => findRefs.paths({ file: "../outside.ts", line: 0, character: 0 })).toThrow();
  });
});

describe("RealLspManager", () => {
  it("queries the bundled TypeScript server against a real workspace", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-lsp-real-")); roots.push(workspace);
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true }, include: ["*.ts"] }));
    const file = join(workspace, "index.ts");
    await writeFile(file, 'const answer: number = "wrong";\n');
    const manager = new RealLspManager({ workspace });
    try {
      const signal = AbortSignal.timeout(10_000);
      const info = await manager.hover(pathToFileURL(file).href, 0, 8, signal);
      expect(JSON.stringify(info)).toContain("number");
      const diagnostics = await manager.diagnostics(pathToFileURL(file).href, signal);
      expect(diagnostics.some((item) => item.message.includes("not assignable"))).toBe(true);
    } finally { await manager.dispose(); }
  });
  it("reports unavailable language servers instead of a false clean result", async () => {
    const manager = new RealLspManager({ workspace: tmpdir(), serverConfigs: [] });
    await expect(manager.diagnostics(pathToFileURL(join(tmpdir(), "x.ts")).href)).rejects.toThrow(/No language server configured/);
    manager.dispose();
    await expect(manager.diagnostics(pathToFileURL(join(tmpdir(), "x.ts")).href)).rejects.toThrow(/disposed/);
  });
  it("creates an empty manager with auto-detect", () => {
    const manager = new RealLspManager({ workspace: "/tmp" });
    expect(manager).toBeDefined();
    manager.dispose();
  });
});
