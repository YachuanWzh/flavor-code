import type { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { D2cReport } from "./types.js";
import { assertPngDimensions } from "./pixel.js";

export const D2C_TASK_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const D2C_REPORT_PATTERN = /^run-\d{8}-\d{6}(?:-[2-9]\d*)?$/;

const MAX_REPORT_JSON_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_FILES = 5_000;
const MAX_IMPORT_BYTES = 256 * 1024 * 1024;
const importLocks = new Map<string, Promise<void>>();

export interface D2cManifest {
  task: string;
  /** Relative path of the entry HTML inside the design copy. */
  entryHtml: string;
  /** All files of the design copy, relative paths with forward slashes. */
  files: string[];
  importedAt: string;
  /** SHA-256 over sorted relative paths and copied file contents. */
  designHash: string;
}

const ManifestSchema = z.object({
  task: z.string().regex(D2C_TASK_PATTERN),
  entryHtml: z.string().min(1),
  files: z.array(z.string().min(1)).max(MAX_IMPORT_FILES),
  importedAt: z.iso.datetime(),
  designHash: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const ReportSchema = z.object({
  schema: z.literal(1),
  task: z.string().regex(D2C_TASK_PATTERN),
  reportId: z.string().regex(D2C_REPORT_PATTERN),
  createdAt: z.iso.datetime(),
  design: z.object({ source: z.string(), width: z.number(), height: z.number(), elementCount: z.number(), designHash: z.string().optional() }).passthrough(),
  implementation: z.object({ source: z.string(), width: z.number(), height: z.number(), elementCount: z.number() }).passthrough(),
  scores: z.object({ total: z.number(), grade: z.string() }).passthrough(),
  diffs: z.array(z.unknown()),
  missing: z.array(z.unknown()),
  extra: z.array(z.unknown()),
}).passthrough();

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
  const base = resolve(taskDir(workspace, task), "design");
  const target = resolve(base, manifest.entryHtml);
  const delta = relative(base, target);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new Error(`Invalid D2C design entry path: ${manifest.entryHtml}`);
  }
  return target;
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Recursively lists regular files under a directory, rejecting symlinks. */
async function collectFiles(root: string): Promise<{ files: string[]; totalBytes: number }> {
  const found: string[] = [];
  let totalBytes = 0;
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
        const info = await lstat(full);
        totalBytes += info.size;
        if (found.length + 1 > MAX_IMPORT_FILES || totalBytes > MAX_IMPORT_BYTES) {
          throw new Error("D2C design export exceeds the supported file count or total size");
        }
        found.push(toPosix(relative(root, full)));
      }
    }
  };
  await walk(root);
  return { files: found.sort(), totalBytes };
}

function pathIsInside(parent: string, child: string): boolean {
  const delta = relative(parent, child);
  return delta === "" || (!isAbsolute(delta) && delta !== ".." && !delta.startsWith(`..${sep}`));
}

async function hashFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    for await (const chunk of createReadStream(join(root, file))) hash.update(chunk as Buffer);
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch { return false; }
}

async function withImportLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = importLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => { release = resolvePromise; });
  const queued = previous.catch(() => undefined).then(() => gate);
  importLocks.set(key, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (importLocks.get(key) === queued) importLocks.delete(key);
  }
}

/**
 * Imports a Pixso HTML export into `.flavor/d2c/<task>/design/`. A previous
 * import for the same task is fully replaced; stored reports are kept.
 */
async function importDesignUnlocked(workspace: string, task: string, exportDir: string): Promise<D2cManifest> {
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
  const sourceReal = await realpath(exportDir);
  const designDir = resolve(taskDir(workspace, task), "design");
  if (pathIsInside(sourceReal, designDir) || pathIsInside(designDir, sourceReal)) {
    throw new Error("D2C design export overlaps the managed design directory");
  }
  const { files } = await collectFiles(sourceReal);
  const htmlFiles = files.filter((file) => file.toLowerCase().endsWith(".html"));
  const entryHtml = htmlFiles.find((file) => file.toLowerCase() === "index.html") ?? htmlFiles[0];
  if (entryHtml === undefined) {
    throw new Error(`D2C design export contains no HTML file: ${exportDir}`);
  }
  const root = taskDir(workspace, task);
  await mkdir(root, { recursive: true });
  const nonce = randomUUID();
  const stageDir = join(root, `.design-stage-${nonce}`);
  const backupDir = join(root, `.design-backup-${nonce}`);
  const manifestPath = join(root, "manifest.json");
  const manifestStage = join(root, `.manifest-stage-${nonce}.json`);
  const manifestBackup = join(root, `.manifest-backup-${nonce}.json`);
  await mkdir(stageDir);
  for (const file of files) {
    const target = join(stageDir, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceReal, file), target);
  }
  const designHash = await hashFiles(stageDir, files);
  const manifest: D2cManifest = {
    task,
    entryHtml,
    files,
    importedAt: new Date().toISOString(),
    designHash,
  };
  await writeFile(manifestStage, `${JSON.stringify(manifest, null, 2)}\n`);
  const hadDesign = await exists(designDir);
  const hadManifest = await exists(manifestPath);
  let published = false;
  try {
    if (hadDesign) await rename(designDir, backupDir);
    if (hadManifest) await rename(manifestPath, manifestBackup);
    await rename(stageDir, designDir);
    await rename(manifestStage, manifestPath);
    published = true;
  } catch (cause) {
    try {
      await rm(designDir, { recursive: true, force: true });
      await rm(manifestPath, { force: true });
      if (hadDesign && await exists(backupDir)) await rename(backupDir, designDir);
      if (hadManifest && await exists(manifestBackup)) await rename(manifestBackup, manifestPath);
    } catch (rollbackCause) {
      throw new AggregateError([cause, rollbackCause], "D2C import failed and could not fully restore the previous design");
    }
    throw cause;
  } finally {
    await Promise.all([
      rm(stageDir, { recursive: true, force: true }),
      rm(manifestStage, { force: true }),
    ]);
    if (published) {
      await Promise.allSettled([
        rm(backupDir, { recursive: true, force: true }),
        rm(manifestBackup, { force: true }),
      ]);
    }
  }
  return manifest;
}

