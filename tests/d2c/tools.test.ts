import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { importDesign, listReports, readManifest } from "../../src/d2c/store.js";
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
      return { width: 2, height: 2, elements: [], screenshotPng: pngBuffer() };
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
  it("imports the export and installs the D2C skill", async () => {
    const workspace = await tempDir();
    const exportDir = await tempDir();
    await writeFile(join(exportDir, "index.html"), "<html></html>");
    const tool = requireTool(workspace, "D2cImport");
    const output = await tool.execute({ task: "homepage", exportDir }, new AbortController().signal) as Record<string, unknown>;
    expect(output.entryHtml).toBe("index.html");
    const manifest = await readManifest(workspace, "homepage");
    expect(manifest.entryHtml).toBe("index.html");
    const skill = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(workspace, ".flavor", "skills", "d2c-pixso", "SKILL.md"), "utf8"));
    expect(skill).toContain("D2cImport");
  });
});

describe("D2cCompare", () => {
  async function compareTool(workspace: string, options?: Parameters<typeof createD2cTools>[1]) {
    return requireTool(workspace, "D2cCompare", options);
  }

  it("requires the desktop capture service", async () => {
    const workspace = await workspaceWithDesign();
    const tool = await compareTool(workspace);
    await expect(tool.execute({ task: "homepage", implementation: "dist/index.html" }, new AbortController().signal))
      .rejects.toThrow(/desktop/i);
  });

  it("rejects non-HTML implementation files", async () => {
    const workspace = await workspaceWithDesign();
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
});
