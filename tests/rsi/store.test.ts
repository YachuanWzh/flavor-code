import { mkdtemp, readFile, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { RsiControlStore, RsiRevisionConflictError } from "../../src/rsi/store.js";

async function openStore(): Promise<{ store: RsiControlStore; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "flavor-rsi-store-"));
  const store = new RsiControlStore({ directory });
  return { store, directory };
}

describe("RsiControlStore event log (P0-03a)", () => {
  let directory: string;
  let store: RsiControlStore;

  beforeEach(async () => {
    const opened = await openStore();
    store = opened.store;
    directory = opened.directory;
  });

  it("persists events across reopen with contiguous sequences and chaining", async () => {
    const first = await store.appendEvent({ type: "candidate.proposed", payload: { candidateId: "c-1" } });
    const second = await store.appendEvent({ type: "artifact.frozen", payload: { candidateId: "c-1", sha256: "ab".repeat(32) } });
    expect(second.record.sequence).toBe(2);
    expect(second.record.previousHash).toBe(first.record.hash);

    const reopened = new RsiControlStore({ directory });
    const events = await reopened.listEvents();
    expect(events.map((record) => record.type)).toEqual(["candidate.proposed", "artifact.frozen"]);
    expect(events[1]?.payload.sha256).toBe("ab".repeat(32));
  });

  it("returns the original record for a duplicate idempotencyKey without writing", async () => {
    const first = await store.appendEvent({ type: "budget.reserved", payload: { jobId: "a", amount: 70 }, idempotencyKey: "req-a" });
    const retry = await store.appendEvent({ type: "budget.reserved", payload: { jobId: "a", amount: 70 }, idempotencyKey: "req-a" });
    expect(retry.duplicate).toBe(true);
    expect(retry.record.id).toBe(first.record.id);

    const reopened = new RsiControlStore({ directory });
    expect(await reopened.listEvents()).toHaveLength(1);
  });

  it("refuses unknown event types before touching the log", async () => {
    await expect(
      store.appendEvent({ type: "promotion.yolo" as never, payload: {} }),
    ).rejects.toThrow();
    expect(await store.listEvents()).toHaveLength(0);
  });

  it("detects a tampered committed record on reload", async () => {
    await store.appendEvent({ type: "eval.completed", payload: { candidateId: "c-1", qualified: true } });
    const raw = await readFile(join(directory, "events.jsonl"), "utf8");
    await writeFile(join(directory, "events.jsonl"), raw.replace("true", "false"), "utf8");

    const reopened = new RsiControlStore({ directory });
    await expect(reopened.listEvents()).rejects.toThrow(/hash is invalid/);
  });

  it("drops only an unterminated torn tail line and keeps committed records", async () => {
    await store.appendEvent({ type: "rollback.started", payload: { releaseId: "r-1" } });
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, (await readFile(eventsPath, "utf8")) + '{"partial":tru', "utf8");

    const reopened = new RsiControlStore({ directory });
    const events = await reopened.listEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("rollback.started");
  });

  it("fails closed on a malformed committed line (missing required field)", async () => {
    const eventsPath = join(directory, "events.jsonl");
    await writeFile(eventsPath, '{"version":1,"sequence":1}\n{"again":2}\n', "utf8");
    const reopened = new RsiControlStore({ directory });
    await expect(reopened.listEvents()).rejects.toThrow();
  });

  it("serializes appends from two store instances with a contiguous chain", async () => {
    const other = new RsiControlStore({ directory });
    const results = await Promise.all([
      store.appendEvent({ type: "candidate.proposed", payload: { candidateId: "c-1" } }),
      other.appendEvent({ type: "candidate.proposed", payload: { candidateId: "c-2" } }),
      store.appendEvent({ type: "candidate.proposed", payload: { candidateId: "c-3" } }),
    ]);
    expect(results.map((result) => result.record.sequence).sort()).toEqual([1, 2, 3]);

    const events = await new RsiControlStore({ directory }).listEvents();
    expect(events).toHaveLength(3);
    expect(events[1]?.previousHash).toBe(events[0]?.hash);
    expect(events[2]?.previousHash).toBe(events[1]?.hash);
  });
});

describe("RsiControlStore snapshot CAS (P0-03a)", () => {
  let directory: string;
  let store: RsiControlStore;

  beforeEach(async () => {
    const opened = await openStore();
    store = opened.store;
    directory = opened.directory;
  });

  it("advances the revision from 0 and persists across reopen", async () => {
    expect(await store.readState()).toBeNull();
    const written = await store.compareAndSetState({ expectedRevision: 0, data: { phase: "idle" } });
    expect(written.revision).toBe(1);
    const reopened = new RsiControlStore({ directory });
    expect(await reopened.readState()).toEqual({ version: 1, revision: 1, data: { phase: "idle" } });
  });

  it("refuses a stale expectedRevision with a conflict error", async () => {
    await store.compareAndSetState({ expectedRevision: 0, data: { phase: "prepared" } });
    await expect(store.compareAndSetState({ expectedRevision: 0, data: { phase: "committed" } }))
      .rejects.toBeInstanceOf(RsiRevisionConflictError);
    const state = await store.readState();
    expect(state?.data.phase).toBe("prepared");
    expect(state?.revision).toBe(1);
  });

  it("runs transactions without re-entering the lock and observes fresh events", async () => {
    await store.appendEvent({ type: "budget.reserved", payload: { jobId: "a", amount: 5 }, idempotencyKey: "k-1" });
    const seen = await store.transact(async (tx) => {
      const appended = await tx.appendEvent({ type: "budget.reserved", payload: { jobId: "b", amount: 5 }, idempotencyKey: "k-2" });
      const events = await tx.listEvents();
      return { appended: appended.duplicate, count: events.length };
    });
    expect(seen).toEqual({ appended: false, count: 2 });
    const retryKey = await store.appendEvent({ type: "budget.reserved", payload: { jobId: "b", amount: 5 }, idempotencyKey: "k-2" });
    expect(retryKey.duplicate).toBe(true);
  });
});
