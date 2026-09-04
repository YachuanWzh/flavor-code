import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, it, vi } from "vitest";

import { FlavorConfigSchema } from "../src/config/schema.js";
import { formatDoctorReport, runDoctor } from "../src/doctor.js";

it("reports a healthy local installation without exposing credential values", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-doctor-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const rg = join(root, "rg");
  const plugin = join(workspace, ".flavor", "plugins", "sample");
  await mkdir(plugin, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(rg, "binary");
  await writeFile(join(plugin, "index.js"), "export default function activate() {}\n");
  await writeFile(join(plugin, "flavor-plugin.json"), JSON.stringify({
    name: "sample", version: "1.0.0", apiVersion: "1", main: "index.js", permissions: [],
    contributes: { commands: [], tools: [], hooks: [], skillRoots: [], modelAdapters: [] },
  }));

  const report = await runDoctor({
    workspace, home, environment: { OPENAI_API_KEY: "top-secret" },
    platform: "linux", arch: "x64", nodeVersion: "v24.0.0",
  }, {
    rgPath: rg,
    probeShell: vi.fn(async () => "/bin/sh"),
    fetchLatestVersion: vi.fn(async () => "1.4.0"),
    loadConfig: vi.fn(async () => ({ config: FlavorConfigSchema.parse({}), sources: [] })),
  });

  expect(report.ok).toBe(true);
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "providers", status: "pass" }),
    expect.objectContaining({ name: "plugins", status: "pass", message: "1 manifest valid" }),
  ]));
  const formatted = formatDoctorReport(report);
  expect(formatted).toContain("Flavor Doctor");
  expect(formatted).toContain("0 failed");
  expect(formatted).not.toContain("top-secret");
});

it("fails for an unsupported runtime or invalid configuration but treats offline npm as a warning", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-doctor-fail-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const rg = join(root, "rg");
  await mkdir(workspace);
  await mkdir(home);
  await writeFile(rg, "binary");

  const report = await runDoctor({ workspace, home, environment: {}, nodeVersion: "v18.0.0" }, {
    rgPath: rg,
    probeShell: vi.fn(async () => "test-shell"),
    fetchLatestVersion: vi.fn(async () => undefined),
    loadConfig: vi.fn(async () => { throw new Error("invalid flavor.json"); }),
  });

  expect(report.ok).toBe(false);
  expect(report.checks).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "runtime", status: "fail" }),
    expect.objectContaining({ name: "configuration", status: "fail" }),
    expect.objectContaining({ name: "npm registry", status: "warn" }),
  ]));
});
