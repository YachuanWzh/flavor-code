import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { desktopGitHistory, desktopGitReviewDiff, desktopLastTurnDiff } from "../../src/desktop/git-manager.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("desktop review scopes", () => {
  it("reads commit, base branch and last-turn path scopes without mutating Git", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-review-scopes-")); roots.push(root);
    execFileSync("git", ["init", "--quiet", root]);
    execFileSync("git", ["-C", root, "config", "user.email", "review@test.local"]);
    execFileSync("git", ["-C", root, "config", "user.name", "Review Test"]);
    await writeFile(join(root, "a.txt"), "one\n", "utf8");
    execFileSync("git", ["-C", root, "add", "a.txt"]); execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "base"]);
    const base = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(root, "a.txt"), "two\n", "utf8");
    execFileSync("git", ["-C", root, "add", "a.txt"]); execFileSync("git", ["-C", root, "commit", "--quiet", "-m", "change"]);
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    await writeFile(join(root, "a.txt"), "three\n", "utf8");

    expect(await desktopGitReviewDiff(root, { scope: "commit", target: head })).toContain("+two");
    expect(await desktopGitReviewDiff(root, { scope: "base", target: base })).toContain("+two");
    expect(await desktopGitReviewDiff(root, { scope: "last-turn", paths: ["a.txt"] })).toContain("+three");
    expect(await desktopGitHistory(root)).toEqual([expect.objectContaining({ subject: "change" }), expect.objectContaining({ subject: "base" })]);
  });

  it("uses adjacent immutable checkpoints for the last assistant turn", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-review-turn-")); roots.push(root);
    const checkpointRoot = join(root, ".flavor", "checkpoints");
    await mkdir(join(checkpointRoot, "objects"), { recursive: true }); await mkdir(join(checkpointRoot, "manifests"), { recursive: true });
    await mkdir(join(root, ".flavor", "session-trees", "session-one"), { recursive: true });
    const before = "before\n"; const after = "after\n";
    const beforeHash = createHash("sha256").update(before).digest("hex"); const afterHash = createHash("sha256").update(after).digest("hex");
    await writeFile(join(checkpointRoot, "objects", beforeHash), before); await writeFile(join(checkpointRoot, "objects", afterHash), after);
    await writeFile(join(checkpointRoot, "manifests", "checkpoint-before.json"), JSON.stringify({ files: [{ path: "a.txt", digest: beforeHash }] }));
    await writeFile(join(checkpointRoot, "manifests", "checkpoint-after.json"), JSON.stringify({ files: [{ path: "a.txt", digest: afterHash }] }));
    await writeFile(join(root, ".flavor", "session-trees", "session-one", "tree.json"), JSON.stringify({ leafId: "turn-after", nodes: [
      { id: "turn-before", parentId: null, checkpointId: "checkpoint-before" },
      { id: "turn-after", parentId: "turn-before", checkpointId: "checkpoint-after" },
    ] }));
    expect(await desktopLastTurnDiff(root, "session-one")).toContain("-before\n+after");
  });
});
