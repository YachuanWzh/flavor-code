import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";

import type { ModelRegistry } from "../models/registry.js";
import type { ModelMessage } from "../models/types.js";
import {
  VerdictSchema,
  type AggregatedOutcome,
  type EvidencePacket,
  type Gap,
  type Plan,
  type Verdict,
} from "./types.js";

export interface ClassifierOptions {
  registry: ModelRegistry;
  modelId: string;
  skepticCount: number;
  workspace: string;
  signal?: AbortSignal;
}

function buildSkepticPrompt(evidence: EvidencePacket, plan: Plan, index: number): string {
  const criteriaList = plan.criteria
    .map((c) => `  ${c.id}. [${c.type}] ${c.description}`)
    .join("\n");

  return [
    "You are an **adversarial verifier** (skeptic #SkepticIndex). You did NOT produce the work below.",
    "Your job is to **audit** it and determine whether the objective has been met.",
    "",
    "**Default to refuted: true if uncertain.** A false-positive is worse than one more iteration.",
    "",
    "## Objective (immutable contract)",
    evidence.objective,
    "",
    "## Acceptance Criteria (derived checklist)",
    criteriaList,
    "",
    "## Verification Plan",
    plan.verificationPlan,
    "",
    "## Evidence",
    `Changed files: ${evidence.changedFiles.length > 0 ? evidence.changedFiles.join(", ") : "(none)"}`,
    `Plan file: ${evidence.planFile ?? "(unavailable)"}`,
    `Prior gaps: ${evidence.priorGaps || "(none)"}`,
    "",
    "## Implementer's Closing Statement",
    evidence.finalResponse || "(no closing statement)",
    "",
    "## Rules",
    "1. The OBJECTIVE is the immutable contract. Criteria are a derived checklist — if a criterion is too narrow but the objective is met, do NOT refute.",
    "2. If the implementer claims work that is not reflected in CHANGED_FILES, that is fabrication — refute.",
    "3. TODO/FIXME/unimplemented/skipped tests in the codebase — refute.",
    "4. Missing tests alone are NOT grounds for refutation unless a criterion explicitly requires them.",
    "5. NEVER invent requirements beyond the contract (objective + criteria + non-goals).",
    "6. In repeat verification rounds, focus on whether PRIOR_GAPS have been fixed. New issues are only valid if they are clearly demonstrable defects.",
    "7. Audit the CURRENT workspace state — do not re-execute code unless it is a cheap spot-check.",
    "",
    "## Output",
    "Write your verdict as a single JSON object (no markdown, no preamble):",
    "{",
    '  "refuted": true,',
    '  "gaps": [',
    '    { "criterion": "criterion id or description", "description": "specific gap found", "blocking": "model_fixable" }',
    "  ]",
    "}",
    "",
    'blocking values: "model_fixable" (implementer can fix), "contradiction" (objective conflicts with reality), "unverifiable" (cannot verify due to environment limits)',
    "",
    "If every criterion is satisfied: { \"refuted\": false, \"gaps\": [] }",
  ].join("\n").replace("SkepticIndex", String(index));
}

export async function runClassifier(
  evidence: EvidencePacket,
  plan: Plan,
  options: ClassifierOptions,
): Promise<AggregatedOutcome> {
  const n = Math.max(1, Math.min(options.skepticCount, 5));
  const { adapter, model } = options.registry.get(options.modelId);

  // Run N skeptics in parallel
  const skepticResults = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      runOneSkeptic(evidence, plan, i + 1, adapter, model, options.signal),
    ),
  );

  // Parse verdicts
  const verdicts: Verdict[] = [];
  for (const result of skepticResults) {
    try {
      verdicts.push(parseVerdict(result));
    } catch {
      // Fail-open: a broken skeptic counts as "not refuted" (don't block the user)
      verdicts.push({ refuted: false, gaps: [] });
    }
  }

  // Aggregate with majority voting
  return aggregate(verdicts);
}

