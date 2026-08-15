import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, stats } from "../../../src/init/astgraph/db.mjs";
import { indexProject } from "../../../src/init/astgraph/indexer.mjs";

let workspace;
let db;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "astgraph-idx-"));
  db = openDb(":memory:");
});

afterEach(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

function write(relPath, content) {
  const full = join(workspace, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content, "utf8");
}

describe("astgraph indexer", () => {
  it("indexes a small project end to end", async () => {
    write("src/util.ts", `export function helper(value: unknown): void { console.log(value); }\n`);
    write("src/main.ts", `import { helper } from "./util.js";\nexport function main(): void { helper(1); }\n`);

    const result = await indexProject(workspace, { db });
    expect(result.files).toBe(2);
    expect(result.indexed).toBe(2);
    expect(result.removed).toBe(0);

    const summary = stats(db);
    expect(summary.files).toBe(2);
    expect(summary.nodes).toBeGreaterThanOrEqual(2);

    // Cross-file import + call edges are resolved.
    const edges = db.prepare("SELECT source, target, kind FROM edges ORDER BY kind").all();
    const kinds = edges.map((edge) => edge.kind);
    expect(kinds).toContain("imports");
    expect(kinds).toContain("calls");
    const importEdge = edges.find((edge) => edge.kind === "imports");
    expect(importEdge.target).toBe("src/util.ts#helper");
    expect(importEdge.source).toBe("src/main.ts#main");
  });

  it("skips excluded directories and non-code files", async () => {
    write("node_modules/dep/index.js", "export function x() {}\n");
    write("dist/bundle.js", "export function y() {}\n");
    write("README.md", "# readme\n");
    write("src/a.ts", "export function a(): void {}\n");

    const result = await indexProject(workspace, { db });
    expect(result.files).toBe(1);
    expect(stats(db).nodes).toBe(1);
  });

  it("incrementally re-indexes only changed files", async () => {
    write("src/a.ts", "export function a(): void {}\n");
    write("src/b.ts", "export function b(): void {}\n");
    const first = await indexProject(workspace, { db });
    expect(first.indexed).toBe(2);

    // Change only a.ts; the second pass must skip b.ts.
    write("src/a.ts", "export function a(): void {}\nexport function a2(): void {}\n");
    const second = await indexProject(workspace, { db });
    expect(second.indexed).toBe(1);
    expect(second.skipped).toBe(1);
    expect(second.files).toBe(2);

    const names = db.prepare("SELECT name FROM nodes ORDER BY name").all().map((row) => row.name);
    expect(names).toEqual(["a", "a2", "b"]);
  });

  it("removes files that disappeared from disk", async () => {
    write("src/a.ts", "export function a(): void {}\n");
    write("src/b.ts", "export function b(): void {}\n");
    await indexProject(workspace, { db });
    expect(stats(db).files).toBe(2);

    rmSync(join(workspace, "src/b.ts"));
    const result = await indexProject(workspace, { db });
    expect(result.removed).toBe(1);
    expect(stats(db).files).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE name = 'b'").get().count).toBe(0);
  });

  it("supports indexing a single file for hook-driven sync", async () => {
    write("src/util.ts", "export function helper(): void {}\n");
    write("src/main.ts", `import { helper } from "./util.js";\nexport function main(): void { helper(); }\n`);
    await indexProject(workspace, { db });

    write("src/util.ts", "export function helper(): void {}\nexport function helper2(): void {}\n");
    const result = await indexProject(workspace, { db, onlyPaths: ["src/util.ts"] });
    expect(result.indexed).toBe(1);

    const names = db.prepare("SELECT name FROM nodes WHERE file_path = ? ORDER BY name").all("src/util.ts").map((row) => row.name);
    expect(names).toEqual(["helper", "helper2"]);
  });
});
