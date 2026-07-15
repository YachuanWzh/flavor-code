import { lstat, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LoopStore } from "../../src/loop/store.js";
import type { LoopEvent, LoopState } from "../../src/loop/types.js";

async function fixture(): Promise<{ workspace: string; store: LoopStore; state: LoopState }> {
  const workspace = await mkdtemp(join(tmpdir(), "flavor-loop-store-"));
  const store = new LoopStore({ workspace });
  const state: LoopState = {
    version: 1, loopId: "loop-one", goal: "make tests pass", workspace,
    createdAt: "2026-07-15T00:00:00.000Z", updatedAt: "2026-07-15T00:00:00.000Z", status: "running",
    config: { cycleStep: 20, tokenStep: 500_000, isolation: "auto" },
    budget: { cyclesUsed: 0, inputTokens: 0, outputTokens: 0, cycleCheckpoint: 20, tokenCheckpoint: 500_000, approvals: [] },
    cycles: [],
  };
  return { workspace, store, state };
}

describe("LoopStore", () => {
  it("atomically saves and reloads a strict snapshot", async () => {
    const f = await fixture();
    await f.store.save(f.state);
    await f.store.save({ ...f.state, status: "succeeded", updatedAt: "2026-07-15T01:00:00.000Z" });
    await expect(f.store.load("loop-one")).resolves.toMatchObject({ status: "succeeded" });
    expect((await lstat(join(f.workspace, ".flavor", "loops", "loop-one", "state.json"))).isFile()).toBe(true);
  });

  it("serializes append-only events in order", async () => {
    const f = await fixture();
    const events: LoopEvent[] = [
      { version: 1, type: "created", timestamp: "2026-07-15T00:00:00.000Z", loopId: "loop-one", payload: {} },
      { version: 1, type: "terminal", timestamp: "2026-07-15T01:00:00.000Z", loopId: "loop-one", payload: { status: "succeeded" } },
    ];
    await Promise.all(events.map((event) => f.store.append(event)));
    const raw = await readFile(join(f.workspace, ".flavor", "loops", "loop-one", "events.jsonl"), "utf8");
    expect(raw.trim().split("\n").map((line) => JSON.parse(line))).toEqual(events);
  });

  it("rejects invalid ids and snapshots from another workspace", async () => {
    const f = await fixture();
    await expect(f.store.load("../escape")).rejects.toThrow(/loop id/i);
    await expect(f.store.save({ ...f.state, workspace: join(f.workspace, "other") })).rejects.toThrow(/workspace/i);
  });

  it("quarantines corrupt snapshots", async () => {
    const f = await fixture();
    const directory = join(f.workspace, ".flavor", "loops", "loop-one");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "state.json"), "not-json");
    await expect(f.store.load("loop-one")).rejects.toThrow(/quarantined/i);
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked loops directory", async () => {
    const f = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "flavor-loop-outside-"));
    await mkdir(join(f.workspace, ".flavor"), { recursive: true });
    await symlink(outside, join(f.workspace, ".flavor", "loops"), "dir");
    await expect(f.store.save(f.state)).rejects.toThrow(/symbolic link|escapes/i);
  });
});
