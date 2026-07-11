import { lstatSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { redactConfig } from "../config/load.js";
import type {
  LoadedPlugin,
  PluginContext,
  PluginDiagnostic,
  PluginDisposer,
  PluginHostOptions,
  PluginLogger,
  PluginManifest,
  PluginRegistrationCallbacks,
  PluginSource,
} from "./types.js";
import { PluginManifestSchema } from "./types.js";

const MANIFEST = "flavor-plugin.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface Candidate {
  manifest: PluginManifest;
  root: string;
  source: PluginSource;
  entry: string;
}

interface ActivePlugin {
  metadata: LoadedPlugin;
  disposers: PluginDisposer[];
}

type ContributionKind = keyof PluginRegistrationCallbacks;

/** Hosts trusted in-process plugins behind a narrow, permission-mediated host API. */
export class PluginHost {
  readonly #options: PluginHostOptions;
  readonly #active: ActivePlugin[] = [];
  readonly #claimed = new Map<string, string>();
  #diagnostics: PluginDiagnostic[] = [];
  #loaded = false;

  constructor(options: PluginHostOptions) {
    this.#options = options;
  }

  get diagnostics(): readonly PluginDiagnostic[] {
    return [...this.#diagnostics];
  }

  get loadedPlugins(): readonly LoadedPlugin[] {
    return this.#active.map(({ metadata }) => ({ ...metadata }));
  }

  async loadAll(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#diagnostics = [];
    const candidates = await this.#discover();
    const disabled = new Set(this.#options.disabledPlugins ?? []);
    for (const candidate of candidates) {
      if (disabled.has(candidate.manifest.name)) continue;
      await this.#activate(candidate);
    }
  }

  async unloadAll(): Promise<void> {
    for (const plugin of [...this.#active].reverse()) await this.unload(plugin.metadata.name);
  }

  async unload(name: string): Promise<void> {
    const index = this.#active.findIndex(({ metadata }) => metadata.name === name);
    if (index < 0) return;
    const plugin = this.#active[index]!;
    this.#active.splice(index, 1);
    await disposeAll(plugin.disposers, (error) => this.#diagnose(plugin.metadata.name, error, plugin.metadata.root));
    this.#releaseClaims(plugin.metadata.name);
    try { await this.#options.emitLifecycle?.("PluginUnload", plugin.metadata); }
    catch (error) { this.#diagnose(plugin.metadata.name, error, plugin.metadata.root); }
  }

  async #discover(): Promise<Candidate[]> {
    const global = await this.#discoverDirectories(this.#options.globalPluginDirs ?? [], "global");
    const project = await this.#discoverDirectories(this.#options.projectPluginDirs ?? [], "project");
    const npm = await this.#discoverNpm();
    const selected = new Map<string, Candidate>();
    for (const candidate of [...global, ...npm, ...project]) selected.set(candidate.manifest.name, candidate);
    return [...selected.values()].sort((a, b) => compare(a.manifest.name, b.manifest.name));
  }

  async #discoverDirectories(directories: readonly string[], source: PluginSource): Promise<Candidate[]> {
    const roots: string[] = [];
    for (const directory of directories) {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        for (const entry of entries) if (entry.isDirectory()) roots.push(resolve(directory, entry.name));
      } catch (error) {
        this.#diagnose(directory, error, directory);
      }
    }
    roots.sort(compare);
    const candidates: Candidate[] = [];
    for (const root of roots) {
      const candidate = await this.#readCandidate(root, source);
      if (candidate !== undefined) candidates.push(candidate);
    }
    return candidates;
  }

  async #discoverNpm(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const specifier of [...(this.#options.npmPackages ?? [])].sort(compare)) {
      if (this.#options.resolveNpmPackage === undefined) {
        this.#diagnose(specifier, new Error("No npm plugin resolver was provided"));
        continue;
      }
      try {
        const root = await this.#options.resolveNpmPackage(specifier);
        if (root === undefined) throw new Error(`Could not resolve npm plugin ${specifier}`);
        const candidate = await this.#readCandidate(root, "npm", specifier);
        if (candidate !== undefined) candidates.push(candidate);
      } catch (error) {
        this.#diagnose(specifier, error);
      }
    }
    return candidates;
  }

  async #readCandidate(inputRoot: string, source: PluginSource, label = inputRoot): Promise<Candidate | undefined> {
    let diagnosticLabel = label;
    try {
      const rootInfo = await lstat(inputRoot);
      if (!rootInfo.isDirectory()) throw new Error("Plugin root must be a directory");
      const root = await realpath(inputRoot);
      const manifestPath = resolve(root, MANIFEST);
      const manifestInfo = await stat(manifestPath);
      if (manifestInfo.size > MAX_MANIFEST_BYTES) throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
      const rawManifest: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof rawManifest === "object" && rawManifest !== null && "name" in rawManifest
        && typeof rawManifest.name === "string") diagnosticLabel = rawManifest.name;
      const manifest = PluginManifestSchema.parse(rawManifest);
      const entry = resolveContained(root, manifest.main, "Plugin entry");
      const entryInfo = await lstat(entry);
      if (!entryInfo.isFile() && !entryInfo.isSymbolicLink()) throw new Error("Plugin entry must be a file");
      const physicalEntry = await realpath(entry);
      assertContained(root, physicalEntry, "Plugin entry symlink");
      return { manifest, root, source, entry: physicalEntry };
    } catch (error) {
      this.#diagnose(diagnosticLabel, error, inputRoot);
      return undefined;
    }
  }

