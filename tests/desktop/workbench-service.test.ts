import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DesktopWorkbenchService } from "../../src/desktop/workbench-service.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("DesktopWorkbenchService", () => {
  it("returns bounded goals, workspace instructions, permission files and audit records", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-workbench-")); roots.push(root);
    await mkdir(join(root, ".flavor", "goals"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "Use TDD. token=top-secret", "utf8");
    await writeFile(join(root, ".flavor", "permissions.json"), '{"version":1,"rules":[],"api_key":"sk-sensitive"}', "utf8");
    await writeFile(join(root, ".flavor", "goals", "goal-one.json"), JSON.stringify({
      id: "goal-one", objective: "Ship it", phase: "verifying", status: "active", plan: null, planPath: null,
      verifyRounds: 2, workerRounds: 2, lastGaps: [], gapFingerprint: "", stallStreak: 0, contractHash: "a".repeat(64),
      evidenceRounds: [], createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T01:00:00.000Z",
    }), "utf8");
    await writeFile(join(root, ".flavor", "audit.jsonl"), `${JSON.stringify({ timestamp: "2026-08-25T01:00:00.000Z", tool: "Shell", outcome: "denied" })}\n`, "utf8");

    const result = await new DesktopWorkbenchService(root).inspect();

    expect(result.goals).toEqual([expect.objectContaining({ id: "goal-one", phase: "verifying" })]);
    expect(result.instructions).toEqual([expect.objectContaining({ name: "AGENTS.md", content: "Use TDD. token=[redacted]" })]);
    expect(result.permissionFiles).toEqual([expect.objectContaining({ tier: "project", content: expect.not.stringContaining("sk-sensitive") })]);
    expect(result.audit).toEqual([expect.objectContaining({ tool: "Shell" })]);
  });

  it("rejects non-loopback app preview URLs", () => {
    expect(DesktopWorkbenchService.normalizePreviewUrl("http://127.0.0.1:5173/app")).toBe("http://127.0.0.1:5173/app");
    expect(() => DesktopWorkbenchService.normalizePreviewUrl("https://example.com")).toThrow(/loopback/i);
    expect(() => DesktopWorkbenchService.normalizePreviewUrl("file:///etc/passwd")).toThrow(/loopback/i);
  });
});
