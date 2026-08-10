import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { buildReport } from "../../src/d2c/report.js";
import { importDesign, writeReport } from "../../src/d2c/store.js";
import { DesktopRuntimeController } from "../../src/desktop/runtime-controller.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function png(): Buffer { const image = new PNG({ width: 2, height: 2 }); image.data.fill(255); return PNG.sync.write(image); }

describe("desktop D2C workflow controller", () => {
  it("persists review, imports OpenAPI, confirms mappings and generates usable integration files", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-controller-")); dirs.push(workspace);
    const design = join(workspace, "pixso");
    await mkdir(design); await writeFile(join(design, "index.html"), "<html></html>");
    await writeFile(join(design, "interaction-manifest.json"), JSON.stringify({
      schemaVersion: 1, product: "dashboard", deterministic: true,
      pages: [{ url: "index.html", scenarios: [{ id: "loads-api-data", steps: [{ expect: "visible", selector: "#app" }] }] }],
    }));
    await importDesign(workspace, "dashboard", design);
    const report = buildReport({
      task: "dashboard", reportId: "run-20260810-010203", createdAt: new Date("2026-08-10T01:02:03Z"),
      design: { source: "design/index.html", snapshot: { width: 100, height: 100, elements: [{
        id: 1, tag: "div", text: "统计", rect: { x: 0, y: 0, width: 50, height: 20 }, styles: {}, hasImage: false,
      }] } },
      implementation: { source: "src/d2c-output/dashboard", snapshot: { width: 100, height: 100, elements: [{
        id: 1, tag: "div", text: "统计", rect: { x: 8, y: 0, width: 50, height: 20 }, styles: {}, hasImage: false,
        moduleId: "stats", moduleSourceFiles: ["src/Stats.jsx"],
      }] } }, pixelMismatchRate: .1,
    });
    await writeReport(workspace, "dashboard", report, { designPng: png(), implementationPng: png(), heatmapPng: png() });
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "package.json"), JSON.stringify({ name: "dashboard", scripts: { dev: "vite" }, dependencies: { react: "^19.0.0" } }));
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "stats", label: "统计", sourceFiles: ["src/Stats.jsx"], keywords: ["metrics"] }] }));
    const controller = new DesktopRuntimeController({
      home: workspace, listSessions: async () => [], loadModels: async () => [],
      loadMemoryManager: async () => ({ snapshot: async () => ({ enabled: false, path: join(workspace, ".flavor", "memory", "MEMORY.md"), entries: [] }), remember: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => false }),
      loadMcpManager: () => ({ path: "", list: async () => [], create: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => undefined, setEnabled: async () => { throw new Error("unused"); } }),
      runD2cMockServer: async () => ({ url: "http://127.0.0.1:4300", output: () => "ready", stop: async () => undefined }),
      runD2cPreview: async () => ({ url: "http://127.0.0.1:4400/", stop: async () => undefined }),
      runD2cInteractionTests: async (_manifest, baseUrl) => ({
        schema: 1, runAt: "2026-08-10T03:00:00.000Z", baseUrl, passed: true, total: 1, failures: 0, apiRequestCount: 1,
        scenarios: [{ id: "loads-api-data", pageUrl: baseUrl, passed: true, durationMs: 10, apiRequestCount: 1 }],
      }),
      emit: () => undefined,
    });
    await controller.openWorkspace(workspace);
    const view = await controller.getD2cReport("dashboard", report.reportId);
    expect(view.workflow.framework).toBe("react");
    const accepted = await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    expect(accepted.stage).toBe("api-mapping");

    const spec = join(workspace, "swagger.json");
    await writeFile(spec, JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Metrics", version: "1" },
      paths: {
        "/metrics": {
          get: {
            operationId: "getMetrics",
            tags: ["metrics"],
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object", properties: { total: { type: "integer" } } } } },
              },
            },
          },
        },
      },
    }));
    const imported = await controller.importD2cOpenApi("dashboard", spec);
    expect(imported.mappings[0]).toMatchObject({ moduleId: "stats", operationId: "getMetrics" });
    const selected = imported.mappings[0]!;
    if (selected.status === "needs-confirmation") await controller.confirmD2cMapping("dashboard", selected.moduleId, selected.operationKey);
    const generated = await controller.generateD2cIntegration("dashboard");
    expect(generated.prompt).toContain("Axios client");
    expect(generated.files).toContain("mock/server.mjs");
    expect(await readFile(join(project, "src", "api", "http.js"), "utf8")).toContain("axios.create");
    const preview = await controller.startD2cPreview("dashboard");
    expect(preview).toEqual({ running: true, url: "http://127.0.0.1:4400/", mockUrl: "http://127.0.0.1:4300" });
    await expect(controller.stopD2cMock("dashboard")).rejects.toThrow(/preview/i);
    const automated = await controller.runD2cInteractionTests("dashboard");
    expect(automated.workflow.stage).toBe("interaction-review");
    expect(automated.result?.apiRequestCount).toBe(1);
    const completed = await controller.setD2cManualAcceptance("dashboard", true);
    expect(completed.stage).toBe("completed");
    expect(JSON.parse(await readFile(join(workspace, ".flavor", "d2c", "dashboard", "integration", "interaction-results.json"), "utf8"))).toMatchObject({ passed: true });
    await controller.dispose();
  });
});
