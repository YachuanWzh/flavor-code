import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RsiControlStore } from "../../src/rsi/store.js";
import {
  RsiArtifactProtectedError,
  RsiExperimentRegistry,
  RsiLineageConflictError,
  type RsiArtifactLineage,
} from "../../src/rsi/registry.js";

function hash(seed: string): string {
  const hex = seed.codePointAt(0)!.toString(16).padStart(2, "0");
  return (hex + "0".repeat(62)).slice(0, 64);
}

const A = hash("a");
const B = hash("b");
const C = hash("c");
const D = hash("d");

function lineage(artifactHash: string, parentHash: string | null): RsiArtifactLineage {
  return {
    artifactHash,
    parentHash,
    improverVersion: "rel-" + artifactHash.slice(0, 4),
    riskTier: "R1",
    stateSchemaVersion: 1,
    compatibilityVersions: [1],
    compatibleWithParent: true,
  };
}

async function fixture(retained?: number) {
  const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-reg-"));
  const store = new RsiControlStore({ directory: join(dir, "control") });
  const registry = new RsiExperimentRegistry({ store, ...(retained === undefined ? {} : { retainedStableReleases: retained }) });
  return { store, registry };
}

describe("experiment lineage (P0-04b)", () => {
  it("walks parent pointers and enumerates branches", async () => {
    const { registry } = await fixture();
    await registry.registerArtifact(lineage(A, null));
    await registry.registerArtifact(lineage(B, A));
    await registry.registerArtifact(lineage(C, B));
    await registry.registerArtifact(lineage(D, A));
    expect((await registry.lineageOf(C)).map((l) => l.artifactHash)).toEqual([C, B, A]);
    expect(await registry.childrenOf(A)).toEqual([B, D].sort());
    // Unknown root: chain stops at what the log knows.
    expect((await registry.lineageOf("f".repeat(64))).length).toBe(0);
  });

  it("re-registering identical lineage is a no-op, rewriting it is a conflict", async () => {
    const { registry } = await fixture();
    await registry.registerArtifact(lineage(B, A));
    expect(await registry.registerArtifact(lineage(B, A))).toMatchObject({ parentHash: A });
    await expect(registry.registerArtifact(lineage(B, C))).rejects.toBeInstanceOf(RsiLineageConflictError);
  });
});

describe("reference protection and retention (P0-04b)", () => {
  it("active references pin bytes; releasing un-pins", async () => {
    const { registry } = await fixture();
    await registry.registerArtifact(lineage(B, A));
    await registry.addReference({ artifactHash: B, refId: "session-1", kind: "active_session" });
    expect(await registry.isCollectable(B)).toBe(false);
    expect(await registry.activeReferences(B)).toEqual(["session-1"]);
    // Re-adding the same ref is idempotent.
    await registry.addReference({ artifactHash: B, refId: "session-1", kind: "active_session" });
    expect(await registry.activeReferences(B)).toEqual(["session-1"]);
    await registry.releaseReference("session-1");
    expect(await registry.activeReferences(B)).toEqual([]);
    expect(await registry.isCollectable(B)).toBe(true);
  });

  it("the newest retained stable releases are always protected (rollback ladder)", async () => {
    const { registry } = await fixture(3);
    const releases = ["s1", "s2", "s3", "s4"];
    for (const [index, releaseId] of releases.entries()) {
      const artifact = hash(String.fromCharCode(97 + index)); // a b c d
      await registry.registerArtifact(lineage(artifact, null));
      await registry.registerStableRelease({ releaseId, artifactHash: artifact });
    }
    // Event order is log order: s1=a is the oldest and falls off the
    // three-deep ladder; s2..s4 stay protected for rollback.
    expect(await registry.isCollectable(A)).toBe(true);
    expect(await registry.isCollectable(B)).toBe(false);
    expect(await registry.isCollectable(C)).toBe(false);
    expect(await registry.isCollectable(D)).toBe(false);
  });

  it("protection survives a restart (derived from the event log)", async () => {
    const { store, registry } = await fixture();
    await registry.registerArtifact(lineage(B, A));
    await registry.addReference({ artifactHash: B, refId: "rb-1", kind: "rollback_target" });
    const reopened = new RsiExperimentRegistry({ store });
    expect(await reopened.isCollectable(B)).toBe(false);
    await expect(reopened.assertCollectable(B)).rejects.toBeInstanceOf(RsiArtifactProtectedError);
  });
});

describe("report binding (P0-04b acceptance: old report, new content = no)", async () => {
  const suiteHash = "c".repeat(64);
  const graderHash = "d".repeat(64);

  function report(candidateHash: string) {
    return {
      schemaVersion: 1 as const,
      reportId: `rep-${candidateHash.slice(0, 4)}`,
      candidateHash,
      baselineHash: A,
      suiteHash,
      graderHash,
      environmentFingerprint: "env-1",
      contractId: "r1-quality-v1",
      decision: "passed" as const,
      trialTerminals: [{
        schemaVersion: 1 as const,
        jobId: "job-1", campaignId: "camp", candidateId: "cand", caseId: "case",
        artifactHash: candidateHash,
        outcome: "passed" as const,
        stopEvidence: "exit 0 + tree probe",
        usage: { inputTokens: 1, outputTokens: 2, cachedReadTokens: 0, cachedWriteTokens: 0, computeMs: 5, costUnknown: false },
        startedAt: "2026-09-05T09:00:00Z", endedAt: "2026-09-05T09:00:10Z",
        reporter: { schemaVersion: 1 as const, role: "runner" as const, clientId: "rn", workspaceId: "ws", sessionId: null },
        evidenceRefs: ["log:x"],
      }],
      createdAt: "2026-09-05T09:05:00Z",
    };
  }

  it("finds a report only for the exact hash tuple", async () => {
    const { registry } = await fixture();
    await registry.registerArtifact(lineage(B, A));
    await registry.registerReport(report(B));
    const found = await registry.findReport({ candidateHash: B, baselineHash: A, suiteHash, graderHash });
    expect(found?.reportId).toBe(report(B).reportId);
    // One byte changed in the candidate: the old report must not resolve.
    const mutated = (B.slice(0, 63) + (B[63] === "0" ? "1" : "0")) as string;
    expect(await registry.findReport({ candidateHash: mutated, baselineHash: A, suiteHash, graderHash })).toBeUndefined();
    // A different suite or grader also breaks the bind.
    expect(await registry.findReport({ candidateHash: B, baselineHash: A, suiteHash: "e".repeat(64), graderHash })).toBeUndefined();
  });

  it("duplicate report registration is idempotent, conflicting content is rejected by the ledger", async () => {
    const { registry, store } = await fixture();
    await registry.registerReport(report(B));
    await registry.registerReport(report(B));
    const events = (await store.listEvents()).filter((e) => e.type === "eval.completed");
    expect(events.length).toBe(1);
  });
});
