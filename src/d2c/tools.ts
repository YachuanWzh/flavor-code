import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import { D2C_MAX_PIXELS, type D2cPixelComparison } from "./pixel.js";
import { comparePngsInWorker } from "./pixel-worker-client.js";
import { buildReport, summarizeReport } from "./report.js";
import { runFrontendProject, type RunningProject } from "./runner.js";
import { D2cReportAlreadyExistsError, D2C_TASK_PATTERN, designEntryPath, designPagePath, importDesign, listReports, readManifest, writeReport, type D2cDesignPage } from "./store.js";
import type { CapturedPage, D2cCaptureService, D2cCaptureSource, D2cProgressEvent, D2cProgressStage, D2cReport } from "./types.js";

export interface D2cReportEvent {
  task: string;
  reportId: string;
  total: number;
  grade: string;
  pageCount?: number;
}

export interface D2cToolOptions {
  /** Rendering backend; only the desktop app provides one. */
  capture?: D2cCaptureService;
  /** Invoked after each stored comparison report. */
  onReport?: (event: D2cReportEvent) => void | Promise<void>;
  /** Emits real comparison stages for the Electron D2C execution view. */
  onProgress?: (event: D2cProgressEvent) => void | Promise<void>;
  /** Injectable clock, used for report ids. */
  now?: () => Date;
  /** Launches a frontend project directory; defaults to the Vite runner. */
  runProject?: (projectDir: string, signal?: AbortSignal) => Promise<RunningProject>;
  /** Injectable pixel worker seam for tests. */
  comparePixels?: (left: Buffer, right: Buffer, signal?: AbortSignal) => Promise<D2cPixelComparison>;
}

const taskSchema = z.string().regex(D2C_TASK_PATTERN, "Task name must be lowercase letters, digits and dashes");

const D2cImportInput = z.object({
  task: taskSchema,
  exportDir: z.string().trim().min(1),
});

const D2cCompareInput = z.object({
  task: taskSchema,
  implementation: z.string().trim().min(1),
  viewportWidth: z.coerce.number().int().positive().max(4096).optional(),
  viewportHeight: z.coerce.number().int().positive().max(4096).optional(),
}).refine(
  (value) => (value.viewportWidth === undefined) === (value.viewportHeight === undefined),
  { message: "viewportWidth and viewportHeight must be provided together" },
).refine(
  (value) => value.viewportWidth === undefined || value.viewportHeight === undefined
    || value.viewportWidth * value.viewportHeight <= D2C_MAX_PIXELS,
  { message: "viewport exceeds the supported pixel limit" },
);

type D2cImportInput = z.infer<typeof D2cImportInput>;
type D2cCompareInput = z.infer<typeof D2cCompareInput>;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type D2cImplementationSource = D2cCaptureSource | { kind: "project"; path: string };

function assertInsideWorkspace(workspace: string, resolved: string, original: string): void {
  const delta = relative(workspace, resolved);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) {
    throw new Error(`D2C implementation source must be inside the workspace: ${original}`);
  }
}

async function resolveImplementationSource(workspace: string, implementation: string): Promise<D2cImplementationSource> {
  if (/^https?:\/\//i.test(implementation)) {
    let url: URL;
    try {
      url = new URL(implementation);
    } catch {
      throw new Error(`Invalid D2C implementation URL: ${implementation}`);
    }
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new Error(`D2C comparison only supports localhost URLs, got: ${implementation}`);
    }
    return { kind: "url", url: implementation };
  }
  const workspaceReal = await realpath(resolve(workspace));
  const candidate = isAbsolute(implementation) ? resolve(implementation) : resolve(workspace, implementation);
  const resolved = await realpath(candidate).catch(() => undefined);
  if (resolved === undefined) throw new Error(`D2C implementation source does not exist: ${implementation}`);
  assertInsideWorkspace(workspaceReal, resolved, implementation);
  const info = await stat(resolved).catch(() => undefined);
  if (info?.isDirectory()) {
    return { kind: "project", path: resolved };
  }
  if (implementation.toLowerCase().endsWith(".html")) {
    if (info === undefined || !info.isFile()) {
      throw new Error(`D2C implementation file does not exist: ${implementation}`);
    }
    return { kind: "file", path: resolved };
  }
  if (info === undefined) throw new Error(`D2C implementation source does not exist: ${implementation}`);
  throw new Error(
    `D2C implementation source must be a frontend project directory, an .html file or a localhost URL: ${implementation}`,
  );
}

