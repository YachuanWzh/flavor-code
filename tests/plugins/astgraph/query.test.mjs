import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDb } from "../../../src/init/astgraph/db.mjs";
import { indexProject } from "../../../src/init/astgraph/indexer.mjs";
import { callers, callees, impact, search, subgraphContext } from "../../../src/init/astgraph/query.mjs";

const workspace = mkdtempSync(join(tmpdir(), "astgraph-query-"));
const db = openDb(":memory:");

function write(relPath, content) {
  mkdirSync(join(workspace, relPath, ".."), { recursive: true });
  writeFileSync(join(workspace, relPath), content, "utf8");
}

beforeAll(async () => {
  write("src/dao.ts", "export function saveOrder(id: number): void {}\nexport function deleteOrder(id: number): void {}\n");
  write("src/order-service.ts", `import { saveOrder, deleteOrder } from "./dao.js";
/** Orchestrates order lifecycle. */
export function cancelOrder(id: number): void { deleteOrder(id); }
export function createOrder(id: number): void { saveOrder(id); }
`);
  write("src/controller.ts", `import { cancelOrder } from "./order-service.js";
export function handleCancel(): void { cancelOrder(1); }
`);
  await indexProject(workspace, { db });
});

afterAll(() => {
  db.close();
  rmSync(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe("astgraph query layer", () => {
  it("finds anchor nodes by full-text search", () => {
    const hits = search(db, "cancel");
    expect(hits.some((hit) => hit.id === "src/order-service.ts#cancelOrder")).toBe(true);
  });

  it("finds anchors via identifier segment matching (natural-language words)", () => {
    const hits = search(db, "order cancel");
    expect(hits.some((hit) => hit.id === "src/order-service.ts#cancelOrder")).toBe(true);
  });

  it("finds callers (who calls cancelOrder)", () => {
    const result = callers(db, "src/order-service.ts#cancelOrder");
    expect(result.map((node) => node.id)).toContain("src/controller.ts#handleCancel");
  });

  it("finds callees (what cancelOrder calls)", () => {
    const result = callees(db, "src/order-service.ts#cancelOrder");
    expect(result.map((node) => node.id)).toContain("src/dao.ts#deleteOrder");
  });

  it("computes blast radius upward via K-hop impact", () => {
    const result = impact(db, "src/dao.ts#deleteOrder", { hops: 2 });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).toContain("src/order-service.ts#cancelOrder");
    expect(ids).toContain("src/controller.ts#handleCancel");
  });

  it("computes downward impact (who depends on me transitively)", () => {
    const result = impact(db, "src/controller.ts#handleCancel", { hops: 2, direction: "down" });
    const ids = result.nodes.map((node) => node.id);
    expect(ids).toContain("src/order-service.ts#cancelOrder");
    expect(ids).toContain("src/dao.ts#deleteOrder");
  });

  it("assembles precise file:line context for a subgraph", () => {
    const result = subgraphContext(db, "src/order-service.ts#cancelOrder", { hops: 1 });
    const locations = result.context.map((entry) => `${entry.filePath}:${entry.startLine}-${entry.endLine}`);
    expect(locations).toContain("src/controller.ts:2-2");
    expect(locations).toContain("src/dao.ts:2-2");
    expect(locations.some((location) => location.startsWith("src/order-service.ts:3"))).toBe(true);
  });
});
