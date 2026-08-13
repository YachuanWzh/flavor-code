import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseInteractionManifest } from "../../src/d2c/interaction.js";
import {
  captureAcceptanceBaseline,
  createAcceptanceEvidence,
  verifyAcceptanceArtifact,
  verifyAcceptanceBaseline,
  verifyRequirementCoverage,
} from "../../src/e2e/acceptance-baseline.js";
import { approvePrd } from "../../src/e2e/prd-governance.js";

const prd = "# Demo\n\n## 验收标准\n- [AC-001] 可以查询。\n- [AC-002] 失败后可以重试。\n";
const manifest = () => parseInteractionManifest(JSON.stringify({
  schemaVersion: 1, product: "Demo", deterministic: true,
  pages: [{ url: "index.html", scenarios: [
    { id: "query", requirementIds: ["AC-001"], steps: [{ action: "click", selector: "#query" }, { expect: "visible", selector: "#result" }] },
    { id: "retry", requirementIds: ["AC-002"], steps: [{ action: "click", selector: "#retry" }, { expect: "visible", selector: "#result" }] },
  ] }],
}));

describe("strict E2E acceptance baseline", () => {
  it("requires every approved criterion to be covered and rejects unknown ids", () => {
    const approved = approvePrd(prd);
    expect(verifyRequirementCoverage(approved.criteria, manifest())).toEqual({ "AC-001": ["query"], "AC-002": ["retry"] });
    const missing = structuredClone(manifest()); missing.pages[0]!.scenarios.pop();
    expect(() => verifyRequirementCoverage(approved.criteria, missing)).toThrow(/AC-002/);
    const unknown = structuredClone(manifest()); unknown.pages[0]!.scenarios[0]!.requirementIds = ["AC-999"];
    expect(() => verifyRequirementCoverage(approved.criteria, unknown)).toThrow(/AC-999/);
  });

  it("captures PRD, design, interaction and OpenAPI hashes and rejects later drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-acceptance-baseline-"));
    const paths = { prd: join(root, "prd.md"), prototype: join(root, "index.html"),
      interaction: join(root, "interaction.json"), openapi: join(root, "openapi.json") };
    await writeFile(paths.prd, prd); await writeFile(paths.prototype, "<main>Demo</main>");
    await writeFile(paths.interaction, JSON.stringify(manifest())); await writeFile(paths.openapi, "{}");
    const baseline = await captureAcceptanceBaseline(paths, approvePrd(prd), new Date("2026-08-13T11:00:00.000Z"));
    await expect(verifyAcceptanceBaseline(paths, baseline)).resolves.toEqual(baseline);
    await writeFile(paths.prototype, "<main>Changed</main>");
    await expect(verifyAcceptanceBaseline(paths, baseline)).rejects.toThrow(/ARTIFACT_DRIFT.*prototype/);
  });

  it("rejects drift in the runtime copy actually used by acceptance", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-acceptance-runtime-"));
    const approvedPath = join(root, "approved.html");
    const runtimePath = join(root, "runtime.html");
    await writeFile(join(root, "prd.md"), prd);
    await writeFile(join(root, "interaction.json"), JSON.stringify(manifest()));
    await writeFile(approvedPath, "<main>Approved</main>");
    await writeFile(runtimePath, "<main>Approved</main>");
    const approved = await captureAcceptanceBaseline({
      prd: join(root, "prd.md"), prototype: approvedPath,
      interaction: join(root, "interaction.json"),
    }, approvePrd(prd));
    await expect(verifyAcceptanceArtifact(runtimePath, approved.artifacts.prototype, "runtime prototype"))
      .resolves.toBeUndefined();
    await writeFile(runtimePath, "<main>Tampered</main>");
    await expect(verifyAcceptanceArtifact(runtimePath, approved.artifacts.prototype, "runtime prototype"))
      .rejects.toThrow(/ARTIFACT_DRIFT.*runtime prototype/);
  });

  it("only passes evidence when every mapped scenario passed", () => {
    const coverage = verifyRequirementCoverage(approvePrd(prd).criteria, manifest());
    const evidence = createAcceptanceEvidence(coverage, {
      schema: 1, runAt: "2026-08-13T11:00:00.000Z", baseUrl: "http://127.0.0.1:4000/",
      passed: false, total: 2, failures: 1, apiRequestCount: 1,
      scenarios: [
        { id: "query", pageUrl: "index.html", passed: true, durationMs: 1, apiRequestCount: 1 },
        { id: "retry", pageUrl: "index.html", passed: false, durationMs: 1, apiRequestCount: 0, failure: "missing" },
      ],
    }, new Date("2026-08-13T11:01:00.000Z"));
    expect(evidence.passed).toBe(false);
    expect(evidence.requirements["AC-001"]).toMatchObject({ passed: true });
    expect(evidence.requirements["AC-002"]).toMatchObject({ passed: false });
  });
});
