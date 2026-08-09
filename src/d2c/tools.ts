import { realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import { D2C_MAX_PIXELS, type D2cPixelComparison } from "./pixel.js";
import { comparePngsInWorker } from "./pixel-worker-client.js";
import { buildReport, summarizeReport } from "./report.js";
import { runFrontendProject, type RunningProject } from "./runner.js";
import { D2cReportAlreadyExistsError, D2C_TASK_PATTERN, designEntryPath, importDesign, listReports, readManifest, writeReport } from "./store.js";
import type { D2cCaptureService, D2cCaptureSource } from "./types.js";

export interface D2cReportEvent {
  task: string;
  reportId: string;
  total: number;
  grade: string;
}

export interface D2cToolOptions {
  /** Rendering backend; only the desktop app provides one. */
  capture?: D2cCaptureService;
  /** Invoked after each stored comparison report. */
  onReport?: (event: D2cReportEvent) => void | Promise<void>;
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

function formatRunId(date: Date): string {
  const pad = (value: number): string => value.toString().padStart(2, "0");
  return `run-${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    + `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** Creates the D2C import and comparison tools bound to a workspace. */
export function createD2cTools(workspace: string, options: D2cToolOptions = {}): ToolDefinition<unknown>[] {
  const importTool: ToolDefinition<D2cImportInput> = {
    name: "D2cImport",
    description:
      "Import a Pixso HTML design export for D2C (design-to-code) comparison. Copies the export directory into .flavor/d2c/<task>/design/. The task name must be lowercase letters, digits and dashes.",
    inputSchema: D2cImportInput,
    paths: (input) => [input.exportDir],
    summarize: (input) => `${input.task} ← ${input.exportDir}`,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const manifest = await importDesign(workspace, input.task, input.exportDir);
      return {
        task: input.task,
        entryHtml: manifest.entryHtml,
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
    paths: (input) => [input.implementation],
    summarize: (input) => input.task,
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const { capture, onReport, now } = options;
      if (capture === undefined) {
        throw new Error("D2C comparison requires the desktop app; the capture service is not available in this session");
      }
      const manifest = await readManifest(workspace, input.task);
      const designPath = designEntryPath(workspace, input.task, manifest);
      const resolvedSource = await resolveImplementationSource(workspace, input.implementation);
      let running: RunningProject | undefined;
      let source: D2cCaptureSource;
      if (resolvedSource.kind === "project") {
        const runProject = options.runProject
          ?? ((projectDir: string, runSignal?: AbortSignal) => runFrontendProject(projectDir, {
            workspace,
            ...(runSignal === undefined ? {} : { signal: runSignal }),
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
        signal.throwIfAborted();
        const designSnapshot = await capture.capture({ kind: "file", path: designPath }, viewport, signal);
        const implViewport = viewport ?? { width: designSnapshot.width, height: designSnapshot.height };
        const implSnapshot = await capture.capture(source, implViewport, signal);
        const comparePixels = options.comparePixels ?? comparePngsInWorker;
        const pixel = await comparePixels(designSnapshot.screenshotPng, implSnapshot.screenshotPng, signal);

        const createdAt = (now ?? (() => new Date()))();
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
            },
            implementation: {
              source: input.implementation,
              snapshot: { width: implSnapshot.width, height: implSnapshot.height, elements: implSnapshot.elements },
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
