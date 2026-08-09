import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { importDesign, listReports, readManifest } from "../../src/d2c/store.js";
import { comparePngs } from "../../src/d2c/pixel.js";
import { createD2cTools, type D2cToolOptions } from "../../src/d2c/tools.js";
import type { CapturedPage, D2cCaptureService, D2cCaptureSource } from "../../src/d2c/types.js";

const directories: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-tools-"));
  directories.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pngBuffer(fill = 255): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(fill);
  return PNG.sync.write(image);
}

function fakeCapture(log: D2cCaptureSource[] = []): D2cCaptureService {
  return {
    capture: async (source): Promise<CapturedPage> => {
      log.push(source);
      return {
        width: 2,
        height: 2,
        elements: [],
        screenshotPng: pngBuffer(),
        diagnostics: {
          devicePixelRatio: 1,
          fontsReady: true,
          imageCount: 0,
          failedImages: 0,
          naturalWidth: 2,
          naturalHeight: 2,
          clipped: false,
        },
      };
    },
  };
}

async function workspaceWithDesign(): Promise<string> {
  const workspace = await tempDir();
  const exportDir = await tempDir();
  await writeFile(join(exportDir, "index.html"), "<html></html>");
  await importDesign(workspace, "homepage", exportDir);
  return workspace;
}

function requireTool(workspace: string, name: "D2cImport" | "D2cCompare", options?: D2cToolOptions) {
  const tool = createD2cTools(workspace, options).find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`Tool not found: ${name}`);
  return tool;
}

describe("createD2cTools", () => {
  it("exposes D2cImport and D2cCompare", () => {
    const tools = createD2cTools("ws");
    expect(tools.map((tool) => tool.name)).toEqual(["D2cImport", "D2cCompare"]);
  });
});

describe("D2cImport", () => {
  it("imports the export without installing any skill", async () => {
    const workspace = await tempDir();
    const exportDir = await tempDir();
    await writeFile(join(exportDir, "index.html"), "<html></html>");
    const tool = requireTool(workspace, "D2cImport");
    const output = await tool.execute({ task: "homepage", exportDir }, new AbortController().signal) as Record<string, unknown>;
    expect(output.entryHtml).toBe("index.html");
    expect(output).not.toHaveProperty("skillInstalled");
    const manifest = await readManifest(workspace, "homepage");
    expect(manifest.entryHtml).toBe("index.html");
    const fs = await import("node:fs/promises");
    await expect(fs.access(join(workspace, ".flavor", "skills"))).rejects.toThrow();
  });
});

