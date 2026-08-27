// /explain — newcomer-oriented symbol explanation backed by the AST graph,
// real source slices and git file history. All side-effectful collaborators
// (graph, file reader, history, model registry, question bridge) are injected
// so this module is fully unit-testable; src/production.ts wires the real ones.

import type { ModelRegistry } from "../models/registry.js";
import type { QuestionBridge } from "../tools/ask-user-question.js";

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

export interface ExplainPromptInput {
  anchor: ExplainNode;
  anchorSource: string;
  callers: readonly { name: string; filePath: string; startLine: number }[];
  callees: readonly { name: string; filePath: string; startLine: number }[];
  history: readonly { date: string; author: string; subject: string }[];
  focus?: string;
  language: string;
}

const MAX_SOURCE_CHARS = 20_000;

/** Assemble the evidence bundle (source slice + relations + commit subjects)
 *  into a single prompt. The model must only see real code and real history,
 *  so the "why" section stays grounded and can say 不确定 instead of guessing. */
export function buildExplainPrompt(input: ExplainPromptInput): string {
  const source = input.anchorSource.length > MAX_SOURCE_CHARS
    ? `${input.anchorSource.slice(0, MAX_SOURCE_CHARS)}\n… (truncated)`
    : input.anchorSource;
  const line = (n: { name: string; filePath: string; startLine: number }) => `- ${n.name} — ${n.filePath}:${n.startLine}`;
  return [
    "You are a senior engineer onboarding a new team member. Explain the following code symbol clearly and concretely; never invent behavior that is not in the shown evidence.",
    `Answer in ${input.language}.`,
    "Structure the answer with short markdown sections:",
    "1. 它是做什么的 — one paragraph, plain language, beginner first.",
    "2. 关键实现点 — 2-5 bullets tied to concrete lines/branches in the source.",
    "3. 谁调用它 / 它调用谁 — use the relation lists; explain the data flow in one or two sentences.",
    "4. 为什么这样写 — infer from the recent commit subjects when possible; say '不确定' instead of guessing.",
    "5. 新人注意事项 — pitfalls, guards or invariants worth knowing.",
    ...(input.focus === undefined || input.focus.trim() === "" ? [] : [`The user specifically asks about: ${input.focus.trim()}`]),
    "",
    `Symbol: ${input.anchor.id} (${input.anchor.kind}${input.anchor.signature ? `, signature: ${input.anchor.signature}` : ""})`,
    "",
    `Source (${input.anchor.filePath}:${input.anchor.startLine}-${input.anchor.endLine}):`,
    source,
    "",
    `Callers:\n${input.callers.map(line).join("\n") || "- (none)"}`,
    `Callees:\n${input.callees.map(line).join("\n") || "- (none)"}`,
    "",
    `Recent commits touching the file:\n${input.history.map((h) => `- ${h.date} ${h.author}: ${h.subject}`).join("\n") || "- (no history)"}`,
  ].join("\n");
}

export interface ExplainModelOptions {
  registry: ModelRegistry;
  /** Cheap model id provider; evaluated lazily so /model switches apply. */
  modelId(): string;
}

/** One streaming completion from the cheap (subagent) model, mirroring
 *  src/git/insights.ts. Throws on stream errors or empty output; runExplain
 *  turns the throw into user-facing text. */
export async function explainWithModel(
  options: ExplainModelOptions,
  prompt: string,
  signal: AbortSignal,
): Promise<string> {
  const { adapter, model } = options.registry.get(options.modelId());
  let text = "";
  for await (const event of adapter.stream({
    model,
    messages: [{ role: "user", content: prompt }],
    tools: [],
    signal,
  })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") throw new Error(`explain generation failed: ${event.error.message}`);
    else if (event.type === "done") break;
  }
  const cleaned = text.trim();
  if (cleaned === "") throw new Error("explain generation returned no text");
  return cleaned;
}

export interface ExplainDeps {
  graph: ExplainGraph;
  /** Read a workspace-relative file (production enforces workspace containment). */
  readFile(path: string): Promise<string>;
  history?(path: string, limit: number): Promise<readonly { date: string; author: string; subject: string }[]>;
  questions?: QuestionBridge;
  registry: ModelRegistry;
  modelId(): string;
  language: string;
  notify?(message: string): void;
}

const HISTORY_LIMIT = 8;
const MAX_RESOLVE_ROUNDS = 2;

/** Orchestrate one /explain turn: resolve the symbol (asking the user to pick
 *  on ambiguity), gather grounded evidence and stream a cheap-model answer.
 *  Every failure path returns user-facing text instead of throwing, matching
 *  the /review semantics in src/ui/session.ts. */
export async function runExplain(
  deps: ExplainDeps,
  query: string | undefined,
  focus: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  if (query === undefined) {
    return "Usage: /explain <symbol | file.ts#symbol> [what to focus on]. Example: /explain src/order.ts#cancelOrder error handling";
  }
  if (!(await deps.graph.status()).available) {
    return "The code graph is not built yet — run /ast init, then try /explain again.";
  }
  let target = await resolveExplainTarget(deps.graph, query);
  for (let round = 1; round <= MAX_RESOLVE_ROUNDS; round += 1) {
    if (target.kind !== "ambiguous") break;
    if (deps.questions === undefined) {
      return `"${query}" is ambiguous. Use the exact node id, e.g. /explain ${target.candidates[0]?.id ?? "path/file.ts#name"}.`;
    }
    const selection = await selectExplainCandidate(target.candidates, deps.questions, signal);
    if (selection.kind === "cancelled") return "/explain cancelled — no symbol was selected.";
    if (selection.kind === "picked") {
      target = { kind: "resolved", node: selection.node };
      break;
    }
    target = await resolveExplainTarget(deps.graph, selection.query);
    if (round === MAX_RESOLVE_ROUNDS && target.kind === "ambiguous") {
      return `"${selection.query}" is still ambiguous. Pick one node id explicitly: /explain ${target.candidates[0]?.id ?? "path/file.ts#name"}`;
    }
  }
  if (target.kind === "not-found") {
    return `No matching symbol for "${target.query}" — check the name, or refresh the graph with /ast sync.`;
  }
  if (target.kind !== "resolved") {
    return `"${query}" is ambiguous. Pick one node id explicitly: /explain ${target.candidates[0]?.id ?? "path/file.ts#name"}`;
  }
  const anchor = target.node;
  signal.throwIfAborted();
  deps.notify?.(`Explaining ${anchor.id} …`);
  const { callers, callees } = await deps.graph.relations(anchor.id, 1);
  const raw = await deps.readFile(anchor.filePath).catch(() => "");
  const lines = raw.split("\n");
  const anchorSource = lines.slice(Math.max(0, anchor.startLine - 1), anchor.endLine).join("\n") || raw;
  const history = deps.history === undefined
    ? []
    : await deps.history(anchor.filePath, HISTORY_LIMIT).catch(() => []);
  try {
    const explanation = await explainWithModel(
      { registry: deps.registry, modelId: deps.modelId },
      buildExplainPrompt({
        anchor, anchorSource,
        callers: callers.map((n) => ({ name: n.name, filePath: n.filePath, startLine: n.startLine })),
        callees: callees.map((n) => ({ name: n.name, filePath: n.filePath, startLine: n.startLine })),
        history,
        ...(focus === undefined ? {} : { focus }),
        language: deps.language,
      }),
      signal,
    );
    return `Explain ${anchor.id}\n\n${explanation}`;
  } catch (error) {
    if (signal.aborted) throw error;
    return `/explain failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
