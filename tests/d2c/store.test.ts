import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";

import { buildReport } from "../../src/d2c/report.js";
import {
  importDesign,
  listReports,
  listTasks,
  readManifest,
  readReport,
  writeReport,
} from "../../src/d2c/store.js";
import type { D2cElementSnapshot, D2cPageSnapshot } from "../../src/d2c/types.js";

const workspaces: string[] = [];
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-store-"));
  workspaces.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function exportDir(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "flavor-d2c-export-"));
  workspaces.push(base);
  for (const [name, content] of Object.entries(files)) {
    const target = join(base, name);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content);
  }
  return base;
}

function snapshot(elements: D2cElementSnapshot[] = []): D2cPageSnapshot {
  return { width: 100, height: 100, elements };
}

function pngBuffer(): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  return PNG.sync.write(image);
}

function sampleReport(task: string, reportId: string) {
  return buildReport({
    task,
    reportId,
    createdAt: new Date("2026-08-09T10:00:00Z"),
    design: { source: "design/index.html", snapshot: snapshot() },
    implementation: { source: "dist/index.html", snapshot: snapshot() },
    pixelMismatchRate: 0,
  });
}

describe("importDesign", () => {
  it("rejects invalid task names", async () => {
    const dir = await workspace();
    await expect(importDesign(dir, "Bad Name", ".")).rejects.toThrow(/task/i);
  });

  it("rejects export directories without any HTML file", async () => {
    const dir = await workspace();
    const source = await exportDir({ "notes.txt": "no html here" });
    await expect(importDesign(dir, "homepage", source)).rejects.toThrow(/html/i);
  });

  it("copies the export, prefers index.html as entry, and writes a manifest", async () => {
    const dir = await workspace();
    const source = await exportDir({
      "index.html": "<html></html>",
      "assets/logo.svg": "<svg/>",
      "other.html": "<html></html>",
    });
    const manifest = await importDesign(dir, "homepage", source);
    expect(manifest.entryHtml).toBe("index.html");
    expect(manifest.files).toContain("assets/logo.svg");
    const copied = await readFile(join(dir, ".flavor", "d2c", "homepage", "design", "index.html"), "utf8");
    expect(copied).toBe("<html></html>");
    const reread = await readManifest(dir, "homepage");
    expect(reread.entryHtml).toBe("index.html");
  });

  it("re-import overwrites the previous design copy", async () => {
    const dir = await workspace();
    const first = await exportDir({ "index.html": "<html>v1</html>", "old.css": "a{}" });
    await importDesign(dir, "homepage", first);
    const second = await exportDir({ "index.html": "<html>v2</html>" });
    await importDesign(dir, "homepage", second);
    const copied = await readFile(join(dir, ".flavor", "d2c", "homepage", "design", "index.html"), "utf8");
    expect(copied).toBe("<html>v2</html>");
    await expect(readFile(join(dir, ".flavor", "d2c", "homepage", "design", "old.css"), "utf8")).rejects.toThrow();
  });
});

describe("report storage", () => {
  it("writes report artifacts and lists them newest first", async () => {
    const dir = await workspace();
    const source = await exportDir({ "index.html": "<html></html>" });
    await importDesign(dir, "homepage", source);
    const artifacts = { designPng: pngBuffer(), implementationPng: pngBuffer(), heatmapPng: pngBuffer() };
    await writeReport(dir, "homepage", sampleReport("homepage", "run-20260809-100000"), artifacts);
    await writeReport(dir, "homepage", sampleReport("homepage", "run-20260809-110000"), artifacts);

    expect(await listTasks(dir)).toEqual(["homepage"]);
    const reports = await listReports(dir, "homepage");
    expect(reports.map((item) => item.reportId)).toEqual(["run-20260809-110000", "run-20260809-100000"]);
    expect(reports[0]).toMatchObject({ total: 100, grade: "像素级还原" });
  });

  it("loads the latest report with images when no id is given", async () => {
    const dir = await workspace();
    const source = await exportDir({ "index.html": "<html></html>" });
    await importDesign(dir, "homepage", source);
    const artifacts = { designPng: pngBuffer(), implementationPng: pngBuffer(), heatmapPng: pngBuffer() };
    await writeReport(dir, "homepage", sampleReport("homepage", "run-20260809-100000"), artifacts);
    const bundle = await readReport(dir, "homepage");
    expect(bundle.report.reportId).toBe("run-20260809-100000");
    expect(bundle.designPng.byteLength).toBeGreaterThan(8);
    expect(bundle.implementationPng.byteLength).toBeGreaterThan(8);
    expect(bundle.heatmapPng.byteLength).toBeGreaterThan(8);
  });

  it("rejects unknown tasks and report ids", async () => {
    const dir = await workspace();
    await expect(listReports(dir, "missing")).resolves.toEqual([]);
    await expect(readReport(dir, "missing")).rejects.toThrow(/no d2c report/i);
    const source = await exportDir({ "index.html": "<html></html>" });
    await importDesign(dir, "homepage", source);
    await expect(readReport(dir, "homepage", "run-19700101-000000")).rejects.toThrow(/no d2c report/i);
  });
});
