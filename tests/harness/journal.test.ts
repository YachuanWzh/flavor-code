import { appendFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

  it("accepts a contiguous hash-valid tail after journal prefix rotation", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-rotated" });
    journal.admitQueue("steer", { text: "discarded prefix" });
    const retained = journal.admitQueue("followUp", { text: "retained tail" });
    const lines = (await readFile(journal.path, "utf8")).trimEnd().split("\n");
    await writeFile(journal.path, `${lines.slice(1).join("\n")}\n`, "utf8");

    const reopened = new HarnessJournal({ workspace: root, sessionId: "session-rotated" });
    expect(reopened.recover().queue).toEqual([
      expect.objectContaining({ id: retained, kind: "followUp", payload: { text: "retained tail" } }),
    ]);
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

  it("stores hashes instead of duplicating large turn, model, and tool payloads", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-replay" });
    const large = `unique-secret-${"x".repeat(128 * 1024)}`;
    const prompt = { text: large };
    const messages = [{ role: "user", content: large }];
    const turn = journal.startTurn({ model: "fake:model", permissionMode: "default" }, prompt);
    const model = journal.startModel({ agent: "main", model: "fake:model", iteration: 1, attempt: 1, messages });
    const tool = journal.startTool("Read", { path: large }, true);
    journal.completeTool(tool, { content: large });
    journal.completeModel(model, true);
    journal.completeTurn(turn);

    const records = new HarnessJournal({ workspace: root, sessionId: "session-replay" }).records;
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("unique-secret");
    expect(records.find((record) => record.type === "turn.started")?.payload).toEqual(expect.objectContaining({
      configHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      promptHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(records.find((record) => record.type === "model.requested")?.payload).toEqual(expect.objectContaining({
      messagesHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(harnessInvariantViolations(records)).toEqual([]);
  });

  it("compacts completed history instead of blocking when the size limit is reached", async () => {
    const root = await workspace();
    const journal = new HarnessJournal({ workspace: root, sessionId: "session-bounded", maxBytes: 4096 });
    const incompleteTool = journal.startTool("Write", { path: "important.txt", content: "value" }, false);

    for (let index = 0; index < 40; index += 1) {
      const turn = journal.startTurn({ model: "fake:model" }, { text: `prompt-${index}` });
      const model = journal.startModel({
        agent: "main",
        model: "fake:model",
        iteration: index,
        attempt: 1,
        messages: [{ role: "user", content: "x".repeat(64 * 1024) }],
      });
      journal.completeModel(model, true);
      journal.completeTurn(turn);
    }

    expect((await stat(journal.path)).size).toBeLessThanOrEqual(4096);
    const reopened = new HarnessJournal({ workspace: root, sessionId: "session-bounded", maxBytes: 4096 });
    expect(reopened.recover().incompleteTools).toEqual([
      expect.objectContaining({ id: incompleteTool, tool: "Write", retrySafe: false }),
    ]);
    expect(harnessInvariantViolations(reopened.records)).toEqual([]);
  });
});
