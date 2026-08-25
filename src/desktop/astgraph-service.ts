import { stat } from "node:fs/promises";
import { createRequire as nodeCreateRequire } from "node:module";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export interface DesktopAstNode {
  id: string; kind: string; name: string; qualifiedName: string; filePath: string;
  language: string; startLine: number; endLine: number; signature?: string;
}
export interface DesktopAstStatus { available: boolean; path: string; files: number; nodes: number; edges: number; indexedAt?: string }
export interface DesktopAstRelations { origin?: DesktopAstNode; callers: readonly DesktopAstNode[]; callees: readonly DesktopAstNode[]; impact: readonly (DesktopAstNode & { hop: number })[] }

const FIELDS = "id, kind, name, qualified_name, file_path, language, start_line, end_line, signature";

export class DesktopAstGraphService {
  readonly #path: string;
  constructor(workspace: string) { this.#path = join(resolve(workspace), ".flavor", "astgraph", "index.db"); }

  async status(): Promise<DesktopAstStatus> {
    if ((await stat(this.#path).catch(() => undefined))?.isFile() !== true) {
      return { available: false, path: this.#path, files: 0, nodes: 0, edges: 0 };
    }
    return this.#read((db) => {
      const count = (table: string) => Number((db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
      const metadata = db.prepare("SELECT value FROM project_metadata WHERE key = 'last_index'").get() as { value?: string } | undefined;
      let indexedAt: string | undefined;
      try { const at = Number(JSON.parse(metadata?.value ?? "{}").at); if (Number.isFinite(at)) indexedAt = new Date(at).toISOString(); } catch { /* optional metadata */ }
      return { available: true, path: this.#path, files: count("files"), nodes: count("nodes"), edges: count("edges"), ...(indexedAt === undefined ? {} : { indexedAt }) };
    });
  }

  async search(query: string, limit = 40): Promise<DesktopAstNode[]> {
    const value = query.trim().slice(0, 200);
    if (value.length === 0 || !(await this.status()).available) return [];
    return this.#read((db) => (db.prepare(`SELECT ${FIELDS} FROM nodes WHERE lower(name) LIKE ? OR lower(qualified_name) LIKE ? ORDER BY CASE WHEN lower(name) = ? THEN 0 ELSE 1 END, name LIMIT ?`)
      .all(`%${value.toLowerCase()}%`, `%${value.toLowerCase()}%`, value.toLowerCase(), Math.min(Math.max(limit, 1), 100)) as unknown[]).map(mapNode));
  }

  async relations(id: string, hops = 2): Promise<DesktopAstRelations> {
    if (!/^[A-Za-z0-9._:/#@+~-]{1,512}$/.test(id)) throw new Error("Invalid AST node id");
    if (!(await this.status()).available) return { callers: [], callees: [], impact: [] };
    return this.#read((db) => {
      const originRow = db.prepare(`SELECT ${FIELDS} FROM nodes WHERE id = ?`).get(id) as unknown;
      const linked = (direction: "callers" | "callees") => {
        const source = direction === "callers" ? "e.source" : "e.target";
        const predicate = direction === "callers" ? "e.target = ?" : "e.source = ?";
        return (db.prepare(`SELECT DISTINCT n.${FIELDS.split(", ").join(", n.")} FROM edges e JOIN nodes n ON n.id = ${source} WHERE ${predicate} AND e.kind IN ('calls','imports') LIMIT 100`).all(id) as unknown[]).map(mapNode);
      };
      const seen = new Map<string, number>(); let frontier = [id];
      for (let hop = 1; hop <= Math.min(Math.max(hops, 1), 4) && frontier.length > 0 && seen.size < 200; hop += 1) {
        const next: string[] = [];
        for (const current of frontier) {
          const rows = db.prepare("SELECT source AS other FROM edges WHERE target = ? UNION SELECT target AS other FROM edges WHERE source = ? LIMIT 200").all(current, current) as { other: string }[];
          for (const row of rows) if (row.other !== id && !seen.has(row.other)) { seen.set(row.other, hop); next.push(row.other); }
        }
        frontier = next;
      }
      const impact = [...seen].flatMap(([nodeId, hop]) => {
        const row = db.prepare(`SELECT ${FIELDS} FROM nodes WHERE id = ?`).get(nodeId);
        return row === undefined ? [] : [{ ...mapNode(row), hop }];
      });
      return { ...(originRow === undefined ? {} : { origin: mapNode(originRow) }), callers: linked("callers"), callees: linked("callees"), impact };
    });
  }

  #read<T>(run: (db: DatabaseSync) => T): T {
    const sqlite = nodeCreateRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    const db = new sqlite.DatabaseSync(this.#path, { readOnly: true });
    try { return run(db); } finally { db.close(); }
  }
}

function mapNode(value: unknown): DesktopAstNode {
  const row = value as Record<string, unknown>;
  return { id: String(row.id), kind: String(row.kind), name: String(row.name), qualifiedName: String(row.qualified_name), filePath: String(row.file_path), language: String(row.language), startLine: Number(row.start_line), endLine: Number(row.end_line), ...(row.signature == null ? {} : { signature: String(row.signature) }) };
}
