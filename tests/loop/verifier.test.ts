import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { inferVerificationPlan, runVerificationPlan } from "../../src/loop/verifier.js";

describe("loop verifier", () => {
  it("infers deterministic npm checks in stable priority order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-verifier-"));
    await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: {
      build: "tsc", lint: "eslint .", test: "vitest", typecheck: "tsc --noEmit", "smoke:install": "node smoke.js",
    } }));
    await writeFile(join(workspace, "FLAVOR.md"), [
      "## Build", "", "- `npm run build`", "", "## Test", "", "- `npm test`",
    ].join("\n"));

    await expect(inferVerificationPlan(workspace)).resolves.toEqual({
      commands: [
        { label: "test", command: "npm", args: ["test"] },
        { label: "typecheck", command: "npm", args: ["run", "typecheck"] },
        { label: "lint", command: "npm", args: ["run", "lint"] },
        { label: "build", command: "npm", args: ["run", "build"] },
        { label: "smoke:install", command: "npm", args: ["run", "smoke:install"] },
      ],
    });
  });

  it("returns a needs-human reason when no trusted verifier exists", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-verifier-empty-"));
    await expect(inferVerificationPlan(workspace)).resolves.toEqual({
      commands: [],
      needsHumanReason: "No deterministic verification command was found.",
    });
  });

  it("does not trust an obviously unconditional pass-through npm verifier", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-verifier-trivial-"));
    for (const script of ["node -e \"process.exit(0)\"", "echo ok", "exit 0", "true"]) {
      await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts: { test: script } }));
      await expect(inferVerificationPlan(workspace)).resolves.toEqual({
        commands: [],
        needsHumanReason: "No deterministic verification command was found.",
      });
    }
  });

  it("captures real output and stops after the first failed command", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-verifier-run-"));
    const plan = { commands: [
      { label: "pass", command: process.execPath, args: ["-e", "process.stdout.write('ok')"] },
      { label: "fail", command: process.execPath, args: ["-e", "process.stderr.write('bad');process.exit(3)"] },
      { label: "skip", command: process.execPath, args: ["-e", "process.stdout.write('never')"] },
    ] };

    const evidence = await runVerificationPlan(plan, workspace, new AbortController().signal);

    expect(evidence.passed).toBe(false);
    expect(evidence.commands).toHaveLength(2);
    expect(evidence.commands[0]).toMatchObject({ exitCode: 0, stdout: "ok" });
    expect(evidence.commands[1]).toMatchObject({ exitCode: 3, stderr: "bad" });
    expect(evidence.summary).toContain("fail failed");
  });

  it("propagates cancellation", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-verifier-cancel-"));
    const controller = new AbortController();
    controller.abort(new Error("stop verification"));
    await expect(runVerificationPlan({ commands: [
      { label: "wait", command: process.execPath, args: ["-e", "setTimeout(() => {}, 1000)"] },
    ] }, workspace, controller.signal)).rejects.toThrow("stop verification");
  });
});
