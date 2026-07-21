import type { ModelRegistry } from "../models/registry.js";
import type { ModelMessage } from "../models/types.js";
import { PlanSchema, type Plan } from "./types.js";

export interface PlannerOptions {
  registry: ModelRegistry;
  modelId: string;
  objective: string;
  signal?: AbortSignal;
}

function buildPlannerPrompt(objective: string): string {
  return [
    "You are a goal planner. Given an objective, produce a structured, verifiable plan.",
    "",
    "## Rules",
    "1. Specify OUTCOME, not architecture. Describe observable results — never dictate module layout, class names, or function signatures.",
    "2. Every acceptance criterion must be independently verifiable by an auditor reading the codebase.",
    '3. Categorize each criterion as "gating" (must pass, or goal is refuted) or "evidence" (best-effort; only checked after all gating criteria pass).',
    "4. Keep criteria tight: 3–8 items. More criteria does not mean better verification.",
    "5. The verification plan must spell out exactly what evidence satisfies each criterion.",
    "",
    "## Output format",
    "Return a single JSON object matching this schema (no markdown, no preamble):",
    "{",
    '  "kind": "code-change" | "analysis" | "research",',
    '  "approach": "1–2 sentences of implementation guidance (non-contractual, for the implementer only)",',
    '  "checklist": ["bite-sized task 1", "bite-sized task 2", ...],',
    '  "criteria": [',
    '    { "id": 1, "description": "observable outcome", "type": "gating" },',
    '    { "id": 2, "description": "another observable outcome", "type": "evidence" }',
    "  ],",
    '  "verificationPlan": "step-by-step instructions for the verifier: what to check, where to look, what output to expect",',
    '  "nonGoals": ["explicitly out of scope 1", ...],',
    '  "assumedScope": ["assumption 1", ...]',
    "}",
    "",
    `## Objective\n${objective}`,
  ].join("\n");
}

export async function runPlanner(options: PlannerOptions): Promise<Plan> {
  const { adapter, model } = options.registry.get(options.modelId);
  const prompt = buildPlannerPrompt(options.objective);
  const messages: ModelMessage[] = [{ role: "user", content: prompt }];

  let text = "";
  let completed = false;
  for await (const event of adapter.stream({
    model,
    messages,
    tools: [],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") throw event.error;
    else if (event.type === "done") { completed = true; break; }
  }

  if (!completed) throw new Error("Planner stream ended without completion");

  // Extract the JSON object from the response (may be wrapped in markdown)
  const json = extractJson(text);
  const raw: unknown = JSON.parse(json);
  return PlanSchema.parse(raw);
}

function extractJson(text: string): string {
  // Try to find a JSON object delimited by { }
  const trimmed = text.trim();
  const openBrace = trimmed.indexOf("{");
  if (openBrace < 0) throw new Error("Planner did not return a JSON object");

  // Walk from the first { to find the matching }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openBrace; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return trimmed.slice(openBrace, i + 1);
    }
  }
  throw new Error("Unterminated JSON object in planner response");
}
