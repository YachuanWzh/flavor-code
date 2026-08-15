import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  deleteFileRecord,
  getFileRecord,
  insertEdge,
  insertUnresolvedRef,
  openDb,
  replaceNodes,
  stats,
  upsertFileRecord,
} from "../../../src/init/astgraph/db.mjs";

const tempDir = mkdtempSync(join(tmpdir(), "astgraph-db-"));

afterAll(() => {
  // Best-effort: on Windows a just-closed WAL/shm file may still hold a brief
  // lock, so retry once after a short pause rather than fail the suite.
  const drop = () => rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  try { drop(); } catch { setTimeout(drop, 200); }
});

function node(id, name, extra = {}) {
  return {
    id, kind: "function", name, qualifiedName: name,
    filePath: "src/a.ts", language: "typescript",
    startLine: 1, endLine: 3, isExported: true,
    ...extra,
  };
}

describe("astgraph graph database", () => {
  const dbPath = join(tempDir, "index.db");

  it("opens a database and reports empty stats", () => {
    const db = openDb(dbPath);
    expect(stats(db)).toEqual({ files: 0, nodes: 0, edges: 0, unresolved: 0 });
    db.close();
  });

  it("upserts file records and reads them back", () => {
    const db = openDb(dbPath);
    upsertFileRecord(db, { path: "src/a.ts", contentHash: "h1", language: "typescript", size: 10 });
    const record = getFileRecord(db, "src/a.ts");
    expect(record).toMatchObject({ path: "src/a.ts", contentHash: "h1", language: "typescript", size: 10 });
    // Same path, new hash → replaced, not duplicated.
    upsertFileRecord(db, { path: "src/a.ts", contentHash: "h2", language: "typescript", size: 20 });
    expect(getFileRecord(db, "src/a.ts").contentHash).toBe("h2");
    expect(stats(db).files).toBe(1);
    db.close();
  });

  it("replaces nodes for a file atomically", () => {
    const db = openDb(dbPath);
    replaceNodes(db, "src/a.ts", [node("a#greet", "greet"), node("a#farewell", "farewell")]);
    expect(stats(db).nodes).toBe(2);
    replaceNodes(db, "src/a.ts", [node("a#greet", "greet")]);
    expect(stats(db).nodes).toBe(1);
    const row = db.prepare("SELECT name, is_exported FROM nodes WHERE id = ?").get("a#greet");
    expect(row.name).toBe("greet");
    expect(row.is_exported).toBe(1);
    db.close();
  });

  it("inserts edges with dedup on (source, target, kind, line, col)", () => {
    const db = openDb(dbPath);
    replaceNodes(db, "src/a.ts", [node("a#greet", "greet"), node("a#farewell", "farewell")]);
    insertEdge(db, { source: "a#greet", target: "a#farewell", kind: "calls", line: 2, col: 4 });
    insertEdge(db, { source: "a#greet", target: "a#farewell", kind: "calls", line: 2, col: 4 });
    insertEdge(db, { source: "a#greet", target: "a#farewell", kind: "calls", line: 5, col: 1 });
    expect(stats(db).edges).toBe(2);
    db.close();
  });

  it("deletes a file record and cascades its nodes, edges and refs", () => {
    const db = openDb(dbPath);
    insertUnresolvedRef(db, { fromNodeId: "a#greet", referenceName: "missing", referenceKind: "call", line: 2, col: 1, filePath: "src/a.ts" });
    expect(stats(db).unresolved).toBe(1);
    deleteFileRecord(db, "src/a.ts");
    expect(getFileRecord(db, "src/a.ts")).toBeUndefined();
    expect(stats(db)).toEqual({ files: 0, nodes: 0, edges: 0, unresolved: 0 });
    db.close();
  });

  it("supports full-text search over node names", () => {
    const db = openDb(dbPath);
    replaceNodes(db, "src/a.ts", [node("a#greet", "greet"), node("a#cancelOrder", "cancelOrder")]);
    const rows = db.prepare(
      "SELECT n.id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH ? ORDER BY rank LIMIT 5",
    ).all("cancel*");
    expect(rows.map((row) => row.id)).toContain("a#cancelOrder");
    db.close();
  });
});
