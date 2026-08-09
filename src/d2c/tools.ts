import { stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import { comparePngs } from "./pixel.js";
import { buildReport, summarizeReport } from "./report.js";
import { runFrontendProject, type RunningProject } from "./runner.js";
import { D2C_TASK_PATTERN, designEntryPath, importDesign, listReports, readManifest, writeReport } from "./store.js";
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
  runProject?: (projectDir: string) => Promise<RunningProject>;
}

const taskSchema = z.string().regex(D2C_TASK_PATTERN, "Task name must be lowercase letters, digits and dashes");

const D2cImportInput = z.object({
  task: taskSchema,
  exportDir: z.string().trim().min(1),
});

const D2cCompareInput = z.object({
  task: taskSchema,
  implementation: z.string().trim().min(1),
  viewportWidth: z.coerce.number().int().positive().max(8192).optional(),
  viewportHeight: z.coerce.number().int().positive().max(8192).optional(),
});

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
  const resolved = isAbsolute(implementation) ? resolve(implementation) : resolve(workspace, implementation);
  assertInsideWorkspace(workspace, resolved, implementation);
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
  if (info === undefined) {
    throw new Error(`D2C implementation source does not exist: ${implementation}`);
  }
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
    execute: async (input) => {
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
    execute: async (input) => {
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
          ?? ((projectDir: string) => runFrontendProject(projectDir, { workspace }));
        running = await runProject(resolvedSource.path);
        source = { kind: "url", url: running.url };
      } else {
        source = resolvedSource;
      }
      const viewport = input.viewportWidth !== undefined && input.viewportHeight !== undefined
        ? { width: input.viewportWidth, height: input.viewportHeight }
        : undefined;
      try {
        const designSnapshot = await capture.capture({ kind: "file", path: designPath }, viewport);
        const implSnapshot = await capture.capture(source, viewport);
        const pixel = comparePngs(designSnapshot.screenshotPng, implSnapshot.screenshotPng);

        const createdAt = (now ?? (() => new Date()))();
        const existing = new Set((await listReports(workspace, input.task)).map((item) => item.reportId));
        let reportId = formatRunId(createdAt);
        for (let suffix = 2; existing.has(reportId); suffix += 1) reportId = `${formatRunId(createdAt)}-${suffix}`;

        const report = buildReport({
          task: input.task,
          reportId,
          createdAt,
          design: {
            source: join(".flavor", "d2c", input.task, "design", manifest.entryHtml),
            snapshot: { width: designSnapshot.width, height: designSnapshot.height, elements: designSnapshot.elements },
          },
          implementation: {
            source: input.implementation,
            snapshot: { width: implSnapshot.width, height: implSnapshot.height, elements: implSnapshot.elements },
          },
          pixelMismatchRate: pixel.mismatchRate,
        });
        await writeReport(workspace, input.task, report, {
          designPng: designSnapshot.screenshotPng,
          implementationPng: implSnapshot.screenshotPng,
          heatmapPng: pixel.heatmapPng,
        });
        if (onReport !== undefined) {
          await onReport({ task: input.task, reportId, total: report.scores.total, grade: report.scores.grade });
        }
        return { report, summary: summarizeReport(report) };
      } finally {
        if (running !== undefined) await running.stop();
      }
    },
  };

  return [importTool, compareTool];
}
