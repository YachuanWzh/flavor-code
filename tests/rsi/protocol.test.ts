import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RsiBudgetLedger } from "../../src/rsi/budget.js";
import { RsiControlClient } from "../../src/rsi/control-client.js";
import { RsiControlError } from "../../src/rsi/control-protocol.js";
import { RsiControlService } from "../../src/rsi/control-service.js";
import { RsiControlStore } from "../../src/rsi/store.js";
import { RsiRequestIdentitySchema, type RsiControlRole } from "../../src/rsi/types.js";

const DAILY_LIMIT = 100;

async function serviceHarness() {
  const dir = await mkdtemp(join(tmpdir(), "flavor-rsi-svc-"));
  const store = new RsiControlStore({ directory: join(dir, "control") });
  const budget = new RsiBudgetLedger({ store, limit: DAILY_LIMIT });
  const service = new RsiControlService({ store, budget, artifactStore: join(dir, "artifacts") });
  const client = (role: RsiControlRole) =>
    new RsiControlClient({
      transport: (request) => service.handle(request),
      token: service.mintToken(RsiRequestIdentitySchema.parse({
        schemaVersion: 1, role, clientId: `client-${role}`, workspaceId: "ws-1", sessionId: null,
      })),
    });
  return { dir, store, budget, service, client };
}

describe("control service auth and dispatch (P0-03c)", () => {
  it("a candidate token can never issue control requests, promotion included", async () => {
    const { client } = await serviceHarness();
    const candidate = client("candidate");
    await expect(
      candidate.call("promotion.commit", { candidateId: "c-1", reportId: "r-1" }, { idempotencyKey: "x-1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      candidate.call("budget.settle", { jobId: "A", consumed: 1 }, { idempotencyKey: "x-2" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      candidate.call("reconcile.report", {}),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("unknown tokens are unauthorized; missing idempotency keys never reach the wire", async () => {
    const { service } = await serviceHarness();
    const anonymous = new RsiControlClient({ transport: (r) => service.handle(r), token: "t".repeat(32) });
    await expect(anonymous.call("reconcile.report", {})).rejects.toMatchObject({ code: "unauthorized" });
    const { client } = await serviceHarness();
    await expect(
      client("governor").call("budget.reserve", { jobId: "A", amount: 10 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reserve grants once, replays under the same key, and refuses oversell on the ledger", async () => {
    const { client } = await serviceHarness();
    const governor = client("governor");
    const first = await governor.call("budget.reserve", { jobId: "A", amount: 60 }, { idempotencyKey: "a-1" });
    expect(first).toMatchObject({ granted: true, duplicate: false });
    const replay = await governor.call("budget.reserve", { jobId: "A", amount: 60 }, { idempotencyKey: "a-1" });
    expect(replay).toMatchObject({ granted: true, duplicate: true });
    const raced = await governor.call("budget.reserve", { jobId: "B", amount: 60 }, { idempotencyKey: "b-1" });
    expect(raced).toMatchObject({ granted: false });
  });

  it("runners settle and report terminals; they cannot propose candidates", async () => {
    const { client, budget } = await serviceHarness();
    const governor = client("governor");
    const runner = client("runner");
    await governor.call("budget.reserve", { jobId: "A", amount: 70 }, { idempotencyKey: "a-1" });
    const validCandidate = {
      schemaVersion: 1, candidateId: "c-1", campaignId: "camp", parentReleaseIds: ["rel-0"],
      proposerReleaseId: "rel-0", kind: "prompt_rule", risk: "R1",
      hypothesis: { problem: "p", mechanism: "m", expectedBenefit: "b", sourceIds: ["s"], counterexampleCaseIds: [] },
      scope: { workspaceIds: ["ws-1"], platforms: ["win32"], taskFamilies: ["t"] },
      artifact: { sha256: "a".repeat(64), manifestRef: "artifacts/x", runtimeMode: "isolated", stateSchemaVersion: 1 },
      contractRef: "r1", lifecycle: "proposed", revision: 1,
    };
    await expect(
      runner.call("candidate.propose", validCandidate, { idempotencyKey: "p-1" }),
    ).rejects.toMatchObject({ code: "forbidden" }); // authority before dispatch
    await expect(
      governor.call("candidate.propose", { candidateId: "c" }, { idempotencyKey: "p-2" }),
    ).rejects.toMatchObject({ code: "invalid_request" }); // governor passes, body does not
    const terminal = {
      schemaVersion: 1,
      jobId: "A", campaignId: "camp", candidateId: "cand", caseId: "case",
      artifactHash: "a".repeat(64),
      outcome: "passed",
      stopEvidence: "process tree probe: ESRCH",
      usage: { inputTokens: 10, outputTokens: 20, cachedReadTokens: 0, cachedWriteTokens: 0, computeMs: 100, costUnknown: false },
      startedAt: "2026-09-05T10:00:00Z", endedAt: "2026-09-05T10:00:30Z",
      reporter: { schemaVersion: 1, role: "runner", clientId: "client-runner", workspaceId: "ws-1", sessionId: null },
      evidenceRefs: ["log:1"],
    };
    const report = await runner.call("trial.report", { terminal, consumption: 25 }, { idempotencyKey: "t-1" });
    expect(report).toMatchObject({ recorded: true, settlement: { status: "settled", consumed: 25 } });
    expect(await budget.summary()).toMatchObject({ dayConsumed: 25, unsettledJobs: [] });
  });

  it("promotion machinery answers unsupported only for authorized governors", async () => {
    const { client } = await serviceHarness();
    await expect(
      client("runner").call("promotion.prepare", { candidateId: "c" }, { idempotencyKey: "q-1" }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      client("governor").call("promotion.prepare", { candidateId: "c" }, { idempotencyKey: "q-1" }),
    ).rejects.toMatchObject({ code: "unsupported" });
  });

  it("pause freezes mutations but keeps reconciliation visible", async () => {
    const { client } = await serviceHarness();
    const governor = client("governor");
    const observer = client("observer");
    expect(await governor.call("pause", { paused: true }, { idempotencyKey: "p-1" })).toMatchObject({ paused: true });
    await expect(
      governor.call("budget.reserve", { jobId: "A", amount: 5 }, { idempotencyKey: "a-1" }),
    ).rejects.toMatchObject({ code: "paused" });
    expect(await observer.call("reconcile.report", {})).toMatchObject({
      summary: { limit: DAILY_LIMIT },
    });
    expect(await governor.call("pause", { paused: false }, { idempotencyKey: "p-2" })).toMatchObject({ paused: false });
    expect(await governor.call("budget.reserve", { jobId: "A", amount: 5 }, { idempotencyKey: "a-1" })).toMatchObject({ granted: true });
  });

  it("malformed bodies are rejected locally before touching the transport", async () => {
    const { client } = await serviceHarness();
    await expect(
      client("governor").call("budget.reserve", { jobId: "A", amount: 5, smuggled: true }, { idempotencyKey: "a-1" }),
    ).rejects.toBeInstanceOf(RsiControlError);
  });
});
