import { describe, expect, it } from "vitest";

import { resolveImportPath, resolveModulePath } from "../../../src/init/astgraph/resolve.mjs";

describe("astgraph module resolution", () => {
  it("resolves relative specifiers with extension substitution", () => {
    expect(resolveImportPath("src/a.ts", "./util.js", (p) => p === "src/util.ts")).toBe("src/util.ts");
    expect(resolveImportPath("src/a.ts", "./util.ts", (p) => p === "src/util.ts")).toBe("src/util.ts");
    expect(resolveImportPath("src/a.ts", "./util", (p) => p === "src/util.ts")).toBe("src/util.ts");
  });

  it("resolves extensionless imports against multiple extensions", () => {
    expect(resolveImportPath("src/a.ts", "./util", (p) => p === "src/util.tsx")).toBe("src/util.tsx");
    expect(resolveImportPath("src/a.ts", "./util", (p) => p === "src/util.js")).toBe("src/util.js");
  });

  it("resolves directory imports through index files", () => {
    expect(resolveImportPath("src/a.ts", "./helpers", (p) => p === "src/helpers/index.ts")).toBe("src/helpers/index.ts");
  });

  it("normalizes nested relative paths", () => {
    expect(resolveImportPath("src/sub/a.ts", "../util.js", (p) => p === "src/util.ts")).toBe("src/util.ts");
  });

  it("returns undefined for bare package imports", () => {
    expect(resolveImportPath("src/a.ts", "node:fs", () => true)).toBeUndefined();
    expect(resolveImportPath("src/a.ts", "react", () => true)).toBeUndefined();
  });

  it("returns undefined when no candidate exists", () => {
    expect(resolveImportPath("src/a.ts", "./missing", () => false)).toBeUndefined();
  });
});

describe("astgraph reference resolution", () => {
  it("matches pending references against exported nodes of the target file", async () => {
    const { resolveRefs } = await import("../../../src/init/astgraph/resolve.mjs");
    const refs = [
      { id: 1, fromNodeId: "a.ts#greet", referenceName: "helper", referenceKind: "import", line: 1, col: 1, filePath: "a.ts", moduleSpecifier: "./util.ts" },
      { id: 2, fromNodeId: "a.ts#greet", referenceName: "helper", referenceKind: "call", line: 3, col: 2, filePath: "a.ts", moduleSpecifier: "./util.ts" },
      { id: 3, fromNodeId: "a.ts#greet", referenceName: "nope", referenceKind: "call", line: 4, col: 2, filePath: "a.ts", moduleSpecifier: "./util.ts" },
    ];
    const nodesByFile = new Map([
      ["util.ts", [{ id: "util.ts#helper", name: "helper", isExported: true }]],
    ]);
    const result = resolveRefs(refs, nodesByFile, (p) => p === "util.ts");
    expect(result.edges).toContainEqual(expect.objectContaining({ source: "a.ts#greet", target: "util.ts#helper", kind: "imports" }));
    expect(result.edges).toContainEqual(expect.objectContaining({ source: "a.ts#greet", target: "util.ts#helper", kind: "calls" }));
    expect(result.resolvedIds).toEqual([1, 2]);
  });

  it("leaves refs without a module specifier for name-based matching", async () => {
    const { resolveRefs } = await import("../../../src/init/astgraph/resolve.mjs");
    const refs = [
      { id: 1, fromNodeId: "a.ts#greet", referenceName: "missingThing", referenceKind: "call", line: 5, col: 2, filePath: "a.ts", moduleSpecifier: undefined },
    ];
    const result = resolveRefs(refs, new Map(), () => false);
    expect(result.edges).toEqual([]);
    expect(result.resolvedIds).toEqual([]);
  });
});
