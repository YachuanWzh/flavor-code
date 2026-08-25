import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopAstGraphService } from "../../src/desktop/astgraph-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("DesktopAstGraphService", () => {
  it("reports index state and returns bounded symbol relationships", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-ast-desktop-")); roots.push(root);
    const directory = join(root, ".flavor", "astgraph"); await mkdir(directory, { recursive: true });
    const db = new DatabaseSync(join(directory, "index.db"));
    db.exec(`
      CREATE TABLE files(path TEXT); CREATE TABLE project_metadata(key TEXT, value TEXT);
      CREATE TABLE nodes(id TEXT PRIMARY KEY, kind TEXT, name TEXT, qualified_name TEXT, file_path TEXT, language TEXT, start_line INTEGER, end_line INTEGER, signature TEXT);
      CREATE TABLE edges(source TEXT, target TEXT, kind TEXT);
      INSERT INTO files VALUES ('src/a.ts');
      INSERT INTO project_metadata VALUES ('last_index', '{"at":1787616000000}');
      INSERT INTO nodes VALUES ('caller','function','runOrder','runOrder','src/a.ts','typescript',1,4,'runOrder()');
      INSERT INTO nodes VALUES ('target','function','cancelOrder','cancelOrder','src/a.ts','typescript',6,9,'cancelOrder()');
      INSERT INTO edges VALUES ('caller','target','calls');
    `); db.close();
    const service = new DesktopAstGraphService(root);

    expect(await service.status()).toMatchObject({ available: true, files: 1, nodes: 2, edges: 1 });
    expect(await service.search("cancel")).toEqual([expect.objectContaining({ id: "target", startLine: 6 })]);
    expect(await service.relations("target")).toMatchObject({ callers: [expect.objectContaining({ id: "caller" })] });
  });

  it("does not create an index while checking an unindexed project", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-ast-empty-")); roots.push(root);
    expect(await new DesktopAstGraphService(root).status()).toMatchObject({ available: false, nodes: 0 });
  });
});
