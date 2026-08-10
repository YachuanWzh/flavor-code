import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize, posix, sep, win32 } from "node:path";

import { z } from "zod";

import type { D2cModuleDefinition } from "./openapi.js";
import { D2C_TASK_PATTERN } from "./store.js";

const ModuleSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/), label: z.string().trim().min(1).max(200),
  sourceFiles: z.array(z.string().trim().min(1).max(2_048)).min(1).max(64),
  keywords: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  dataNeeds: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  actions: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
}).strict();
const ManifestSchema = z.object({ schema: z.literal(1), modules: z.array(ModuleSchema).min(1).max(500) }).strict();

function safeSource(path: string): boolean {
  if (isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path) || path.includes("\0")) return false;
  const value = normalize(path);
  const portableSegments = path.replaceAll("\\", "/").split("/");
  return value !== ".." && !value.startsWith(`..${sep}`) && !portableSegments.includes("..");
}

export function d2cOutputDirectory(workspace: string, task: string): string {
  if (!D2C_TASK_PATTERN.test(task)) throw new Error(`Invalid D2C task: ${task}`);
  return join(workspace, "src", "d2c-output", task);
}

export async function readD2cModules(workspace: string, task: string): Promise<D2cModuleDefinition[]> {
  const project = d2cOutputDirectory(workspace, task);
  let raw: string;
  try { raw = await readFile(join(project, "d2c.modules.json"), "utf8"); }
  catch { return [{ id: "page", label: task, sourceFiles: ["src/App.vue", "src/App.jsx"], keywords: [task] }]; }
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error("D2C module manifest exceeds the supported size");
  const manifest = ManifestSchema.parse(JSON.parse(raw));
  for (const module of manifest.modules) {
    if (module.sourceFiles.some((path) => !safeSource(path))) throw new Error(`Invalid D2C module source path in ${module.id}`);
  }
  return manifest.modules.map((module) => ({
    id: module.id, label: module.label, sourceFiles: module.sourceFiles,
    ...(module.keywords === undefined ? {} : { keywords: module.keywords }),
    ...(module.dataNeeds === undefined ? {} : { dataNeeds: module.dataNeeds }),
    ...(module.actions === undefined ? {} : { actions: module.actions }),
  }));
}
