import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { D2cInteractionManifest, D2cInteractionRun } from "../d2c/interaction.js";
import type { ApprovedPrd, PrdAcceptanceCriterion } from "./prd-governance.js";

export interface AcceptanceArtifact {
  path: string;
  hash: string;
  bytes: number;
}

export interface AcceptanceBaseline {
  schema: 1;
  capturedAt: string;
  approvedPrd: ApprovedPrd;
  artifacts: {
    prd: AcceptanceArtifact;
    prototype: AcceptanceArtifact;
    interaction: AcceptanceArtifact;
    openapi?: AcceptanceArtifact;
  };
}

export interface AcceptanceBaselinePaths {
  prd: string;
  prototype: string;
  interaction: string;
  openapi?: string;
}

async function fileArtifact(path: string): Promise<AcceptanceArtifact> {
  const content = await readFile(path);
  return { path, hash: createHash("sha256").update(content).digest("hex"), bytes: content.byteLength };
}

export async function verifyAcceptanceArtifact(
  path: string,
  expected: Pick<AcceptanceArtifact, "hash">,
  label: string,
): Promise<void> {
  const current = await fileArtifact(path);
  if (current.hash !== expected.hash) {
    throw new Error(`ARTIFACT_DRIFT: ${label} no longer matches the approved acceptance baseline`);
  }
}

export async function captureAcceptanceBaseline(
  paths: AcceptanceBaselinePaths,
  approvedPrd: ApprovedPrd,
  now = new Date(),
): Promise<AcceptanceBaseline> {
  const [prd, prototype, interaction, openapi] = await Promise.all([
    fileArtifact(paths.prd), fileArtifact(paths.prototype), fileArtifact(paths.interaction),
    paths.openapi === undefined ? undefined : fileArtifact(paths.openapi),
  ]);
  if (prd.hash !== approvedPrd.hash) throw new Error("PRD_LOCK_VIOLATION: cannot capture a baseline from modified PRD content");
  return { schema: 1, capturedAt: now.toISOString(), approvedPrd,
    artifacts: { prd, prototype, interaction, ...(openapi === undefined ? {} : { openapi }) } };
}

export async function verifyAcceptanceBaseline(
  paths: AcceptanceBaselinePaths,
  baseline: AcceptanceBaseline,
): Promise<AcceptanceBaseline> {
  const current = await captureAcceptanceBaseline(paths, baseline.approvedPrd, new Date(baseline.capturedAt));
  for (const name of ["prd", "prototype", "interaction", "openapi"] as const) {
    const expected = baseline.artifacts[name];
    const actual = current.artifacts[name];
    if (expected?.hash !== actual?.hash) throw new Error(`ARTIFACT_DRIFT: ${name} no longer matches the approved acceptance baseline`);
  }
  return baseline;
}

export function verifyRequirementCoverage(
  criteria: readonly PrdAcceptanceCriterion[],
  manifest: D2cInteractionManifest,
): Record<string, string[]> {
  const known = new Set(criteria.map((item) => item.id));
  const coverage = Object.fromEntries(criteria.map((item) => [item.id, [] as string[]]));
  for (const page of manifest.pages) {
    for (const scenario of page.scenarios) {
      if (scenario.requirementIds === undefined || scenario.requirementIds.length === 0) {
        throw new Error(`Interaction scenario ${scenario.id} has no PRD requirementIds`);
      }
      for (const id of new Set(scenario.requirementIds)) {
        if (!known.has(id)) throw new Error(`Interaction scenario ${scenario.id} references unknown PRD criterion ${id}`);
        coverage[id]!.push(scenario.id);
      }
    }
  }
  const missing = Object.entries(coverage).filter(([, scenarios]) => scenarios.length === 0).map(([id]) => id);
  if (missing.length > 0) throw new Error(`Interaction contract does not cover approved PRD criteria: ${missing.join(", ")}`);
  return coverage;
}

export interface AcceptanceEvidence {
  schema: 1;
  createdAt: string;
  passed: boolean;
  requirements: Record<string, { scenarioIds: string[]; passed: boolean }>;
}

export function createAcceptanceEvidence(
  coverage: Record<string, string[]>,
  run: D2cInteractionRun,
  now = new Date(),
): AcceptanceEvidence {
  const results = new Map(run.scenarios.map((scenario) => [scenario.id, scenario.passed]));
  const requirements = Object.fromEntries(Object.entries(coverage).map(([id, scenarioIds]) => [id, {
    scenarioIds: [...scenarioIds], passed: scenarioIds.length > 0 && scenarioIds.every((scenario) => results.get(scenario) === true),
  }]));
  return { schema: 1, createdAt: now.toISOString(),
    passed: run.passed && Object.values(requirements).every((item) => item.passed), requirements };
}
