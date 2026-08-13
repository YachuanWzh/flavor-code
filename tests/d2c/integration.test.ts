import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { generateIntegrationArtifacts, sampleForSchema } from "../../src/d2c/integration.js";
import type { D2cApiMapping, D2cOpenApiDocument } from "../../src/d2c/openapi.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

const document: D2cOpenApiDocument = { version: "3.0.3", title: "Demo", baseUrl: "http://api.example.com", operations: [{
  id: "GET /metrics", method: "GET", path: "/metrics", operationId: "getMetrics", summary: "Metrics", tags: ["dashboard"],
  parameters: [], requestFields: [], responseFields: [{ name: "total", type: "integer", required: true, example: 12 }],
  responseSchema: { type: "object", properties: { total: { type: "integer", example: 12 } } }, statusCode: 200,
}] };
const mappings: D2cApiMapping[] = [{ moduleId: "stats", moduleLabel: "统计", operationId: "getMetrics", operationKey: "GET /metrics",
  confidence: .9, status: "auto", candidates: [{ operationId: "getMetrics", operationKey: "GET /metrics", score: .9 }],
  parameters: [], requestFields: [], responseFields: document.operations[0]!.responseFields }];

describe("D2C integration generation", () => {
  it("creates deterministic schema samples", () => {
    expect(sampleForSchema({ type: "object", properties: { enabled: { type: "boolean" }, role: { type: "string", enum: ["admin"] } } }))
      .toEqual({ enabled: true, role: "admin" });
    expect(sampleForSchema({ type: "array", items: { type: "integer" } })).toEqual([1]);
  });

  it("writes Axios clients, bindings and an Express mock without erasing existing package data", async () => {
    const project = await mkdtemp(join(tmpdir(), "flavor-d2c-integration-")); dirs.push(project);
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "demo", scripts: { dev: "vite" }, dependencies: { vue: "^3.0.0" } }, null, 2));
    const result = await generateIntegrationArtifacts(project, document, mappings);
    expect(result.files).toContain("src/api/http.js");
    expect(await readFile(join(project, "src", "api", "http.js"), "utf8")).toContain("axios.create");
    expect(await readFile(join(project, "src", "api", "d2c-api.js"), "utf8")).toContain("getMetrics");
    expect(await readFile(join(project, "mock", "server.mjs"), "utf8")).toContain("express");
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    expect(pkg.scripts).toMatchObject({ dev: "vite", mock: "node mock/server.mjs" });
    expect(pkg.dependencies).toMatchObject({ vue: "^3.0.0", axios: expect.any(String), express: expect.any(String) });
  });

  it("adds a FastAPI service artifact for requirement-origin Python deliveries", async () => {
    const project = await mkdtemp(join(tmpdir(), "flavor-d2c-integration-")); dirs.push(project);
    await writeFile(join(project, "package.json"), "{}");
    const result = await generateIntegrationArtifacts(project, document, mappings, { pythonServer: true });
    expect(result.files).toContain("server/main.py");
    const server = await readFile(join(project, "server", "main.py"), "utf8");
    expect(server).toContain("FastAPI");
    expect(server).toContain('os.getenv("DATABASE_URL", "sqlite:///./data/app.db")');
    expect(server).toContain("create_engine");
    expect(server).toContain('app.post("/_e2e/reset")');
    expect(server).toContain('os.getenv("FLAVOR_E2E_ALLOW_RESET")');
    expect(await readFile(join(project, "server", "requirements.txt"), "utf8")).toContain("sqlalchemy");
    expect(result.files).not.toContain("mock/server.mjs");
    const pkg = JSON.parse(await readFile(join(project, "package.json"), "utf8"));
    expect(pkg.scripts?.mock).toBeUndefined();
    expect(pkg.dependencies?.express).toBeUndefined();
    expect(JSON.parse(await readFile(join(project, "server", "flavor-runtime.json"), "utf8")))
      .toMatchObject({ kind: "python-fastapi", developmentDatabaseUrl: "sqlite:///./data/app.db", portableDatabaseLayer: "SQLAlchemy" });
  });

  it("refuses unresolved mappings and paths without package.json", async () => {
    const project = await mkdtemp(join(tmpdir(), "flavor-d2c-integration-")); dirs.push(project);
    await expect(generateIntegrationArtifacts(project, document, mappings)).rejects.toThrow(/package\.json/i);
    await writeFile(join(project, "package.json"), "{}");
    await expect(generateIntegrationArtifacts(project, document, [{ ...mappings[0]!, status: "needs-confirmation" }]))
      .rejects.toThrow(/confirm/i);
  });

  it("generates unique client exports when an invalid spec repeats operationId values", async () => {
    const project = await mkdtemp(join(tmpdir(), "flavor-d2c-integration-")); dirs.push(project);
    await writeFile(join(project, "package.json"), "{}");
    const duplicate = { ...document, operations: [document.operations[0]!, {
      ...document.operations[0]!, id: "GET /metrics/detail", path: "/metrics/detail",
    }] };
    await generateIntegrationArtifacts(project, duplicate, [mappings[0]!, {
      ...mappings[0]!, moduleId: "detail", operationKey: "GET /metrics/detail",
    }]);
    const api = await readFile(join(project, "src", "api", "d2c-api.js"), "utf8");
    const exports = [...api.matchAll(/export async function\s+(\w+)/g)].map((match) => match[1]);
    expect(exports).toHaveLength(2);
    expect(new Set(exports).size).toBe(2);
  });
});
