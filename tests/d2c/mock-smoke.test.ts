import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { generateIntegrationArtifacts } from "../../src/d2c/integration.js";
import { runD2cMockServer } from "../../src/d2c/mock-runner.js";

const enabled = process.env.FLAVOR_RUN_D2C_MOCK_SMOKE === "1";
const dirs: string[] = [];
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))));

describe.skipIf(!enabled)("D2C generated Express mock smoke", () => {
  it("installs, starts, serves a generated route and stops", async () => {
    const project = await mkdtemp(join(tmpdir(), "flavor-d2c-mock-smoke-")); dirs.push(project);
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "mock-smoke", private: true }));
    const operation = { id: "GET /metrics", method: "GET", path: "/metrics", operationId: "getMetrics", summary: "", tags: [], parameters: [], requestFields: [],
      responseFields: [{ name: "total", type: "integer", required: true, example: 12 }], responseSchema: { type: "object", properties: { total: { type: "integer", example: 12 } } }, statusCode: 200 };
    await generateIntegrationArtifacts(project, { version: "3.0.3", title: "Smoke", operations: [operation] }, [{
      moduleId: "stats", moduleLabel: "Stats", operationId: "getMetrics", operationKey: operation.id, confidence: 1, status: "auto", candidates: [], parameters: [], requestFields: [], responseFields: operation.responseFields,
    }]);
    const running = await runD2cMockServer(project, { readyTimeoutMs: 30_000 });
    try { await expect(fetch(`${running.url}/metrics`).then((response) => response.json())).resolves.toEqual({ total: 12 }); }
    finally { await running.stop(); }
  }, 240_000);
});
