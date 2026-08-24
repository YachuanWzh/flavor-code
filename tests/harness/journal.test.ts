import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { HarnessJournal } from "../../src/harness/journal.js";
import { harnessInvariantViolations } from "../../src/harness/invariants.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-journal-"));
  roots.push(root);
  return root;
}

describe("HarnessJournal", () => {
  it("recovers admitted and claimed queue items without duplicating them", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-one" });
    const first = journal.admitQueue("steer", { text: "one" });
    const second = journal.admitQueue("followUp", { text: "two" });
    journal.claimQueue(first);
    journal.ackQueue(second);

    const reopened = new HarnessJournal({ workspace: root, sessionId: "session-one" });
    expect(reopened.recover().queue).toEqual([
      expect.objectContaining({ id: first, kind: "steer", payload: { text: "one" }, recovered: true }),
    ]);
  });

  it("never schedules an interrupted non-retry-safe tool for replay", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-tools" });
    const tool = journal.startTool("Write", { path: "secret.txt", content: "private" }, false);
    const recovery = new HarnessJournal({ workspace: root, sessionId: "session-tools" }).recover();

    expect(recovery.incompleteTools).toEqual([expect.objectContaining({ id: tool, tool: "Write", retrySafe: false })]);
    expect(JSON.stringify(recovery)).not.toContain("private");

    journal.markRecoveryComplete(recovery);
    expect(new HarnessJournal({ workspace: root, sessionId: "session-tools" }).recover().incompleteTools).toEqual([]);
  });

  it("truncates one partial crash tail and continues the hash chain", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-tail" });
    journal.admitQueue("steer", { text: "safe" });
    await appendFile(journal.path, '{"partial":', "utf8");

    const reopened = new HarnessJournal({ workspace: root, sessionId: "session-tail" });
    reopened.admitQueue("followUp", { text: "after" });
    expect(new HarnessJournal({ workspace: root, sessionId: "session-tail" }).records).toHaveLength(2);
  });

  it("fails closed when a committed record is modified", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-tamper" });
    journal.admitQueue("steer", { text: "original" });
    const raw = await readFile(journal.path, "utf8");
    await writeFile(journal.path, raw.replace("original", "modified"), "utf8");

    expect(() => new HarnessJournal({ workspace: root, sessionId: "session-tamper" })).toThrow(/hash/i);
  });

  it("mechanically rejects terminal events without a matching start", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-invariant" });
    journal.admitQueue("steer", { text: "one" });
    const [record] = journal.records;
    expect(harnessInvariantViolations([{ ...record!, type: "queue.acked", payload: { id: "missing" } }])).toEqual([
      expect.stringContaining("unknown queue"),
    ]);
  });

  it("retains replayable turn and model inputs while satisfying invariants", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-replay" });
    const prompt = { text: "repair the cache", images: [{ mediaType: "image/png", data: "encoded" }] };
    const messages = [{ role: "system", content: "stable" }, { role: "user", content: "repair the cache" }];
    const turn = journal.startTurn({ model: "fake:model", permissionMode: "default" }, prompt);
    const model = journal.startModel({ agent: "main", model: "fake:model", iteration: 1, attempt: 1, messages });
    journal.completeModel(model, true);
    journal.completeTurn(turn);

    const records = new HarnessJournal({ workspace: root, sessionId: "session-replay" }).records;
    expect(records.find((record) => record.type === "turn.started")?.payload.prompt).toEqual(prompt);
    expect(records.find((record) => record.type === "model.requested")?.payload.messages).toEqual(messages);
    expect(harnessInvariantViolations(records)).toEqual([]);
  });
});
