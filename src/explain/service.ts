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

import type { QuestionBridge } from "../tools/ask-user-question.js";

/** Label shared by the picker options and the answer matching below. The
 *  graph node id is unique, so it doubles as an unambiguous picker label. */
export function explainCandidateLabel(candidate: ExplainNode): string {
  return candidate.id;
}

export type ExplainSelection
  = { kind: "picked"; node: ExplainNode }
  | { kind: "typed"; query: string }
  | { kind: "cancelled" };

/** Interactive disambiguation: top-3 candidates (label = `name (filePath)`,
 *  description = kind + file:line) plus Cancel. The terminal question cards
 *  always append a free-text choice, so the user can type a more exact symbol
 *  instead; that raw text comes back as `typed` for the caller to re-resolve. */
export async function selectExplainCandidate(
  candidates: readonly ExplainNode[],
  questions: QuestionBridge,
  signal: AbortSignal,
): Promise<ExplainSelection> {
  const shown = candidates.slice(0, 3);
  const answers = await questions.ask([{
    header: "Symbol",
    question: "Multiple symbols match. Which one should /explain cover? (Pick one, or type a more exact name.)",
    options: [
      ...shown.map((candidate) => ({
        label: explainCandidateLabel(candidate),
        description: `${candidate.kind} · ${candidate.filePath}:${candidate.startLine}-${candidate.endLine}`,
      })),
      { label: "Cancel", description: "Abort /explain without choosing." },
    ],
  }], signal);
  const answer = (answers[0] ?? "").trim();
  if (answer === "Cancel" || answer === "") return { kind: "cancelled" };
  const picked = shown.find((candidate) => explainCandidateLabel(candidate) === answer);
  if (picked !== undefined) return { kind: "picked", node: picked };
  return { kind: "typed", query: answer };
}
