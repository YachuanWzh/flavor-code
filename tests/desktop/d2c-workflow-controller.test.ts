import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { buildReport } from "../../src/d2c/report.js";
import { importDesign, writeReport } from "../../src/d2c/store.js";
import { writeWorkflow } from "../../src/d2c/workflow.js";
import { DesktopRuntimeController, type DesktopRuntimeControllerOptions } from "../../src/desktop/runtime-controller.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function png(): Buffer { const image = new PNG({ width: 2, height: 2 }); image.data.fill(255); return PNG.sync.write(image); }

async function seedWorkspace(): Promise<{ workspace: string; report: ReturnType<typeof buildReport> }> {
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
  return { workspace, report };
}

function writeSpec(target: string): Promise<void> {
  return writeFile(target, JSON.stringify({
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
}

describe("desktop D2C workflow controller", () => {
  it("persists review, imports OpenAPI, confirms mappings and generates usable integration files", async () => {
    const { workspace, report } = await seedWorkspace();
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "stats", label: "统计", sourceFiles: ["src/Stats.jsx"], keywords: ["metrics"] }] }));
    const controller = new DesktopRuntimeController({
      home: workspace, listSessions: async () => [], loadModels: async () => [],
      loadMemoryManager: async () => ({ snapshot: async () => ({ enabled: false, path: join(workspace, ".flavor", "memory", "MEMORY.md"), entries: [] }), remember: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => false }),
      loadMcpManager: () => ({ path: "", list: async () => [], create: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => undefined, setEnabled: async () => { throw new Error("unused"); } }),
      runD2cMockServer: async () => ({ url: "http://127.0.0.1:4300", output: () => "ready", exited: () => false, stop: async () => undefined }),
      runD2cPreview: async () => ({ url: "http://127.0.0.1:4400/", stop: async () => undefined }),
      probeD2cMock: async () => true,
      runD2cInteractionTests: async (_manifest, baseUrl) => ({
        schema: 1, runAt: "2026-08-10T03:00:00.000Z", baseUrl, passed: true, total: 1, failures: 0, apiRequestCount: 1,
        scenarios: [{ id: "loads-api-data", pageUrl: baseUrl, passed: true, durationMs: 10, apiRequestCount: 1 }],
      }),
      captureD2cPreview: async () => png(),
      d2cJudge: {
        config: async () => ({ configured: true, protocol: "openai-compatible", baseURL: "https://judge.example.com/v1", model: "vision-pro", passThreshold: 80 }),
        saveConfig: async () => ({ configured: true, protocol: "openai-compatible", baseURL: "https://judge.example.com/v1", model: "vision-pro", passThreshold: 80 }),
        evaluate: async ({ report: current, interaction }) => ({
          schema: 1, runAt: "2026-08-10T03:10:00.000Z", model: "vision-pro", visualScore: 92, interactionScore: 90,
          staticVisualScore: current.scores.total, deterministicInteractionPassed: interaction.passed,
          overallScore: 91, threshold: 80, verdict: "pass", confidence: "high", summary: "质量门通过", strengths: [], issues: [],
        }),
      },
      emit: () => undefined,
    });
    await controller.openWorkspace(workspace);
    const view = await controller.getD2cReport("dashboard", report.reportId);
    expect(view.workflow.framework).toBe("react");
    const accepted = await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    expect(accepted.stage).toBe("api-mapping");

    const spec = join(workspace, "swagger.json");
    await writeSpec(spec);
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
    expect(completed.stage).toBe("quality-judge");
    const judged = await controller.runD2cQualityJudge("dashboard");
    expect(judged.workflow.stage).toBe("completed");
    expect(judged.judgment.overallScore).toBe(91);
    expect(JSON.parse(await readFile(join(workspace, ".flavor", "d2c", "dashboard", "quality-judge.json"), "utf8"))).toMatchObject({ verdict: "pass" });
    expect(JSON.parse(await readFile(join(workspace, ".flavor", "d2c", "dashboard", "integration", "interaction-results.json"), "utf8"))).toMatchObject({ passed: true });
    await controller.dispose();
  });

  it("rejects OpenAPI import when the implementation never wrote d2c.modules.json", async () => {
    const { workspace, report } = await seedWorkspace();
    const controller = createController({ home: workspace });
    await controller.openWorkspace(workspace);
    await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    const spec = join(workspace, "swagger.json");
    await writeSpec(spec);
    await expect(controller.importD2cOpenApi("dashboard", spec)).rejects.toThrow(/d2c\.modules\.json/);
    await controller.dispose();
  });

  it("refuses automated acceptance while no API binding is confirmed", async () => {
    const { workspace, report } = await seedWorkspace();
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "stats", label: "统计", sourceFiles: ["src/Stats.jsx"], keywords: ["unrelated"] }] }));
    const controller = createController({
      home: workspace,
      runD2cInteractionTests: async (_manifest, baseUrl) => ({
        schema: 1, runAt: "2026-08-10T03:00:00.000Z", baseUrl, passed: true, total: 1, failures: 0, apiRequestCount: 1,
        scenarios: [{ id: "loads-api-data", pageUrl: baseUrl, passed: true, durationMs: 10, apiRequestCount: 1 }],
      }),
    });
    await controller.openWorkspace(workspace);
    await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    const spec = join(workspace, "swagger.json");
    await writeSpec(spec);
    const imported = await controller.importD2cOpenApi("dashboard", spec);
    expect(imported.mappings[0]?.status).toBe("needs-confirmation");
    // Simulate an integration run that left every mapping unconfirmed.
    await writeWorkflow(workspace, { ...imported.workflow, revision: imported.workflow.revision + 1,
      stage: "integrating", integrationFiles: ["src/api/http.js"], updatedAt: new Date().toISOString() });
    await controller.startD2cPreview("dashboard");
    await expect(controller.runD2cInteractionTests("dashboard")).rejects.toThrow(/binding/i);
    await controller.dispose();
  });

  it("restarts a dead mock and the stale preview before running acceptance", async () => {
    const { workspace, report } = await seedWorkspace();
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "stats", label: "统计", sourceFiles: ["src/Stats.jsx"], keywords: ["metrics"] }] }));
    let mockGeneration = 0;
    const stoppedMocks: string[] = [];
    let previewStarts = 0;
    let probeHealthy = true;
    const observedMockUrls: string[] = [];
    const controller = createController({
      home: workspace,
      runD2cMockServer: async () => {
        mockGeneration += 1;
        const url = `http://127.0.0.1:${4300 + mockGeneration}`;
        return { url, output: () => "ready", exited: () => false, stop: async () => { stoppedMocks.push(url); } };
      },
      runD2cPreview: async () => {
        previewStarts += 1;
        return { url: `http://127.0.0.1:${4400 + previewStarts}/`, stop: async () => undefined };
      },
      probeD2cMock: async () => probeHealthy,
      runD2cInteractionTests: async (_manifest, baseUrl, mockUrl) => {
        observedMockUrls.push(mockUrl);
        return {
          schema: 1, runAt: "2026-08-10T03:00:00.000Z", baseUrl, passed: true, total: 1, failures: 0, apiRequestCount: 1,
          scenarios: [{ id: "loads-api-data", pageUrl: baseUrl, passed: true, durationMs: 10, apiRequestCount: 1 }],
        };
      },
    });
    await controller.openWorkspace(workspace);
    await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    const spec = join(workspace, "swagger.json");
    await writeSpec(spec);
    const imported = await controller.importD2cOpenApi("dashboard", spec);
    const selected = imported.mappings[0]!;
    if (selected.status === "needs-confirmation") await controller.confirmD2cMapping("dashboard", selected.moduleId, selected.operationKey);
    await controller.generateD2cIntegration("dashboard");
    const preview = await controller.startD2cPreview("dashboard");
    expect(preview.mockUrl).toBe("http://127.0.0.1:4301");
    expect(previewStarts).toBe(1);

    probeHealthy = false;
    const automated = await controller.runD2cInteractionTests("dashboard");
    expect(stoppedMocks).toEqual(["http://127.0.0.1:4301"]);
    expect(previewStarts).toBe(2);
    expect(observedMockUrls).toEqual(["http://127.0.0.1:4302"]);
    expect(automated.result?.baseUrl).toBe("http://127.0.0.1:4402/");
    expect(await readFile(join(project, ".env.local"), "utf8")).toContain("VITE_API_BASE_URL=http://127.0.0.1:4302");

    probeHealthy = true;
    await controller.runD2cInteractionTests("dashboard");
    expect(previewStarts).toBe(2);
    expect(observedMockUrls).toEqual(["http://127.0.0.1:4302", "http://127.0.0.1:4302"]);
    await controller.dispose();
  });

  it("annotates failures with the mock's final output when the mock dies during the run", async () => {
    const { workspace, report } = await seedWorkspace();
    const project = join(workspace, "src", "d2c-output", "dashboard");
    await writeFile(join(project, "d2c.modules.json"), JSON.stringify({ schema: 1, modules: [{ id: "stats", label: "统计", sourceFiles: ["src/Stats.jsx"], keywords: ["metrics"] }] }));
    let mockCrashed = false;
    const controller = createController({
      home: workspace,
      runD2cMockServer: async () => ({ url: "http://127.0.0.1:4300", output: () => "Error: listen EADDRINUSE", exited: () => mockCrashed, stop: async () => undefined }),
      runD2cInteractionTests: async (_manifest, baseUrl) => ({
        schema: 1, runAt: "2026-08-10T03:00:00.000Z", baseUrl, passed: false, total: 1, failures: 1, apiRequestCount: 0,
        scenarios: [{ id: "loads-api-data", pageUrl: baseUrl, passed: false, durationMs: 10, apiRequestCount: 0,
          failure: "No API request was observed; the page is still behaving as a static implementation" }],
      }),
    });
    await controller.openWorkspace(workspace);
    await controller.updateD2cReview("dashboard", report.reportId, [report.diffs[0]!.fingerprint], "accepted");
    const spec = join(workspace, "swagger.json");
    await writeSpec(spec);
    const imported = await controller.importD2cOpenApi("dashboard", spec);
    const selected = imported.mappings[0]!;
    if (selected.status === "needs-confirmation") await controller.confirmD2cMapping("dashboard", selected.moduleId, selected.operationKey);
    await controller.generateD2cIntegration("dashboard");
    await controller.startD2cPreview("dashboard");

    // Healthy mock: failures pass through untouched.
    const plain = await controller.runD2cInteractionTests("dashboard");
    expect(plain.result?.scenarios[0]?.failure).not.toMatch(/exited/i);

    // The mock crashes mid-run: every failure is annotated and its output persisted.
    mockCrashed = true;
    const annotated = await controller.runD2cInteractionTests("dashboard");
    expect(annotated.result?.scenarios[0]?.failure).toMatch(/EADDRINUSE/);
    expect(await readFile(join(project, "mock-server.log"), "utf8")).toContain("EADDRINUSE");
    await controller.dispose();
  });
});

function createController(overrides: Partial<DesktopRuntimeControllerOptions> & { home: string }): DesktopRuntimeController {
  const workspace = overrides.home;
  return new DesktopRuntimeController({
    listSessions: async () => [], loadModels: async () => [],
    loadMemoryManager: async () => ({ snapshot: async () => ({ enabled: false, path: join(workspace, ".flavor", "memory", "MEMORY.md"), entries: [] }), remember: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => false }),
    loadMcpManager: () => ({ path: "", list: async () => [], create: async () => { throw new Error("unused"); }, update: async () => { throw new Error("unused"); }, delete: async () => undefined, setEnabled: async () => { throw new Error("unused"); } }),
    runD2cMockServer: async () => ({ url: "http://127.0.0.1:4300", output: () => "ready", exited: () => false, stop: async () => undefined }),
    runD2cPreview: async () => ({ url: "http://127.0.0.1:4400/", stop: async () => undefined }),
    probeD2cMock: async () => true,
    emit: () => undefined,
    ...overrides,
  });
}
