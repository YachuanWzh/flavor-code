import { z } from "zod";

import type { HookEventName, HookHandler, HookHandlerOptions } from "../hooks/types.js";
import type { ModelAdapter } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";

const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTRIBUTION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const entry = z.object({ name: z.string().regex(CONTRIBUTION_NAME) }).strict();

export const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME),
  version: z.string().min(1).max(64),
  apiVersion: z.literal("1"),
  main: z.string().min(1).max(512),
  permissions: z.array(z.enum(["filesystem:read", "filesystem:write"])).max(16),
  contributes: z.object({
    commands: z.array(entry).max(256),
    tools: z.array(entry).max(256),
    hooks: z.array(entry).max(256),
    skillRoots: z.array(entry.extend({ path: z.string().min(1).max(512) }).strict()).max(256),
    modelAdapters: z.array(entry).max(256),
  }).strict(),
}).strict();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
export type PluginSource = "global" | "project" | "npm";
export type PluginPermission = PluginManifest["permissions"][number];

export interface PluginLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface PluginFilesystemService {
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Uint8Array>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

export interface PluginServices {
  readonly filesystem: PluginFilesystemService;
}

export type PluginDisposer = () => void | Promise<void>;

/**
 * A deliberately narrow registration surface. Plugins run in-process and are trusted in the
 * MVP: this API mediates host-provided capabilities, but it is not a Node.js process sandbox.
 */
export interface PluginContext {
  readonly config: unknown;
  readonly logger: PluginLogger;
  readonly services: PluginServices;
  registerCommand(name: string, command: unknown): PluginDisposer;
  registerTool(name: string, tool: ToolDefinition<unknown>): PluginDisposer;
  registerHook(name: HookEventName, hook: HookHandler, options?: HookHandlerOptions): PluginDisposer;
  registerSkillRoot(name: string, root: string): PluginDisposer;
  registerModelAdapter(name: string, adapter: ModelAdapter): PluginDisposer;
}

export interface PluginDiagnostic {
  readonly plugin: string;
  readonly path?: string;
  readonly message: string;
}

export interface LoadedPlugin {
  readonly name: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly root: string;
}

export interface PluginRegistrationCallbacks {
  command(name: string, command: unknown): PluginDisposer;
  tool(name: string, tool: ToolDefinition<unknown>): PluginDisposer;
  hook(name: HookEventName, hook: HookHandler, options?: HookHandlerOptions): PluginDisposer;
  skillRoot(name: string, root: string): PluginDisposer;
  modelAdapter(name: string, adapter: ModelAdapter): PluginDisposer;
}

export interface FilesystemAuthorizationRequest {
  readonly plugin: string;
  readonly operation: "read" | "write";
  readonly path: string;
}

export interface PluginHostOptions {
  globalPluginDirs?: readonly string[];
  projectPluginDirs?: readonly string[];
  npmPackages?: readonly string[];
  disabledPlugins?: readonly string[];
  resolveNpmPackage?: (specifier: string) => string | undefined | Promise<string | undefined>;
  registrations: PluginRegistrationCallbacks;
  config?: unknown;
  logger?: PluginLogger;
  authorizeFilesystem?: (request: FilesystemAuthorizationRequest) => boolean | Promise<boolean>;
  emitLifecycle?: (type: "PluginLoad" | "PluginUnload", plugin: LoadedPlugin) => void | Promise<void>;
}
