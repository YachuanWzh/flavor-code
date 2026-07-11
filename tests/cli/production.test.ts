import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createProductionRuntime } from "../../src/production.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("production runtime", () => {
  it("starts without credentials and returns actionable model setup output", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const output: string[] = [];
    const runtime = await createProductionRuntime({
      workspace, home: workspace, environment: {},
      output: (event) => { if (event.type === "error") output.push(event.error.message); },
    });
    await runtime.session.start();
    await runtime.session.submit("hello");
    await runtime.session.close();
    await runtime.dispose();
    expect(output.join("\n")).toContain(".flavor/flavor.json");
  });

  it("approval bridge waits for and resolves a UI decision", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-production-")); roots.push(workspace);
    const runtime = await createProductionRuntime({ workspace, home: workspace, environment: {}, output: () => {} });
    const pending = runtime.approvals.request({ agent: "main", tool: "Write", paths: [workspace] });
    expect(runtime.approvals.pending?.tool).toBe("Write");
    runtime.approvals.resolve(true);
    await expect(pending).resolves.toBe(true);
    await runtime.dispose();
  });
});
