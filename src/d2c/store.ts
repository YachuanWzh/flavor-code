import type { Buffer } from "node:buffer";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import type { D2cReport } from "./types.js";

export const D2C_TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const MAX_REPORT_JSON_BYTES = 2 * 1024 * 1024;

export interface D2cManifest {
  task: string;
  /** Relative path of the entry HTML inside the design copy. */
  entryHtml: string;
  /** All files of the design copy, relative paths with forward slashes. */
  files: string[];
  importedAt: string;
}

export interface D2cReportSummary {
  reportId: string;
  createdAt: string;
  total: number;
  grade: string;
}

export interface D2cReportArtifacts {
  designPng: Buffer;
  implementationPng: Buffer;
  heatmapPng: Buffer;
}

export interface D2cReportBundle {
  report: D2cReport;
  designPng: Buffer;
  implementationPng: Buffer;
  heatmapPng: Buffer;
}

function assertTask(task: string): void {
  if (!D2C_TASK_PATTERN.test(task)) {
    throw new Error(`Invalid D2C task name "${task}" (expected lowercase letters, digits and dashes)`);
  }
}

function d2cRoot(workspace: string): string {
  return join(workspace, ".flavor", "d2c");
}

export function taskDir(workspace: string, task: string): string {
  assertTask(task);
  return join(d2cRoot(workspace), task);
}

/** Absolute path of the imported entry HTML for a task. */
export function designEntryPath(workspace: string, task: string, manifest: D2cManifest): string {
  return join(taskDir(workspace, task), "design", manifest.entryHtml);
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Recursively lists regular files under a directory, rejecting symlinks. */
async function collectFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not allowed in D2C design exports: ${entry.name}`);
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        found.push(toPosix(relative(root, full)));
      }
    }
  };
  await walk(root);
  return found.sort();
}

/**
 * Imports a Pixso HTML export into `.flavor/d2c/<task>/design/`. A previous
 * import for the same task is fully replaced; stored reports are kept.
 */
export async function importDesign(workspace: string, task: string, exportDir: string): Promise<D2cManifest> {
  assertTask(task);
  let info;
  try {
    info = await lstat(exportDir);
  } catch {
    throw new Error(`D2C design export directory does not exist: ${exportDir}`);
  }
  if (info.isSymbolicLink()) {
    throw new Error("Symbolic links are not allowed as D2C design exports");
  }
  if (!info.isDirectory()) {
    throw new Error(`D2C design export path is not a directory: ${exportDir}`);
  }
  const files = await collectFiles(exportDir);
  const htmlFiles = files.filter((file) => file.toLowerCase().endsWith(".html"));
  const entryHtml = htmlFiles.find((file) => file.toLowerCase() === "index.html") ?? htmlFiles[0];
  if (entryHtml === undefined) {
    throw new Error(`D2C design export contains no HTML file: ${exportDir}`);
  }
  const designDir = join(taskDir(workspace, task), "design");
  await rm(designDir, { recursive: true, force: true });
  await mkdir(designDir, { recursive: true });
  for (const file of files) {
    const target = join(designDir, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(exportDir, file), target);
  }
  const manifest: D2cManifest = {
    task,
    entryHtml,
    files,
    importedAt: new Date().toISOString(),
  };
  await writeFile(join(taskDir(workspace, task), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export async function readManifest(workspace: string, task: string): Promise<D2cManifest> {
  const path = join(taskDir(workspace, task), "manifest.json");
  try {
    return JSON.parse(await readFile(path, "utf8")) as D2cManifest;
  } catch {
    throw new Error(`No D2C design imported for task "${task}"`);
  }
}

/** Lists tasks that have an imported design, sorted by name. */
export async function listTasks(workspace: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(d2cRoot(workspace), { withFileTypes: true });
  } catch {
    return [];
  }
  const tasks: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !D2C_TASK_PATTERN.test(entry.name)) continue;
    try {
      await stat(join(d2cRoot(workspace), entry.name, "manifest.json"));
      tasks.push(entry.name);
    } catch {
      // Directory without a manifest is not an imported task.
    }
  }
  return tasks.sort();
}

function reportDir(workspace: string, task: string, reportId: string): string {
  return join(taskDir(workspace, task), "reports", reportId);
}

/** Persists a comparison report with its PNG artifacts under `reports/<reportId>/`. */
export async function writeReport(
  workspace: string,
  task: string,
  report: D2cReport,
  artifacts: D2cReportArtifacts,
): Promise<void> {
  assertTask(task);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (new TextEncoder().encode(json).byteLength > MAX_REPORT_JSON_BYTES) {
    throw new Error("D2C report exceeds the supported size");
  }
  const dir = reportDir(workspace, task, report.reportId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, "report.json"), json),
    writeFile(join(dir, "design.png"), artifacts.designPng),
    writeFile(join(dir, "implementation.png"), artifacts.implementationPng),
    writeFile(join(dir, "heatmap.png"), artifacts.heatmapPng),
  ]);
}

/** Lists stored reports for a task, newest first. */
export async function listReports(workspace: string, task: string): Promise<D2cReportSummary[]> {
  assertTask(task);
  let entries;
  try {
    entries = await readdir(reportDir(workspace, task, ""), { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: D2cReportSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const report = JSON.parse(
        await readFile(join(reportDir(workspace, task, entry.name), "report.json"), "utf8"),
      ) as D2cReport;
      summaries.push({
        reportId: report.reportId,
        createdAt: report.createdAt,
        total: report.scores.total,
        grade: report.scores.grade,
      });
    } catch {
      // Skip incomplete report directories.
    }
  }
  return summaries.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.reportId.localeCompare(a.reportId));
}

/** Loads a report bundle; without a report id the newest one is returned. */
export async function readReport(workspace: string, task: string, reportId?: string): Promise<D2cReportBundle> {
  assertTask(task);
  let target = reportId;
  if (target === undefined) {
    const summaries = await listReports(workspace, task);
    const latest = summaries[0];
    if (latest === undefined) {
      throw new Error(`No D2C report found for task "${task}"`);
    }
    target = latest.reportId;
  }
  const dir = reportDir(workspace, task, target);
  let report: D2cReport;
  try {
    report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as D2cReport;
  } catch {
    throw new Error(`No D2C report "${target}" found for task "${task}"`);
  }
  const [designPng, implementationPng, heatmapPng] = await Promise.all([
    readFile(join(dir, "design.png")),
    readFile(join(dir, "implementation.png")),
    readFile(join(dir, "heatmap.png")),
  ]);
  return { report, designPng, implementationPng, heatmapPng };
}
