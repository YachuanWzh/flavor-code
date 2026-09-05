import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GoalStore } from "../../src/goal/store.js";
import type { GoalState } from "../../src/goal/types.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-goal-store-"));
  roots.push(root);
  return root;
}

function state(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "goal-one",
    objective: "make tests pass",
    phase: "executing",
    status: "active",
    plan: null,
    planPath: null,
    verifyRounds: 0,
    workerRounds: 1,
    lastGaps: [],
    gapFingerprint: "",
    stallStreak: 0,
    contractHash: "a".repeat(64),
    evidenceRounds: [],
    createdAt: "2026-07-26T00:00:00.000Z",
    updatedAt: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalStore", () => {
  it("atomically saves and reloads a strict snapshot", async () => {
    const root = await workspace();
    const store = new GoalStore({ workspace: root });
    await store.save(state());
    await store.save(state({ status: "achieved", phase: "complete", verifyRounds: 1, updatedAt: "2026-07-26T01:00:00.000Z" }));
    await expect(store.load("goal-one")).resolves.toMatchObject({ status: "achieved", phase: "complete", verifyRounds: 1 });
    expect((await lstat(join(root, ".flavor", "goals", "goal-one.json"))).isFile()).toBe(true);
    const parsed = JSON.parse(await readFile(join(root, ".flavor", "goals", "goal-one.json"), "utf8")) as GoalState;
    expect(parsed.id).toBe("goal-one");
  });

  it("rejects an unknown or malformed goal id", async () => {
    const root = await workspace();
    const store = new GoalStore({ workspace: root });
    await expect(store.load("missing")).rejects.toThrow(/was not found/i);
    await expect(store.load("../escape")).rejects.toThrow(/was not found/i);
  });

  it("quarantines a corrupt snapshot instead of throwing raw JSON errors", async () => {
    const root = await workspace();
    const store = new GoalStore({ workspace: root });
    const directory = join(root, ".flavor", "goals");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "goal-one.json"), "not-json");
    await expect(store.load("goal-one")).rejects.toThrow(/corrupt and was quarantined/i);
    // The bad file was moved aside, so the original path is gone.
    await expect(lstat(join(directory, "goal-one.json"))).rejects.toThrow();
  });

  it("rejects a state that violates the schema on save", async () => {
    const root = await workspace();
    const store = new GoalStore({ workspace: root });
    await expect(store.save(state({ contractHash: "too-short" }))).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects a symlinked goals directory", async () => {
    const root = await workspace();
    const store = new GoalStore({ workspace: root });
    const outside = await mkdtemp(join(tmpdir(), "flavor-goal-outside-"));
    roots.push(outside);
    await mkdir(join(root, ".flavor"), { recursive: true });
    await symlink(outside, join(root, ".flavor", "goals"), "dir");
    await expect(store.save(state())).rejects.toThrow(/symbolic link|escapes/i);
  });
});
