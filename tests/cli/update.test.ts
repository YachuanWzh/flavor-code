import { afterEach, describe, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli.js";
import type { UpdateOutcome } from "../../src/update/apply.js";

async function runUpdateCommand(outcome: UpdateOutcome): Promise<{ stdout: string; stderr: string; exitCode: number | undefined }> {
  let stdout = "";
  let stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  process.exitCode = undefined;
  const runUpdate = vi.fn(async () => outcome);

  await createProgram({ runUpdate } as never).parseAsync(["node", "flavor", "update"]);

  return { stdout, stderr, exitCode: process.exitCode };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("flavor update command", () => {
  it("reports the version jump when the install succeeded", async () => {
    const { stdout, stderr, exitCode } = await runUpdateCommand({ status: "updated", current: "1.3.17", latest: "1.3.18" });

    expect(stdout).toContain("1.3.17");
    expect(stdout).toContain("1.3.18");
    expect(stderr).toBe("");
    expect(exitCode).toBeUndefined();
  });

  it("reports when already up to date", async () => {
    const { stdout, exitCode } = await runUpdateCommand({ status: "up-to-date", current: "1.3.17", latest: "1.3.17" });

    expect(stdout).toContain("up to date");
    expect(exitCode).toBeUndefined();
  });

  it("fails when the registry cannot be reached", async () => {
    const { stderr, exitCode } = await runUpdateCommand({ status: "check-failed", current: "1.3.17" });

    expect(stderr).toContain("update");
    expect(exitCode).toBe(1);
  });

  it("fails with the npm fallback hint when the install fails", async () => {
    const { stderr, exitCode } = await runUpdateCommand({ status: "install-failed", current: "1.0.0", latest: "2.0.0", exitCode: 1 });

    expect(stderr).toContain("npm i -g flavor-code");
    expect(exitCode).toBe(1);
  });
});
