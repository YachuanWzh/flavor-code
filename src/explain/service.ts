// /explain — newcomer-oriented symbol explanation backed by the AST graph,
// real source slices and git file history. All side-effectful collaborators
// (graph, file reader, history, model registry, question bridge) are injected
// so this module is fully unit-testable; src/production.ts wires the real ones.

export interface ExplainNode {
  id: string; kind: string; name: string; qualifiedName: string; filePath: string;
  language: string; startLine: number; endLine: number; signature?: string;
}

export interface ExplainGraph {
  status(): Promise<{ available: boolean }>;
  search(query: string, limit?: number): Promise<readonly ExplainNode[]>;
  relations(id: string, hops?: number): Promise<{
    origin?: ExplainNode;
    callers: readonly ExplainNode[];
    callees: readonly ExplainNode[];
  }>;
}

export type ExplainTarget
  = { kind: "resolved"; node: ExplainNode }
  | { kind: "ambiguous"; candidates: readonly ExplainNode[] }
  | { kind: "not-found"; query: string };

/** A query that looks like a node id ('path/…#name') is tried as an exact
 *  graph lookup first; anything else goes through ranked name search. */
export async function resolveExplainTarget(graph: ExplainGraph, query: string): Promise<ExplainTarget> {
  const trimmed = query.trim();
  if (trimmed.includes("#")) {
    const { origin } = await graph.relations(trimmed);
    if (origin !== undefined) return { kind: "resolved", node: origin };
  }
  const hits = await graph.search(trimmed, 10);
  if (hits.length === 0) return { kind: "not-found", query: trimmed };
  if (hits.length === 1) return { kind: "resolved", node: hits[0]! };
  return { kind: "ambiguous", candidates: hits };
}