async function runOneSkeptic(
  evidence: EvidencePacket,
  plan: Plan,
  index: number,
  adapter: { stream: (req: any) => AsyncIterable<any> },
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const prompt = buildSkepticPrompt(evidence, plan, index);
  const messages: ModelMessage[] = [{ role: "user", content: prompt }];

  let text = "";
  for await (const event of adapter.stream({
    model,
    messages,
    tools: [],
    ...(signal === undefined ? {} : { signal }),
  })) {
    if (event.type === "text") text += event.text;
    else if (event.type === "error") throw event.error;
    else if (event.type === "done") break;
  }
  return text;
}

function parseVerdict(text: string): Verdict {
  const trimmed = text.trim();
  let json = trimmed;

  // Try to extract JSON from markdown code blocks first
  const jsonBlock = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (jsonBlock?.[1]) json = jsonBlock[1].trim();

  // Otherwise find the first { }
  const openBrace = json.indexOf("{");
  if (openBrace >= 0) {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = openBrace; i < json.length; i++) {
      const ch = json[i]!;
      if (escape) { escape = false; continue; }
      if (ch === "\\" && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          json = json.slice(openBrace, i + 1);
          break;
        }
      }
    }
  }

  const raw: unknown = JSON.parse(json);
  return VerdictSchema.parse(raw);
}

function aggregate(verdicts: Verdict[]): AggregatedOutcome {
  const n = verdicts.length;
  const refuters = verdicts.filter((v) => v.refuted);
  const refuteCount = refuters.length;
  const threshold = Math.ceil(n / 2);

  if (refuteCount < threshold) {
    const summaries = verdicts.map((v, i) =>
      v.refuted
        ? `Skeptic #${i + 1}: refuted (${v.gaps.length} gap(s))`
        : `Skeptic #${i + 1}: not refuted`,
    );
    return {
      type: "achieved",
      summary: `${n - refuteCount}/${n} skeptics confirmed. ${refuteCount}/${n} refuted. ` + summaries.join("; "),
    };
  }

  // Check if all refuters are blocking on non-model-fixable issues
  const allBlocking = refuters.every((v) =>
    v.gaps.every((g) => g.blocking === "contradiction" || g.blocking === "unverifiable"),
  );

  if (allBlocking && refuters.length === verdicts.length) {
    const reasons = refuters.flatMap((v) => v.gaps.map((g) => g.description));
    return {
      type: "blocked",
      reason: `All ${n} skeptics found non-fixable issues: ${reasons.join("; ")}`,
    };
  }

  // Not achieved — collect all gaps, deduplicate
  const allGaps = deduplicateGaps(refuters.flatMap((v) => v.gaps));
  const summary = `${refuteCount}/${n} skeptics refuted. Gaps: ${allGaps.map((g) => g.description).join(" | ")}`;
  const fingerprint = computeFingerprint(allGaps);

  return { type: "not_achieved", gaps: allGaps, summary, fingerprint };
}

function deduplicateGaps(gaps: Gap[]): Gap[] {
  const seen = new Set<string>();
  const result: Gap[] = [];
  for (const gap of gaps) {
    const key = `${gap.criterion}\x00${gap.description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(gap);
  }
  return result;
}

export function computeFingerprint(gaps: Gap[]): string {
  const content = gaps
    .map((g) => `${g.criterion}:${g.description}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ──── Evidence Collection ────

export async function collectEvidence(
  workspace: string,
  objective: string,
  finalResponse: string,
  priorGaps: string,
): Promise<EvidencePacket> {
  const changedFiles = await collectChangedFiles(workspace);
  const planPath = join(workspace, ".flavor", "goal-plan.md");
  let planFile: string | null = null;
  try {
    planFile = await readFile(planPath, "utf8");
  } catch {
    // Plan file not found — classifier will work without it
  }

  return {
    objective,
    changedFiles: changedFiles.map((f) => relative(workspace, f)),
    planFile,
    finalResponse,
    priorGaps,
  };
}

async function collectChangedFiles(workspace: string): Promise<string[]> {
  // Collect files modified in the workspace (non-.git, non-node_modules)
  const results: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(workspace, full);
      if (
        entry.name === ".git" ||
        entry.name === "node_modules" ||
        entry.name === ".flavor" ||
        entry.name.startsWith(".")
      ) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (!seen.has(rel)) {
          seen.add(rel);
          results.push(full);
        }
      }
    }
  }

  await walk(workspace);
  return results.sort();
}
