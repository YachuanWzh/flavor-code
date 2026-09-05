import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { RsiBudgetLedger } from "../../src/rsi/budget.js";
import { RsiControlStore } from "../../src/rsi/store.js";

const DAY_ONE_MS = Date.UTC(2026, 8, 5, 12, 0, 0);
const DAY_TWO_MS = Date.UTC(2026, 8, 6, 12, 0, 0);

interface Harness {
  store: RsiControlStore;
  ledger: RsiBudgetLedger;
  clock: { nowMs: number };
  otherLedger: RsiBudgetLedger;
}

async function makeHarness(limit: number): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "flavor-rsi-budget-"));
  const store = new RsiControlStore({ directory });
  const otherStore = new RsiControlStore({ directory });
  const clock = { nowMs: DAY_ONE_MS };
  const now = () => new Date(clock.nowMs);
  return {
    store,
    ledger: new RsiBudgetLedger({ store, limit, now }),
    clock,
    otherLedger: new RsiBudgetLedger({ store: otherStore, limit, now }),
  };
}

describe("RsiBudgetLedger reserve/settle sequence (rsi.md E6, P0-03b)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await makeHarness(100);
  });

  it("walks the documented sequence: reserve 70, refuse 50, settle 30, retry succeeds", async () => {
    const a = await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    expect(a.granted).toBe(true);

    const b = await harness.ledger.reserve({ jobId: "B", amount: 50, idempotencyKey: "b-1" });
    expect(b).toMatchObject({ granted: false, reason: "exceeds_daily_limit" });

    const settled = await harness.ledger.settle({ jobId: "A", consumed: 30 });
    expect(settled).toMatchObject({ released: 40, consumed: 30, status: "settled" });

    const bRetry = await harness.ledger.reserve({ jobId: "B", amount: 50, idempotencyKey: "b-2" });
    expect(bRetry.granted).toBe(true);

    const summary = await harness.ledger.summary();
    expect(summary.dayConsumed).toBe(30);
    expect(summary.outstanding).toBe(50);
  });

  it("resubmitting the same idempotency key never reserves twice", async () => {
    const first = await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    const retry = await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    expect(first.granted).toBe(true);
    expect(retry).toMatchObject({ granted: true, duplicate: true });
    const summary = await harness.ledger.summary();
    expect(summary.outstanding).toBe(70);
    expect(summary.unsettledJobs).toEqual(["A"]);
  });

  it("replays an unknown-usage reservation as a conservative hold after a restart", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });

    // Simulated crash + restart: fresh instances over the same directory.
    const reopenedStore = new RsiControlStore({ directory: harness.store.directory });
    const reopened = new RsiBudgetLedger({ store: reopenedStore, limit: 100, now: () => new Date(DAY_ONE_MS) });
    const summary = await reopened.summary();
    expect(summary.outstanding).toBe(70);

    // The unconfirmed 70 still blocks new spend; 40 does not fit.
    const refused = await reopened.reserve({ jobId: "B", amount: 40, idempotencyKey: "b-1" });
    expect(refused.granted).toBe(false);

    // Reconciliation without confirmed usage keeps the full amount on hold.
    const held = await reopened.settle({ jobId: "A" });
    expect(held).toMatchObject({ status: "awaiting_reconciliation", released: 0, consumed: 70 });
    const after = await reopened.summary();
    expect(after.outstanding).toBe(70);
    expect(after.unsettledJobs).toEqual(["A"]);
    expect(after.reconciliationJobs).toEqual(["A"]);
    expect(after.dayConsumed).toBe(0);
  });

  it("rejects a reserve whose idempotency key was already used by a different event type", async () => {
    // Store-level dedup spans *all* events; a cross-type key collision must
    // never surface as "granted" without a durable budget.reserved record.
    await harness.store.appendEvent({
      type: "candidate.proposed",
      idempotencyKey: "shared-1",
      payload: { proposalId: "p-1" },
    });
    await expect(
      harness.ledger.reserve({ jobId: "A", amount: 100, idempotencyKey: "shared-1" }),
    ).rejects.toThrow(/idempotency key/i);
    const summary = await harness.ledger.summary();
    expect(summary.outstanding).toBe(0);
    expect(summary.unsettledJobs).toEqual([]);
  });

  it("rejects a retry that reuses an idempotency key with different request content", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    await expect(
      harness.ledger.reserve({ jobId: "B", amount: 20, idempotencyKey: "a-1" }),
    ).rejects.toThrow(/idempotency key/i);
    await expect(
      harness.ledger.reserve({ jobId: "A", amount: 80, idempotencyKey: "a-1" }),
    ).rejects.toThrow(/idempotency key/i);
    const summary = await harness.ledger.summary();
    expect(summary.outstanding).toBe(70);
  });

  it("keeps unknown usage as a pending-reconciliation hold until real cost is reported", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    const held = await harness.ledger.settle({ jobId: "A" });
    expect(held).toMatchObject({ status: "awaiting_reconciliation", released: 0, consumed: 70 });

    // Conservative hold blocks new spend on the reservation day ...
    const refused = await harness.ledger.reserve({ jobId: "B", amount: 40, idempotencyKey: "b-1" });
    expect(refused.granted).toBe(false);
    // ... and across the day boundary: rollover must not launder the debt.
    harness.clock.nowMs = DAY_TWO_MS;
    const refusedNextDay = await harness.ledger.reserve({ jobId: "C", amount: 60, idempotencyKey: "c-1" });
    expect(refusedNextDay.granted).toBe(false);

    // Late-reported actual usage closes the hold and releases the remainder.
    const closed = await harness.ledger.settle({ jobId: "A", consumed: 30 });
    expect(closed).toEqual({ status: "settled", released: 40, consumed: 30 });
    const summary = await harness.ledger.summary();
    expect(summary.outstanding).toBe(0);
    expect(summary.unsettledJobs).toEqual([]);
    expect(summary.reconciliationJobs).toEqual([]);
    // Consumption is attributed to the original reservation day, not the close day.
    expect(summary.dayConsumed).toBe(0);
    expect(summary.totalConsumed).toBe(30);

    const retry = await harness.ledger.reserve({ jobId: "B", amount: 50, idempotencyKey: "b-2" });
    expect(retry.granted).toBe(true);
  });

  it("retried settle with the same idempotency key returns the original decision", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    const first = await harness.ledger.settle({ jobId: "A", consumed: 30, idempotencyKey: "s-1" });
    expect(first).toEqual({ status: "settled", released: 40, consumed: 30 });

    // Crash-retry of the same settle: same answer, single billing.
    const retry = await harness.ledger.settle({ jobId: "A", consumed: 30, idempotencyKey: "s-1" });
    expect(retry).toEqual({ status: "settled", released: 40, consumed: 30 });
    expect((await harness.ledger.summary()).dayConsumed).toBe(30);

    // Same key, different content is a conflict, never a silent replay.
    await expect(
      harness.ledger.settle({ jobId: "A", consumed: 20, idempotencyKey: "s-1" }),
    ).rejects.toThrow(/idempotency key/i);
    await expect(
      harness.ledger.settle({ jobId: "B", consumed: 30, idempotencyKey: "s-1" }),
    ).rejects.toThrow(/idempotency key/i);
  });

  it("settling a closed job without a key stays rejected, with a key replays", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 50, idempotencyKey: "a-1" });
    await harness.ledger.settle({ jobId: "A", consumed: 10, idempotencyKey: "s-1" });
    await expect(harness.ledger.settle({ jobId: "A", consumed: 10 })).rejects.toThrow(/No outstanding/i);
    // Unknown-usage settle is also idempotent under a key.
    await harness.ledger.reserve({ jobId: "C", amount: 20, idempotencyKey: "c-1" });
    const held = await harness.ledger.settle({ jobId: "C", idempotencyKey: "c-hold" });
    expect(held).toEqual({ status: "awaiting_reconciliation", released: 0, consumed: 20 });
    const heldAgain = await harness.ledger.settle({ jobId: "C", idempotencyKey: "c-hold" });
    expect(heldAgain).toEqual(held);
  });

  it("repeated unknown settles stay pending; closing a settled job is rejected", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 50, idempotencyKey: "a-1" });
    expect((await harness.ledger.settle({ jobId: "A" })).status).toBe("awaiting_reconciliation");
    expect((await harness.ledger.settle({ jobId: "A" })).status).toBe("awaiting_reconciliation");
    expect((await harness.ledger.summary()).outstanding).toBe(50);
    await harness.ledger.settle({ jobId: "A", consumed: 10 });
    await expect(harness.ledger.settle({ jobId: "A", consumed: 10 })).rejects.toThrow(/No outstanding/i);
  });

  it("two racing ledgers cannot oversell the same remaining budget", async () => {
    const [first, second] = await Promise.all([
      harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "race-a" }),
      harness.otherLedger.reserve({ jobId: "B", amount: 50, idempotencyKey: "race-b" }),
    ]);
    const grants = [first.granted, second.granted].filter(Boolean);
    expect(grants).toHaveLength(1);
    const summary = await harness.ledger.summary();
    expect(summary.outstanding).toBe(first.granted ? 70 : 50);
  });

  it("denied requests do not consume budget but stay idempotent", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 100, idempotencyKey: "a-1" });
    const denied = await harness.ledger.reserve({ jobId: "B", amount: 1, idempotencyKey: "b-1" });
    expect(denied.granted).toBe(false);
    const replay = await harness.ledger.reserve({ jobId: "B", amount: 1, idempotencyKey: "b-1" });
    expect(replay).toMatchObject({ granted: false, duplicate: true });
    expect((await harness.ledger.summary()).outstanding).toBe(100);
  });

  it("validates amounts and settlement preconditions", async () => {
    await expect(harness.ledger.reserve({ jobId: "A", amount: 0, idempotencyKey: "a-0" })).rejects.toThrow(/positive integer/);
    await expect(harness.ledger.reserve({ jobId: "A", amount: 1.5, idempotencyKey: "a-half" })).rejects.toThrow(/positive integer/);
    await expect(harness.ledger.settle({ jobId: "ghost" })).rejects.toThrow(/No outstanding budget reservation/);

    await harness.ledger.reserve({ jobId: "A", amount: 50, idempotencyKey: "a-1" });
    await expect(harness.ledger.settle({ jobId: "A", consumed: 60 })).rejects.toThrow(/exceeds reserved allowance/);
    await expect(
      harness.ledger.reserve({ jobId: "A", amount: 10, idempotencyKey: "a-2" }),
    ).rejects.toThrow(/already holds an outstanding reservation/);
  });

  it("settled usage stays attributed to its reservation day while new days re-open capacity", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 100, idempotencyKey: "a-1" });
    await harness.ledger.settle({ jobId: "A", consumed: 100 });
    const blocked = await harness.ledger.reserve({ jobId: "B", amount: 1, idempotencyKey: "b-1" });
    expect(blocked.granted).toBe(false);

    harness.clock.nowMs = DAY_TWO_MS;
    const nextDay = await harness.ledger.reserve({ jobId: "B", amount: 100, idempotencyKey: "b-2" });
    expect(nextDay.granted).toBe(true);
    const summary = await harness.ledger.summary();
    expect(summary.day).toBe("2026-09-06");
    expect(summary.dayConsumed).toBe(0);
    expect(summary.outstanding).toBe(100);
    expect(summary.totalConsumed).toBe(100);
  });

  it("an outstanding reservation from a previous day still counts against the new day", async () => {
    await harness.ledger.reserve({ jobId: "A", amount: 70, idempotencyKey: "a-1" });
    harness.clock.nowMs = DAY_TWO_MS;
    const refused = await harness.ledger.reserve({ jobId: "B", amount: 40, idempotencyKey: "b-1" });
    expect(refused.granted).toBe(false);
    const fits = await harness.ledger.reserve({ jobId: "B", amount: 30, idempotencyKey: "b-2" });
    expect(fits.granted).toBe(true);
  });

  it("rejects a non-positive limit at construction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flavor-rsi-budget-bad-"));
    const store = new RsiControlStore({ directory });
    expect(() => new RsiBudgetLedger({ store, limit: 0 })).toThrow(/positive integer/);
  });
});