export async function importDesign(workspace: string, task: string, exportDir: string): Promise<D2cManifest> {
  assertTask(task);
  return withImportLock(resolve(taskDir(workspace, task)), () => importDesignUnlocked(workspace, task, exportDir));
}

export async function readManifest(workspace: string, task: string): Promise<D2cManifest> {
  const path = join(taskDir(workspace, task), "manifest.json");
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Manifest symbolic links are not allowed");
    const parsed = ManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    for (const file of parsed.files) {
      const resolved = resolve(dirname(path), "design", file);
      if (!pathIsInside(resolve(dirname(path), "design"), resolved)) throw new Error("Invalid manifest file path");
    }
    const designHash = parsed.designHash ?? await hashFiles(resolve(dirname(path), "design"), parsed.files);
    const manifest: D2cManifest = { ...parsed, designHash };
    const entry = designEntryPath(workspace, task, manifest);
    const designRootReal = await realpath(resolve(dirname(path), "design"));
    const entryReal = await realpath(entry);
    if (!pathIsInside(designRootReal, entryReal)) throw new Error("Manifest entry escapes the design directory");
    return manifest;
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
  if (!D2C_REPORT_PATTERN.test(reportId)) throw new Error(`Invalid D2C report id: ${reportId}`);
  return join(taskDir(workspace, task), "reports", reportId);
}

function reportsDir(workspace: string, task: string): string {
  return join(taskDir(workspace, task), "reports");
}

export class D2cReportAlreadyExistsError extends Error {}

/** Persists a comparison report with its PNG artifacts under `reports/<reportId>/`. */
export async function writeReport(
  workspace: string,
  task: string,
  report: D2cReport,
  artifacts: D2cReportArtifacts,
): Promise<void> {
  assertTask(task);
  if (report.task !== task || !D2C_REPORT_PATTERN.test(report.reportId)) {
    throw new Error(`Invalid D2C report id: ${report.reportId}`);
  }
  ReportSchema.parse(report);
  assertPngDimensions(artifacts.designPng);
  assertPngDimensions(artifacts.implementationPng);
  assertPngDimensions(artifacts.heatmapPng);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (new TextEncoder().encode(json).byteLength > MAX_REPORT_JSON_BYTES) {
    throw new Error("D2C report exceeds the supported size");
  }
  const root = reportsDir(workspace, task);
  await mkdir(root, { recursive: true });
  const dir = reportDir(workspace, task, report.reportId);
  const stage = join(root, `.report-stage-${randomUUID()}`);
  await mkdir(stage);
  try {
    await Promise.all([
      writeFile(join(stage, "report.json"), json),
      writeFile(join(stage, "design.png"), artifacts.designPng),
      writeFile(join(stage, "implementation.png"), artifacts.implementationPng),
      writeFile(join(stage, "heatmap.png"), artifacts.heatmapPng),
    ]);
    try {
      await rename(stage, dir);
    } catch (cause) {
      if (await exists(dir)) throw new D2cReportAlreadyExistsError(`D2C report already exists: ${report.reportId}`);
      throw cause;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Lists stored reports for a task, newest first. */
export async function listReports(workspace: string, task: string): Promise<D2cReportSummary[]> {
  assertTask(task);
  let entries;
  try {
    entries = await readdir(reportsDir(workspace, task), { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: D2cReportSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !D2C_REPORT_PATTERN.test(entry.name)) continue;
    try {
      const reportPath = join(reportDir(workspace, task, entry.name), "report.json");
      if ((await stat(reportPath)).size > MAX_REPORT_JSON_BYTES) continue;
      const report = ReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8"))) as unknown as D2cReport;
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
  if (!D2C_REPORT_PATTERN.test(target)) throw new Error(`Invalid D2C report id: ${target}`);
  const dir = reportDir(workspace, task, target);
  let report: D2cReport;
  try {
    if ((await lstat(dir)).isSymbolicLink()) throw new Error("Report symbolic links are not allowed");
    const reportPath = join(dir, "report.json");
    if ((await stat(reportPath)).size > MAX_REPORT_JSON_BYTES) throw new Error("D2C report exceeds the supported size");
    report = ReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8"))) as unknown as D2cReport;
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
