import { z } from "zod";

import { HOOK_EVENT_NAMES, type HookEventName, type HookHandler, type HookHandlerOptions } from "../hooks/types.js";
import type { ModelAdapter } from "../models/types.js";
import type { ToolDefinition } from "../tools/types.js";

const PLUGIN_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/;
const CONTRIBUTION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const entry = z.object({ name: z.string().regex(CONTRIBUTION_NAME) }).strict();
const uniqueArray = <T extends z.ZodType>(schema: T, label: string, identify: (item: z.output<T>) => string = (item) => String(item)) => z.array(schema).max(256).superRefine((items, context) => {
  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    const key = identify(item);
    if (seen.has(key)) context.addIssue({ code: "custom", message: `Duplicate ${label}`, path: [index] });
    seen.add(key);
  }
});

export const PluginManifestSchema = z.object({
  name: z.string().regex(PLUGIN_NAME),
  version: z.string().min(1).max(64),
  apiVersion: z.literal("1"),
  main: z.string().min(1).max(512),
  permissions: uniqueArray(z.enum([
    "filesystem:read", "filesystem:write", "network", "process", "runtime:in-process",
  ]), "permission").max(16),
  contributes: z.object({
    commands: uniqueArray(entry, "command contribution", (item) => item.name),
    tools: uniqueArray(entry, "tool contribution", (item) => item.name),
    hooks: uniqueArray(z.object({ name: z.enum(HOOK_EVENT_NAMES) }).strict(), "hook contribution", (item) => item.name),
    skillRoots: uniqueArray(entry.extend({ path: z.string().min(1).max(512) }).strict(), "skill-root contribution", (item) => item.name),
    modelAdapters: uniqueArray(entry, "model-adapter contribution", (item) => item.name),
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
export interface PluginCommandContext { readonly workspace: string; readonly signal: AbortSignal }
export type PluginCommandHandler = (args: readonly string[], context: PluginCommandContext) => unknown | Promise<unknown>;

/**
 * A deliberately narrow registration surface. Production runs plugins in an
 * isolated Worker/vm realm by default. Hosts that explicitly opt into legacy
 * in-process activation must treat the plugin as fully trusted Node.js code.
 */
export interface PluginContext {
  readonly signal: AbortSignal;
  readonly config: unknown;
  readonly logger: PluginLogger;
  readonly services: PluginServices;
  registerCommand(name: string, command: PluginCommandHandler, description?: string): PluginDisposer;
  registerTool(name: string, tool: ToolDefinition<unknown>): PluginDisposer;
  registerHook(name: HookEventName, hook: HookHandler, options?: HookHandlerOptions): PluginDisposer;
  registerSkillRoot(name: string, root: string): PluginDisposer;
  registerModelAdapter(name: string, adapter: ModelAdapter): PluginDisposer;
}

export interface PluginSkillRootCapability {
  readonly path: string;
  readonly identity: { readonly dev: bigint; readonly ino: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint };
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
  readonly fingerprint: string;
  readonly sandboxed: boolean;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginTrustRequest {
  readonly name: string;
  readonly version: string;
  readonly source: PluginSource;
  readonly root: string;
  readonly fingerprint: string;
  readonly sandboxed: boolean;
  readonly permissions: readonly PluginPermission[];
}

export interface PluginRegistrationCallbacks {
  command(name: string, command: PluginCommandHandler, description?: string): PluginDisposer;
  tool(name: string, tool: ToolDefinition<unknown>): PluginDisposer;
  hook(name: HookEventName, hook: HookHandler, options?: HookHandlerOptions): PluginDisposer;
  /** Consumers must revalidate identity before access, or delegate reading to SkillRegistry. */
  skillRoot(name: string, root: PluginSkillRootCapability): PluginDisposer;
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
  activationTimeoutMs?: number;
  unloadTimeoutMs?: number;
  /** When true, plugin modules run in an isolated Worker/vm realm. Only relative
   *  modules inside the plugin root and RPC-backed contribution calls are available. */
  sandbox?: boolean;
  /** Trust gate evaluated against the content fingerprint before activation. */
  authorizePlugin?: (request: PluginTrustRequest) => boolean | Promise<boolean>;
  /** Legacy in-process execution requires both a manifest capability and trust approval. */
  requireInProcessTrust?: boolean;
}