describe("D2cCompare", () => {
  async function compareTool(workspace: string, options?: Parameters<typeof createD2cTools>[1]) {
    return requireTool(workspace, "D2cCompare", {
      comparePixels: async (left, right) => comparePngs(left, right),
      ...options,
    });
  }

  it("requires viewport width and height together and caps total pixels", async () => {
    const workspace = await workspaceWithDesign();
    const tool = await compareTool(workspace, { capture: fakeCapture() });
    expect(tool.inputSchema.safeParse({ task: "homepage", implementation: "x.html", viewportWidth: 1280 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task: "homepage", implementation: "x.html", viewportWidth: 4096, viewportHeight: 4096 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ task: "homepage", implementation: "x.html", viewportWidth: 1280, viewportHeight: 800 }).success).toBe(true);
  });

  it("requires the desktop capture service", async () => {
    const workspace = await workspaceWithDesign();
    const tool = await compareTool(workspace);
    await expect(tool.execute({ task: "homepage", implementation: "dist/index.html" }, new AbortController().signal))
      .rejects.toThrow(/desktop/i);
  });

  it("rejects non-HTML implementation files", async () => {
    const workspace = await workspaceWithDesign();
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "page.txt"), "not html");
    const tool = await compareTool(workspace, { capture: fakeCapture() });
    await expect(tool.execute({ task: "homepage", implementation: "dist/page.txt" }, new AbortController().signal))
      .rejects.toThrow(/html/i);
  });

  it("rejects remote URLs that are not localhost", async () => {
    const workspace = await workspaceWithDesign();
    const tool = await compareTool(workspace, { capture: fakeCapture() });
    await expect(tool.execute({ task: "homepage", implementation: "https://example.com/" }, new AbortController().signal))
      .rejects.toThrow(/local/i);
  });

  it("compares, stores the report and notifies the listener", async () => {
    const workspace = await workspaceWithDesign();
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "index.html"), "<html></html>");
    const captured: D2cCaptureSource[] = [];
    const events: Array<{ task: string; reportId: string; total: number; grade: string }> = [];
    const tool = await compareTool(workspace, { capture: fakeCapture(captured), onReport: (event) => { events.push(event); } });
    const output = await tool.execute({ task: "homepage", implementation: "dist/index.html" }, new AbortController().signal) as {
      report: { scores: { total: number; grade: string }; reportId: string };
      summary: string;
    };
    expect(output.report.scores.total).toBe(100);
    expect(output.summary).toContain("D2C 对比完成");
    expect(captured.map((source) => source.kind)).toEqual(["file", "file"]);
    const reports = await listReports(workspace, "homepage");
    expect(reports).toHaveLength(1);
    expect(reports.map((item) => item.reportId)).toEqual([output.report.reportId]);
    expect(events).toEqual([{ task: "homepage", reportId: output.report.reportId, total: 100, grade: "像素级还原" }]);
  });

  it("compares every imported HTML page in one batch and keeps page evidence switchable", async () => {
    const workspace = await tempDir();
    const exportDir = await tempDir();
    await writeFile(join(exportDir, "index.html"), "<title>概览</title>");
    await writeFile(join(exportDir, "analytics.html"), "<title>分析</title>");
    await writeFile(join(exportDir, "settings.html"), "<title>设置</title>");
    await importDesign(workspace, "suite", exportDir);
    const projectDir = join(workspace, "app");
    await mkdir(projectDir);
    const captured: D2cCaptureSource[] = [];
    const notifications: unknown[] = [];
    const tool = await compareTool(workspace, {
      capture: fakeCapture(captured),
      runProject: async () => ({ url: "http://127.0.0.1:4173/", stop: async () => undefined }),
      onReport: (event) => { notifications.push(event); },
      now: () => new Date("2026-08-09T10:00:00Z"),
    });

    const output = await tool.execute({ task: "suite", implementation: "app" }, new AbortController().signal) as {
      report: { reportId: string };
      reports: Array<{ batchId: string; page: { id: string; label: string; html: string; index: number; count: number } }>;
    };
    expect(output.reports).toHaveLength(3);
    expect(new Set(output.reports.map((report) => report.batchId))).toHaveLength(1);
    expect(output.reports.map((report) => report.page.label)).toEqual(["概览", "分析", "设置"]);
    expect(captured.filter((source) => source.kind === "url")).toEqual([
      { kind: "url", url: "http://127.0.0.1:4173/" },
      { kind: "url", url: "http://127.0.0.1:4173/analytics.html" },
      { kind: "url", url: "http://127.0.0.1:4173/settings.html" },
    ]);
    const stored = await listReports(workspace, "suite");
    expect(stored).toHaveLength(3);
    expect(stored.map((item) => item.page?.id)).toEqual(["index", "analytics", "settings"]);
    expect(notifications).toEqual([expect.objectContaining({ task: "suite", reportId: output.report.reportId, pageCount: 3 })]);
  });

  it("does not publish a partial multi-page batch when a later route cannot render", async () => {
    const workspace = await tempDir();
    const exportDir = await tempDir();
    await writeFile(join(exportDir, "index.html"), "<title>Home</title>");
    await writeFile(join(exportDir, "broken.html"), "<title>Broken</title>");
    await importDesign(workspace, "suite", exportDir);
    const projectDir = join(workspace, "app");
    await mkdir(projectDir);
    const healthy = fakeCapture();
    let implementationCaptures = 0;
    const capture: D2cCaptureService = {
      capture: async (source, viewport, signal) => {
        if (source.kind === "url" && ++implementationCaptures === 2) {
          throw new Error('D2C implementation could not render: Vite compilation error\nFailed to resolve import "./styles.css"');
        }
        return healthy.capture(source, viewport, signal);
      },
    };
    const tool = await compareTool(workspace, {
      capture,
      runProject: async () => ({ url: "http://127.0.0.1:4173/", stop: async () => undefined }),
    });

    await expect(tool.execute({ task: "suite", implementation: "app" }, new AbortController().signal))
      .rejects.toThrow(/styles\.css/);
    expect(await listReports(workspace, "suite")).toEqual([]);
  });

  it("generates unique report ids within the same second", async () => {
    const workspace = await workspaceWithDesign();
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "index.html"), "<html></html>");
    const fixed = new Date("2026-08-09T10:00:00Z");
    const tool = await compareTool(workspace, { capture: fakeCapture(), now: () => fixed });
    const first = await tool.execute({ task: "homepage", implementation: "dist/index.html" }, new AbortController().signal) as { report: { reportId: string } };
    const second = await tool.execute({ task: "homepage", implementation: "dist/index.html" }, new AbortController().signal) as { report: { reportId: string } };
    expect(first.report.reportId).toBe("run-20260809-100000");
    expect(second.report.reportId).not.toBe(first.report.reportId);
    expect(await listReports(workspace, "homepage")).toHaveLength(2);
  });

  it("publishes concurrent reports without overwriting either result", async () => {
    const workspace = await workspaceWithDesign();
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "index.html"), "<html></html>");
    const fixed = new Date("2026-08-09T10:00:00Z");
    const firstTool = await compareTool(workspace, { capture: fakeCapture(), now: () => fixed });
    const secondTool = await compareTool(workspace, { capture: fakeCapture(), now: () => fixed });
    const signal = new AbortController().signal;
    const results = await Promise.all([
      firstTool.execute({ task: "homepage", implementation: "dist/index.html" }, signal),
      secondTool.execute({ task: "homepage", implementation: "dist/index.html" }, signal),
    ]) as Array<{ report: { reportId: string } }>;
    expect(new Set(results.map((item) => item.report.reportId)).size).toBe(2);
    expect(await listReports(workspace, "homepage")).toHaveLength(2);
  });

  it("reuses the immutable design snapshot across repair comparisons and emits real stages", async () => {
    const workspace = await workspaceWithDesign();
    await mkdir(join(workspace, "dist"), { recursive: true });
    await writeFile(join(workspace, "dist", "index.html"), "<html></html>");
    const captured: D2cCaptureSource[] = [];
    const progress: Array<{ stage: string; state: string; cached?: boolean; cycle: number }> = [];
    const tool = await compareTool(workspace, {
      capture: fakeCapture(captured),
      onProgress: (event) => { progress.push(event); },
    });
    const signal = new AbortController().signal;

    await tool.execute({ task: "homepage", implementation: "dist/index.html" }, signal);
    await tool.execute({ task: "homepage", implementation: "dist/index.html" }, signal);

    expect(captured.filter((source) => source.kind === "file" && source.path.includes(".flavor"))).toHaveLength(1);
    expect(captured.filter((source) => source.kind === "file" && source.path.includes("dist"))).toHaveLength(2);
    expect(progress).toContainEqual(expect.objectContaining({ stage: "capture-design", state: "completed", cached: true, cycle: 2 }));
    expect(progress).toContainEqual(expect.objectContaining({ stage: "pixel-diff", state: "running", cycle: 1 }));
    expect(progress).toContainEqual(expect.objectContaining({ stage: "report", state: "completed", cycle: 2 }));
  });

  it("honors cancellation before capture starts", async () => {
    const workspace = await workspaceWithDesign();
    const capture = fakeCapture();
    const tool = await compareTool(workspace, { capture });
    const controller = new AbortController();
    controller.abort(new Error("cancel comparison"));
    await expect(tool.execute({ task: "homepage", implementation: "unused.html" }, controller.signal))
      .rejects.toThrow(/cancel comparison/);
  });

  it("runs a frontend project directory via the injected runner and stops it", async () => {
    const workspace = await workspaceWithDesign();
    const projectDir = join(workspace, "vue-app");
    await mkdir(projectDir, { recursive: true });
    const runs: string[] = [];
    const stops: number[] = [];
    const captured: D2cCaptureSource[] = [];
    const tool = await compareTool(workspace, {
      capture: fakeCapture(captured),
      runProject: async (dir) => {
        runs.push(dir);
        return { url: "http://localhost:5173/", stop: async () => { stops.push(1); } };
      },
    });
    const output = await tool.execute({ task: "homepage", implementation: "vue-app" }, new AbortController().signal) as {
      report: { implementation: { source: string } };
    };
    expect(runs).toEqual([projectDir]);
    expect(stops).toEqual([1]);
    expect(captured.map((source) => source.kind)).toEqual(["file", "url"]);
    expect(captured[1]).toEqual({ kind: "url", url: "http://localhost:5173/" });
    expect(output.report.implementation.source).toBe("vue-app");
  });

  it("stops the runner even when the comparison fails", async () => {
    const workspace = await workspaceWithDesign();
    const projectDir = join(workspace, "react-app");
    await mkdir(projectDir, { recursive: true });
    const stops: number[] = [];
    const tool = await compareTool(workspace, {
      capture: {
        capture: async (): Promise<CapturedPage> => {
          throw new Error("capture exploded");
        },
      },
      runProject: async () => ({ url: "http://localhost:5173/", stop: async () => { stops.push(1); } }),
    });
    await expect(tool.execute({ task: "homepage", implementation: "react-app" }, new AbortController().signal))
      .rejects.toThrow(/capture exploded/);
    expect(stops).toEqual([1]);
  });

  it("rejects implementation paths that do not exist", async () => {
    const workspace = await workspaceWithDesign();
    const tool = await compareTool(workspace, { capture: fakeCapture() });
    await expect(tool.execute({ task: "homepage", implementation: "missing-dir" }, new AbortController().signal))
      .rejects.toThrow(/does not exist/i);
  });
});
