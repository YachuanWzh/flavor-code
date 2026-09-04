import { afterEach, expect, it, vi } from "vitest";

import { createProgram } from "../../src/cli.js";
import type { DoctorReport } from "../../src/doctor.js";

const healthyReport: DoctorReport = {
  version: "1.4.0",
  platform: "linux",
  arch: "x64",
  workspace: "/workspace",
  checks: [{ name: "runtime", status: "pass", message: "Node v24.0.0" }],
  summary: { passed: 1, warnings: 0, failed: 0 },
  ok: true,
};

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

it("prints a human-readable doctor report", async () => {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const doctor = vi.fn(async () => healthyReport);

  await createProgram({ runDoctor: doctor }).parseAsync(["node", "flavor", "doctor"]);

  expect(doctor).toHaveBeenCalledOnce();
  expect(stdout).toContain("Flavor Doctor v1.4.0");
  expect(process.exitCode).toBeUndefined();
});

it("prints JSON and exits non-zero when a doctor check fails", async () => {
  let stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  const failed = { ...healthyReport, ok: false, summary: { passed: 0, warnings: 0, failed: 1 } };

  await createProgram({ runDoctor: vi.fn(async () => failed) }).parseAsync(["node", "flavor", "doctor", "--json"]);

  expect(JSON.parse(stdout)).toMatchObject({ ok: false, summary: { failed: 1 } });
  expect(process.exitCode).toBe(1);
});
