import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildArtifactManifest } from "../../src/rsi/artifact.js";
import { RsiBudgetLedger } from "../../src/rsi/budget.js";
import { RsiControlClient } from "../../src/rsi/control-client.js";
import { RsiControlService } from "../../src/rsi/control-service.js";
import { RsiControlStore } from "../../src/rsi/store.js";
import { RsiRequestIdentitySchema, type RsiControlRole } from "../../src/rsi/types.js";

/** Rebuild a full service stack over the same protected directory (crash). */
function stackIn(dir: string) {
  const store = new RsiControlStore({ directory: join(dir, "control") });
  const budget = new RsiBudgetLedger({ store, limit: 100 });
  const service = new RsiControlService({ store, budget, artifactStore: join(dir, "artifacts") });
  const client = (role: RsiControlRole) =>
    new RsiControlClient({
      transport: (request) => service.handle(request),
      token: service.mintToken(RsiRequestIdentitySchema.parse({
        schemaVersion: 1, role, clientId: `client-${role}`, workspaceId: "ws-1", sessionId: null,
      })),
    });
  return { store, budget, service, client };
}

describe("crash recovery and reconciliation via the control service (P0-03c)", () => {
  it("pending holds survive a restart and keep blocking new spend", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-rec-"));
    const before = stackIn(dir);
    const governor = before.client("governor");
    await governor.call("budget.reserve", { jobId: "A", amount: 70 }, { idempotencyKey: "a-1" });
    await governor.call("budget.settle", { jobId: "A", consumed: null }, { idempotencyKey: "a-hold" });

    // Crash: fresh store/ledger/service instances over the same directory.
    const after = stackIn(dir);
    const report = await after.client("observer").call("reconcile.report", {}) as {
      summary: { outstanding: number; reconciliationJobs: string[]; unsettledJobs: string[] };
    };
    expect(report.summary.reconciliationJobs).toEqual(["A"]);
    expect(report.summary.outstanding).toBe(70);
    // Conservative hold still blocks: 70 > 100 - 40.
    expect(await after.client("governor").call("budget.reserve", { jobId: "B", amount: 40 }, { idempotencyKey: "b-1" }))
      .toMatchObject({ granted: false });
  });

  it("governor reconcile.close finalizes a hold with the confirmed usage", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-rec-"));
    const service = stackIn(dir);
    const governor = service.client("governor");
    await governor.call("budget.reserve", { jobId: "A", amount: 70 }, { idempotencyKey: "a-1" });
    await governor.call("budget.settle", { jobId: "A", consumed: null }, { idempotencyKey: "a-hold" });
    await governor.call("reconcile.close", { jobId: "A", consumed: 30 }, { idempotencyKey: "a-close" });
    expect(await service.budget.summary()).toMatchObject({
      dayConsumed: 30, outstanding: 0, reconciliationJobs: [],
    });
    expect(await governor.call("budget.reserve", { jobId: "B", amount: 65 }, { idempotencyKey: "b-1" }))
      .toMatchObject({ granted: true });
  });

  it("a replayed trial.report after a crash settles exactly once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-rec-"));
    const first = stackIn(dir);
    await first.client("governor").call("budget.reserve", { jobId: "A", amount: 70 }, { idempotencyKey: "a-1" });
    const terminal = {
      schemaVersion: 1,
      jobId: "A", campaignId: "camp", candidateId: "cand", caseId: "case",
      artifactHash: "a".repeat(64),
      outcome: "failed",
      stopEvidence: "runner exit code 1; tree probe empty",
      usage: { inputTokens: 8, outputTokens: 4, cachedReadTokens: 0, cachedWriteTokens: 0, computeMs: 50, costUnknown: false },
      startedAt: "2026-09-05T11:00:00Z", endedAt: "2026-09-05T11:00:05Z",
      reporter: { schemaVersion: 1, role: "runner", clientId: "runner-a", workspaceId: "ws-1", sessionId: null },
      evidenceRefs: ["log:failure-1"],
    };
    await first.client("runner").call("trial.report", { terminal, consumption: 25 }, { idempotencyKey: "t-1" });

    // Crash mid-delivery: the retry re-sends the same keyed report.
    const retry = stackIn(dir);
    const again = await retry.client("runner").call("trial.report", { terminal, consumption: 25 }, { idempotencyKey: "t-1" }) as {
      recorded: boolean; settlement: { status: string; consumed: number };
    };
    expect(again).toMatchObject({ recorded: false, settlement: { status: "settled", consumed: 25 } });
    expect(await retry.budget.summary()).toMatchObject({ dayConsumed: 25, unsettledJobs: [] });
    const events = await retry.store.listEvents();
    expect(events.filter((e) => e.type === "trial.reported")).toHaveLength(1);
  });

  it("artifact.freeze verifies and records the frozen hash", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-rec-"));
    const root = join(dir, "candidate");
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "rule.md"), "prefer glob before read\n");
    const manifest = await buildArtifactManifest({
      root, entries: ["src/rule.md"], runtimeMode: "isolated",
      config: { tier: "R1" }, stateSchemaVersion: 1, dependencyIds: [],
    });
    const service = stackIn(dir);
    const result = await service.client("runner").call(
      "artifact.freeze", { root, manifest }, { idempotencyKey: "f-1" },
    ) as { artifactHash: string };
    expect(result.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    const events = await service.store.listEvents();
    expect(events.some((e) => e.type === "artifact.frozen" && e.payload["artifactHash"] === result.artifactHash)).toBe(true);
    // Re-freezing identical content is a content-addressed no-op replay.
    expect(await service.client("runner").call(
      "artifact.freeze", { root, manifest }, { idempotencyKey: "f-2" },
    )).toMatchObject({ artifactHash: result.artifactHash });
  });
});