function implementationPageSource(
  source: D2cCaptureSource,
  page: D2cDesignPage,
  entryHtml: string,
): D2cCaptureSource {
  if (page.html === entryHtml) return source;
  if (source.kind === "file") {
    throw new Error("Multi-page D2C comparison requires a Vite project directory or localhost URL");
  }
  const base = source.url.endsWith("/") ? source.url : `${source.url}/`;
  return { kind: "url", url: new URL(page.html, base).toString() };
}

function formatRunId(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `run-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Creates the D2C import and comparison tools bound to a workspace. */
export function createD2cTools(workspace: string, options: D2cToolOptions = {}): ToolDefinition<unknown>[] {
  const designSnapshotCache = new Map<string, CapturedPage>();
  let comparisonCycle = 0;
  const importTool: ToolDefinition<D2cImportInput> = {
    name: "D2cImport",
    description:
      "Import a Pixso HTML design export for D2C (design-to-code) comparison. Copies the export directory into .flavor/d2c/<task>/design/. The task name must be lowercase letters, digits and dashes.",
    inputSchema: D2cImportInput,
    paths: (input) => [resolve(workspace, input.exportDir), resolve(workspace, ".flavor", "d2c", input.task)],
    summarize: (input) => `${input.task} ← ${input.exportDir}`,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const manifest = await importDesign(workspace, input.task, resolve(workspace, input.exportDir));
      return {
        task: input.task,
        entryHtml: manifest.entryHtml,
        pages: manifest.pages,
        files: manifest.files,
        designDir: join(".flavor", "d2c", input.task, "design"),
      };
    },
  };

  const compareTool: ToolDefinition<D2cCompareInput> = {
    name: "D2cCompare",
    description:
      "Compare an imported Pixso design against the rendered implementation and score visual fidelity. The implementation is a frontend project directory (Vue or React, Vite-based; dependencies are installed and the dev server is started and stopped automatically), a localhost URL of an already running server, or a workspace-relative .html file. Returns a similarity score plus structured offsets, color deviations, font mismatches and missing or extra elements, and stores the report with screenshots under .flavor/d2c/<task>/reports/. Requires the desktop app for rendering.",
    inputSchema: D2cCompareInput,
    paths: (input) => [resolve(workspace, ".flavor", "d2c", input.task), ...(/^https?:\/\//iu.test(input.implementation) ? [] : [resolve(workspace, input.implementation)])],
    summarize: (input) => input.task,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const { capture, onProgress, onReport, now } = options;
      if (capture === undefined) {
        throw new Error("D2C comparison requires the desktop app; the capture service is not available in this session");
      }
      const cycle = ++comparisonCycle;
      const progress = async (
        stage: D2cProgressStage,
        state: D2cProgressEvent["state"],
        message: string,
        cached = false,
      ): Promise<void> => {
        await onProgress?.({ task: input.task, cycle, stage, state, message, ...(cached ? { cached: true } : {}) });
      };
      await progress("prepare", "running", "正在检查设计稿与实现入口");
      const manifest = await readManifest(workspace, input.task);
      const designPath = designEntryPath(workspace, input.task, manifest);
      const resolvedSource = await resolveImplementationSource(workspace, input.implementation);
      await progress("prepare", "completed", "设计稿与实现入口已确认");
      let running: RunningProject | undefined;
      let source: D2cCaptureSource;
      if (resolvedSource.kind === "project") {
        const runProject = options.runProject
          ?? ((projectDir: string, runSignal?: AbortSignal) => runFrontendProject(projectDir, {
            workspace,
            ...(runSignal === undefined ? {} : { signal: runSignal }),
            onProgress: (event) => progress(event.stage, event.state, event.message, event.cached === true),
          }));
        running = await runProject(resolvedSource.path, signal);
        source = { kind: "url", url: running.url };
      } else {
        source = resolvedSource;
      }
      const viewport = input.viewportWidth !== undefined && input.viewportHeight !== undefined
        ? { width: input.viewportWidth, height: input.viewportHeight }
        : undefined;
      try {
        if (manifest.pages.length > 1) {
          const comparePixels = options.comparePixels ?? comparePngsInWorker;
          const createdAt = (now ?? (() => new Date()))();
          const batchId = `${formatRunId(createdAt)}-${randomUUID().slice(0, 8)}`;
          const existing = new Set((await listReports(workspace, input.task)).map((item) => item.reportId));
          const reports: D2cReport[] = [];
          const stagedPages: Array<{
            index: number;
            page: D2cDesignPage;
            pageSource: D2cCaptureSource;
            designSnapshot: CapturedPage;
            implSnapshot: CapturedPage;
            pixel: D2cPixelComparison;
          }> = [];
          let reportSuffix = 1;
          const nextReportId = (): string => {
            const base = formatRunId(createdAt);
            while (true) {
              const candidate = reportSuffix === 1 ? base : `${base}-${reportSuffix}`;
              reportSuffix += 1;
              if (!existing.has(candidate)) { existing.add(candidate); return candidate; }
            }
          };

          await progress("report", "running", `准备生成 ${manifest.pages.length} 个页面的评测报告`);
          for (const [index, page] of manifest.pages.entries()) {
            signal.throwIfAborted();
            const pageContext = `页面 ${index + 1}/${manifest.pages.length} · ${page.label}`;
            const viewportKey = viewport === undefined ? "natural" : `${viewport.width}x${viewport.height}`;
            const designCacheKey = `${input.task}:${manifest.designHash}:${page.html}:${viewportKey}`;
            let designSnapshot = designSnapshotCache.get(designCacheKey);
            if (designSnapshot === undefined) {
              await progress("capture-design", "running", `${pageContext} · 正在渲染设计稿`);
              try {
                designSnapshot = await capture.capture(
                  { kind: "file", path: designPagePath(workspace, input.task, page.html) },
                  viewport,
                  signal,
                );
              } catch (error) {
                await progress("capture-design", "failed", `${pageContext} · 设计稿渲染失败`);
                throw error;
              }
              designSnapshotCache.set(designCacheKey, designSnapshot);
              while (designSnapshotCache.size > 24) designSnapshotCache.delete(designSnapshotCache.keys().next().value!);
              await progress("capture-design", "completed", `${pageContext} · 设计稿已就绪`);
            } else {
              await progress("capture-design", "completed", `${pageContext} · 复用设计稿快照`, true);
            }

            const pageSource = implementationPageSource(source, page, manifest.entryHtml);
            const implViewport = viewport ?? { width: designSnapshot.width, height: designSnapshot.height };
            await progress("capture-implementation", "running", `${pageContext} · 正在渲染实现`);
            let implSnapshot: CapturedPage;
            try {
              implSnapshot = await capture.capture(pageSource, implViewport, signal);
            } catch (error) {
              await progress("capture-implementation", "failed", `${pageContext} · 实现渲染失败`);
              throw error;
            }
            await progress("capture-implementation", "completed", `${pageContext} · 实现已就绪`);
            await progress("pixel-diff", "running", `${pageContext} · 正在计算差异`);
            let pixel: D2cPixelComparison;
            try {
              pixel = await comparePixels(designSnapshot.screenshotPng, implSnapshot.screenshotPng, signal);
            } catch (error) {
              await progress("pixel-diff", "failed", `${pageContext} · 像素对比失败`);
              throw error;
            }
            await progress("pixel-diff", "completed", `${pageContext} · 差异已计算`);
            stagedPages.push({ index, page, pageSource, designSnapshot, implSnapshot, pixel });
          }

          // Do not publish a partial batch: every route must render and compare
          // successfully before the first report becomes visible in the UI.
          for (const staged of stagedPages) {
            const pageContext = `页面 ${staged.index + 1}/${manifest.pages.length} · ${staged.page.label}`;
            let report: D2cReport;
            while (true) {
              report = buildReport({
                task: input.task,
                reportId: nextReportId(),
                batchId,
                page: { ...staged.page, index: staged.index, count: manifest.pages.length },
                createdAt,
                design: {
                  source: join(".flavor", "d2c", input.task, "design", staged.page.html),
                  designHash: manifest.designHash,
                  snapshot: { width: staged.designSnapshot.width, height: staged.designSnapshot.height, elements: staged.designSnapshot.elements },
                  capture: staged.designSnapshot.diagnostics,
                },
                implementation: {
                  source: staged.pageSource.kind === "url" ? staged.pageSource.url : staged.pageSource.path,
                  snapshot: { width: staged.implSnapshot.width, height: staged.implSnapshot.height, elements: staged.implSnapshot.elements },
                  capture: staged.implSnapshot.diagnostics,
                },
                pixelMismatchRate: staged.pixel.mismatchRate,
              });
              try {
                await writeReport(workspace, input.task, report, {
                  designPng: staged.designSnapshot.screenshotPng,
                  implementationPng: staged.implSnapshot.screenshotPng,
                  heatmapPng: staged.pixel.heatmapPng,
                });
                break;
              } catch (cause) {
                if (!(cause instanceof D2cReportAlreadyExistsError)) {
                  await progress("report", "failed", `${pageContext} · 报告保存失败`);
                  throw cause;
                }
              }
            }
            reports.push(report);
          }

          const primary = reports[0]!;
          await progress("report", "completed", `${manifest.pages.length} 个页面的评测报告已生成`);
          await onReport?.({
            task: input.task,
            reportId: primary.reportId,
            total: primary.scores.total,
            grade: primary.scores.grade,
            pageCount: reports.length,
          });
          return {
            report: primary,
            reports,
            summary: reports.map((report) => `${report.page?.label ?? report.task}\n${summarizeReport(report)}`).join("\n\n"),
          };
        }

        signal.throwIfAborted();
        const viewportKey = viewport === undefined ? "natural" : `${viewport.width}x${viewport.height}`;
        const designCacheKey = manifest.designHash === undefined
          ? undefined
          : `${input.task}:${manifest.designHash}:${viewportKey}`;
        let designSnapshot = designCacheKey === undefined ? undefined : designSnapshotCache.get(designCacheKey);
        if (designSnapshot === undefined) {
          await progress("capture-design", "running", "正在渲染设计稿快照");
          try {
            designSnapshot = await capture.capture({ kind: "file", path: designPath }, viewport, signal);
            if (designCacheKey !== undefined) {
              designSnapshotCache.set(designCacheKey, designSnapshot);
              while (designSnapshotCache.size > 3) designSnapshotCache.delete(designSnapshotCache.keys().next().value!);
            }
            await progress("capture-design", "completed", "设计稿快照已就绪");
          } catch (error) {
            await progress("capture-design", "failed", "设计稿快照失败");
            throw error;
          }
        } else {
          await progress("capture-design", "completed", "设计稿快照已就绪", true);
        }
        const implViewport = viewport ?? { width: designSnapshot.width, height: designSnapshot.height };
        await progress("capture-implementation", "running", "正在渲染实现快照");
        let implSnapshot: CapturedPage;
        try {
          implSnapshot = await capture.capture(source, implViewport, signal);
          await progress("capture-implementation", "completed", "实现快照已就绪");
        } catch (error) {
          await progress("capture-implementation", "failed", "实现快照失败");
          throw error;
        }
        const comparePixels = options.comparePixels ?? comparePngsInWorker;
        await progress("pixel-diff", "running", "正在计算像素与结构差异");
        let pixel: D2cPixelComparison;
        try {
          pixel = await comparePixels(designSnapshot.screenshotPng, implSnapshot.screenshotPng, signal);
          await progress("pixel-diff", "completed", "像素与结构差异已计算");
        } catch (error) {
          await progress("pixel-diff", "failed", "像素对比失败");
          throw error;
        }

        const createdAt = (now ?? (() => new Date()))();
        await progress("report", "running", "正在生成评测报告");
        const existing = new Set((await listReports(workspace, input.task)).map((item) => item.reportId));
        const baseReportId = formatRunId(createdAt);
        let suffix = 1;
        let report;
        while (true) {
          signal.throwIfAborted();
          const reportId = suffix === 1 ? baseReportId : `${baseReportId}-${suffix}`;
          suffix += 1;
          if (existing.has(reportId)) continue;
          report = buildReport({
            task: input.task,
            reportId,
            createdAt,
            design: {
              source: join(".flavor", "d2c", input.task, "design", manifest.entryHtml),
              designHash: manifest.designHash,
              snapshot: { width: designSnapshot.width, height: designSnapshot.height, elements: designSnapshot.elements },
              capture: designSnapshot.diagnostics,
            },
            implementation: {
              source: input.implementation,
              snapshot: { width: implSnapshot.width, height: implSnapshot.height, elements: implSnapshot.elements },
              capture: implSnapshot.diagnostics,
            },
            pixelMismatchRate: pixel.mismatchRate,
          });
          try {
            await writeReport(workspace, input.task, report, {
              designPng: designSnapshot.screenshotPng,
              implementationPng: implSnapshot.screenshotPng,
              heatmapPng: pixel.heatmapPng,
            });
            break;
          } catch (cause) {
            if (!(cause instanceof D2cReportAlreadyExistsError)) throw cause;
          }
        }
        await progress("report", "completed", "评测报告已生成");
        if (onReport !== undefined) {
          await onReport({ task: input.task, reportId: report.reportId, total: report.scores.total, grade: report.scores.grade });
        }
        return { report, summary: summarizeReport(report) };
      } finally {
        if (running !== undefined) await running.stop();
      }
    },
  };

  return [importTool, compareTool];
}