  async #activate(candidate: Candidate): Promise<void> {
    const plugin = candidate.manifest.name;
    const disposers: PluginDisposer[] = [];
    const claimed: string[] = [];
    try {
      const context = this.#context(candidate, disposers, claimed);
      const module = await import(`${pathToFileURL(candidate.entry).href}?flavor=${encodeURIComponent(plugin)}`) as {
        activate?: (context: PluginContext) => unknown | Promise<unknown>;
      };
      if (typeof module.activate !== "function") throw new Error("Plugin entry must export activate(context)");
      const deactivate = await module.activate(context);
      if (deactivate !== undefined) {
        if (typeof deactivate !== "function") throw new Error("Plugin activate result must be a disposer or undefined");
        disposers.push(deactivate as PluginDisposer);
      }
      this.#assertAllDeclaredRegistered(candidate, claimed);
      const metadata: LoadedPlugin = {
        name: plugin, version: candidate.manifest.version, source: candidate.source, root: candidate.root,
      };
      this.#active.push({ metadata, disposers });
      try { await this.#options.emitLifecycle?.("PluginLoad", metadata); }
      catch (error) { this.#diagnose(plugin, error, candidate.root); }
    } catch (error) {
      await disposeAll(disposers, (disposeError) => this.#diagnose(plugin, disposeError, candidate.root));
      for (const key of claimed) this.#claimed.delete(key);
      this.#diagnose(plugin, error, candidate.root);
    }
  }

  #context(candidate: Candidate, disposers: PluginDisposer[], claimed: string[]): PluginContext {
    const manifest = candidate.manifest;
    const register = (kind: ContributionKind, name: string, args: readonly unknown[]): PluginDisposer => {
      const declared = contributionNames(manifest, kind);
      if (!declared.has(name)) throw new Error(`${kind} contribution "${name}" was not declared by ${manifest.name}`);
      const key = `${kind}:${name}`;
      const owner = this.#claimed.get(key);
      if (owner !== undefined) throw new Error(`${kind} contribution conflict for "${name}" with plugin ${owner}`);
      const callback = this.#options.registrations[kind] as (...values: unknown[]) => PluginDisposer;
      const underlying = callback(name, ...args);
      let disposed = false;
      const disposer = () => {
        if (disposed) return;
        disposed = true;
        this.#claimed.delete(key);
        const claimIndex = claimed.indexOf(key);
        if (claimIndex >= 0) claimed.splice(claimIndex, 1);
        return underlying();
      };
      this.#claimed.set(key, manifest.name);
      claimed.push(key);
      disposers.push(disposer);
      return disposer;
    };
    const logger = scopedLogger(this.#options.logger ?? silentLogger, manifest.name);
    const config = deepFreeze(redactConfig(this.#options.config ?? {}));
    const authorize = async (operation: "read" | "write", rawPath: string): Promise<string> => {
      const permission = `filesystem:${operation}` as const;
      if (!manifest.permissions.includes(permission)) throw new Error(`Plugin ${manifest.name} lacks ${permission} permission`);
      const path = resolve(rawPath);
      if (await this.#options.authorizeFilesystem?.({ plugin: manifest.name, operation, path }) !== true) {
        throw new Error(`Filesystem ${operation} denied for plugin ${manifest.name}`);
      }
      return path;
    };
    return Object.freeze({
      config,
      logger,
      services: Object.freeze({ filesystem: Object.freeze({
        readFile: async (path: string, encoding?: BufferEncoding) => {
          const allowed = await authorize("read", path);
          return encoding === undefined ? readFile(allowed) : readFile(allowed, encoding);
        },
        writeFile: async (path: string, data: string | Uint8Array) => writeFile(await authorize("write", path), data),
      }) }),
      registerCommand: (name: string, command: unknown) => register("command", name, [command]),
      registerTool: (name: string, tool: unknown) => register("tool", name, [tool]),
      registerHook: (name: string, hook: unknown, options?: unknown) => register("hook", name, [hook, options]),
      registerSkillRoot: (name: string, root: string) => {
        const declaredPath = manifest.contributes.skillRoots.find((item) => item.name === name)?.path;
        if (declaredPath === undefined) throw new Error(`skillRoot contribution "${name}" was not declared by ${manifest.name}`);
        const declaredRoot = resolveContained(candidate.root, declaredPath, "Declared skill root");
        const registeredRoot = resolveContained(candidate.root, root, "Registered skill root");
        if (declaredRoot !== registeredRoot) throw new Error(`Registered skill root "${name}" does not match its declaration`);
        const info = lstatSync(registeredRoot);
        if (!info.isDirectory() && !info.isSymbolicLink()) throw new Error(`Skill root "${name}" must be a directory`);
        const physicalRoot = realpathSync.native(registeredRoot);
        assertContained(candidate.root, physicalRoot, "Skill root symlink");
        return register("skillRoot", name, [physicalRoot]);
      },
      registerModelAdapter: (name: string, adapter: unknown) => register("modelAdapter", name, [adapter]),
    }) as PluginContext;
  }

  #assertAllDeclaredRegistered(candidate: Candidate, claimed: readonly string[]): void {
    const actual = new Set(claimed);
    for (const kind of ["command", "tool", "hook", "skillRoot", "modelAdapter"] as const) {
      for (const name of contributionNames(candidate.manifest, kind)) {
        if (!actual.has(`${kind}:${name}`)) throw new Error(`Declared ${kind} contribution "${name}" was not registered`);
      }
    }
  }

  #releaseClaims(plugin: string): void {
    for (const [key, owner] of this.#claimed) if (owner === plugin) this.#claimed.delete(key);
  }

  #diagnose(plugin: string, error: unknown, path?: string): void {
    this.#diagnostics.push({ plugin, ...(path === undefined ? {} : { path }), message: message(error) });
  }
}

function contributionNames(manifest: PluginManifest, kind: ContributionKind): Set<string> {
  const key = ({ command: "commands", tool: "tools", hook: "hooks", skillRoot: "skillRoots", modelAdapter: "modelAdapters" } as const)[kind];
  return new Set(manifest.contributes[key].map(({ name }) => name));
}

function resolveContained(root: string, value: string, label: string): string {
  if (isAbsolute(value)) throw new Error(`${label} must be relative to the plugin root`);
  const candidate = resolve(root, value);
  assertContained(root, candidate, label);
  return candidate;
}

function assertContained(root: string, candidate: string, label: string): void {
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error(`${label} escapes the plugin root`);
}

function scopedLogger(logger: PluginLogger, plugin: string): PluginLogger {
  const prefix = `[plugin:${plugin}] `;
  return Object.freeze({
    debug: (value: string) => logger.debug(prefix + value),
    info: (value: string) => logger.info(prefix + value),
    warn: (value: string) => logger.warn(prefix + value),
    error: (value: string) => logger.error(prefix + value),
  });
}

function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function disposeAll(disposers: readonly PluginDisposer[], onError: (error: unknown) => void): Promise<void> {
  for (const dispose of [...disposers].reverse()) {
    try { await dispose(); }
    catch (error) { onError(error); }
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
