import { lstatSync, realpathSync } from "node:fs";
import { lstat, open, readdir, realpath, stat, writeFile } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { redactConfig } from "../config/load.js";
import type {
  LoadedPlugin, PluginContext, PluginDiagnostic, PluginDisposer, PluginHostOptions, PluginLogger,
  PluginManifest, PluginRegistrationCallbacks, PluginSkillRootCapability, PluginSource,
} from "./types.js";
import { message } from "../utils/error.js";
import { PluginManifestSchema } from "./types.js";

const MANIFEST = "flavor-plugin.json";
const MAX_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_ACTIVATION_TIMEOUT_MS = 10_000;
const DEFAULT_UNLOAD_TIMEOUT_MS = 5_000;
const silentLogger: PluginLogger = { debug() {}, info() {}, warn() {}, error() {} };

interface Snapshot { dev: bigint; ino: bigint; mode: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
interface EntrySnapshot { lexical: Snapshot; physical: Snapshot; physicalPath: string }
interface Candidate { manifest: PluginManifest; root: string; source: PluginSource; entry: string; entrySnapshot: EntrySnapshot }
interface ContextState { active: boolean; controller: AbortController }
interface ActivePlugin { metadata: LoadedPlugin; disposers: PluginDisposer[]; state: ContextState }
type ContributionKind = keyof PluginRegistrationCallbacks;

/**
 * Hosts trusted in-process plugins behind a narrow host API. Plugin roots must remain immutable
 * during activation. Concurrent malicious mutation is outside the MVP trust model because plugin
 * code already has Node.js authority; this is explicitly not a process sandbox.
 */
export class PluginHost {
  readonly #options: PluginHostOptions;
  readonly #activationTimeoutMs: number;
  readonly #unloadTimeoutMs: number;
  readonly #active: ActivePlugin[] = [];
  readonly #claimed = new Map<string, string>();
  #diagnostics: PluginDiagnostic[] = [];
  #loaded = false;

  constructor(options: PluginHostOptions) {
    this.#options = options;
    this.#activationTimeoutMs = positiveTimeout(options.activationTimeoutMs, DEFAULT_ACTIVATION_TIMEOUT_MS, "activationTimeoutMs");
    this.#unloadTimeoutMs = positiveTimeout(options.unloadTimeoutMs, DEFAULT_UNLOAD_TIMEOUT_MS, "unloadTimeoutMs");
  }

  get diagnostics(): readonly PluginDiagnostic[] { return [...this.#diagnostics]; }
  get loadedPlugins(): readonly LoadedPlugin[] { return this.#active.map(({ metadata }) => ({ ...metadata })); }

  async loadAll(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    this.#diagnostics = [];
    const disabled = new Set(this.#options.disabledPlugins ?? []);
    for (const candidate of await this.#discover()) if (!disabled.has(candidate.manifest.name)) await this.#activate(candidate);
  }

  async unloadAll(): Promise<void> {
    for (const plugin of [...this.#active].reverse()) await this.unload(plugin.metadata.name);
  }

  async unload(name: string): Promise<void> {
    const index = this.#active.findIndex(({ metadata }) => metadata.name === name);
    if (index < 0) return;
    const plugin = this.#active[index]!;
    this.#active.splice(index, 1);
    plugin.state.active = false;
    plugin.state.controller.abort(new Error(`Plugin ${name} unloaded`));
    try {
      await disposeAll(plugin.disposers, this.#unloadTimeoutMs,
        (error) => this.#diagnose(name, error, plugin.metadata.root));
    } finally {
      this.#releaseClaims(name);
      try {
        await bounded(Promise.resolve(this.#options.emitLifecycle?.("PluginUnload", plugin.metadata)), this.#unloadTimeoutMs, "PluginUnload lifecycle");
      } catch (error) { this.#diagnose(name, error, plugin.metadata.root); }
    }
  }

  async #discover(): Promise<Candidate[]> {
    const tiers = {
      global: uniqueTier(await this.#discoverDirectories(this.#options.globalPluginDirs ?? [], "global"), this.#diagnostics),
      npm: uniqueTier(await this.#discoverNpm(), this.#diagnostics),
      project: uniqueTier(await this.#discoverDirectories(this.#options.projectPluginDirs ?? [], "project"), this.#diagnostics),
    };
    const names = new Set([...tiers.global.keys(), ...tiers.npm.keys(), ...tiers.project.keys()]);
    const selected: Candidate[] = [];
    for (const name of [...names].sort(compare)) {
      const winner = tiers.project.get(name) ?? tiers.npm.get(name) ?? tiers.global.get(name);
      if (winner === undefined) continue;
      selected.push(winner);
      for (const candidate of [tiers.global.get(name), tiers.npm.get(name), tiers.project.get(name)]) {
        if (candidate !== undefined && candidate !== winner) this.#diagnose(name,
          new Error(`${candidate.source} plugin overridden by ${winner.source} plugin`), candidate.root);
      }
    }
    return selected;
  }

  async #discoverDirectories(directories: readonly string[], source: PluginSource): Promise<Candidate[]> {
    const roots: string[] = [];
    for (const directory of directories) {
      try {
        for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) roots.push(resolve(directory, entry.name));
      } catch (error) { this.#diagnose(directory, error, directory); }
    }
    const candidates: Candidate[] = [];
    for (const root of roots.sort(compare)) {
      const candidate = await this.#readCandidate(root, source);
      if (candidate !== undefined) candidates.push(candidate);
    }
    return candidates;
  }

  async #discoverNpm(): Promise<Candidate[]> {
    const candidates: Candidate[] = [];
    for (const specifier of [...(this.#options.npmPackages ?? [])].sort(compare)) {
      try {
        if (this.#options.resolveNpmPackage === undefined) throw new Error("No npm plugin resolver was provided");
        const root = await this.#options.resolveNpmPackage(specifier);
        if (root === undefined) throw new Error(`Could not resolve npm plugin ${specifier}`);
        const candidate = await this.#readCandidate(root, "npm", specifier);
        if (candidate !== undefined) candidates.push(candidate);
      } catch (error) { this.#diagnose(specifier, error); }
    }
    return candidates;
  }

  async #readCandidate(inputRoot: string, source: PluginSource, label = inputRoot): Promise<Candidate | undefined> {
    let diagnosticLabel = label;
    try {
      const rootInfo = await lstat(inputRoot);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Plugin root must be a static directory");
      const root = await realpath(inputRoot);
      const rawManifest = await readManifest(resolve(root, MANIFEST));
      if (typeof rawManifest === "object" && rawManifest !== null && "name" in rawManifest && typeof rawManifest.name === "string") {
        diagnosticLabel = rawManifest.name;
      }
      const manifest = PluginManifestSchema.parse(rawManifest);
      const entry = resolveContained(root, manifest.main, "Plugin entry");
      const entrySnapshot = await snapshotEntry(root, entry);
      return { manifest, root, source, entry, entrySnapshot };
    } catch (error) {
      this.#diagnose(diagnosticLabel, error, inputRoot);
      return undefined;
    }
  }

  async #activate(candidate: Candidate): Promise<void> {
    const plugin = candidate.manifest.name;
    const disposers: PluginDisposer[] = [];
    const claimed: string[] = [];
    const state: ContextState = { active: true, controller: new AbortController() };
    let activation: Promise<unknown> | undefined;
    try {
      await verifyEntry(candidate.root, candidate.entry, candidate.entrySnapshot);
      const imported = import(`${pathToFileURL(candidate.entrySnapshot.physicalPath).href}?flavor=${encodeURIComponent(plugin)}`);
      const module = await bounded(imported, this.#activationTimeoutMs, "Plugin import") as {
        activate?: (context: PluginContext) => unknown | Promise<unknown>;
      };
      await verifyEntry(candidate.root, candidate.entry, candidate.entrySnapshot);
      if (typeof module.activate !== "function") throw new Error("Plugin entry must export activate(context)");
      const context = this.#context(candidate, disposers, claimed, state);
      activation = Promise.resolve().then(() => module.activate!(context));
      const deactivate = await bounded(activation, this.#activationTimeoutMs, "Plugin activation");
      if (deactivate !== undefined) {
        if (typeof deactivate !== "function") throw new Error("Plugin activate result must be a disposer or undefined");
        disposers.push(deactivate as PluginDisposer);
      }
      this.#assertAllDeclaredRegistered(candidate, claimed);
      const metadata: LoadedPlugin = { name: plugin, version: candidate.manifest.version, source: candidate.source, root: candidate.root };
      this.#active.push({ metadata, disposers, state });
      try { await bounded(Promise.resolve(this.#options.emitLifecycle?.("PluginLoad", metadata)), this.#activationTimeoutMs, "PluginLoad lifecycle"); }
      catch (error) { this.#diagnose(plugin, error, candidate.root); }
    } catch (error) {
      state.active = false;
      state.controller.abort(error);
      if (error instanceof TimeoutError && activation !== undefined) {
        void activation.then(async (lateResult) => {
          if (lateResult === undefined) return;
          if (typeof lateResult !== "function") {
            this.#diagnose(plugin, new Error("Late plugin activation returned an invalid disposer"), candidate.root);
            return;
          }
          await bounded(Promise.resolve().then(lateResult as PluginDisposer), this.#unloadTimeoutMs, "Late plugin activation cleanup");
        }, (lateError: unknown) => {
          this.#diagnose(plugin, new Error(`Late plugin activation rejected: ${message(lateError)}`), candidate.root);
        }).catch((lateCleanupError: unknown) => this.#diagnose(plugin, lateCleanupError, candidate.root));
      }
      this.#releaseClaims(plugin);
      await disposeAll(disposers, this.#unloadTimeoutMs, (disposeError) => this.#diagnose(plugin, disposeError, candidate.root));
      this.#diagnose(plugin, error, candidate.root);
    }
  }

  #context(candidate: Candidate, disposers: PluginDisposer[], claimed: string[], state: ContextState): PluginContext {
    const { manifest } = candidate;
    const assertActive = () => {
      if (!state.active) throw new Error(`Plugin context for ${manifest.name} is no longer active`);
    };
    const register = (kind: ContributionKind, name: string, args: readonly unknown[]): PluginDisposer => {
      assertActive();
      if (!contributionNames(manifest, kind).has(name)) throw new Error(`${kind} contribution "${name}" was not declared by ${manifest.name}`);
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
        const index = claimed.indexOf(key);
        if (index >= 0) claimed.splice(index, 1);
        return underlying();
      };
      this.#claimed.set(key, manifest.name);
      claimed.push(key);
      disposers.push(disposer);
      return disposer;
    };
    const authorize = async (operation: "read" | "write", rawPath: string): Promise<string> => {
      assertActive();
      const permission = `filesystem:${operation}` as const;
      if (!manifest.permissions.includes(permission)) throw new Error(`Plugin ${manifest.name} lacks ${permission} permission`);
      const path = resolve(rawPath);
      const authorized = await this.#options.authorizeFilesystem?.({ plugin: manifest.name, operation, path });
      assertActive();
      if (authorized !== true) throw new Error(`Filesystem ${operation} denied for plugin ${manifest.name}`);
      return path;
    };
    return Object.freeze({
      signal: state.controller.signal,
      config: deepFreeze(redactConfig(this.#options.config ?? {})),
      logger: scopedLogger(this.#options.logger ?? silentLogger, manifest.name),
      services: Object.freeze({ filesystem: Object.freeze({
        readFile: async (path: string, encoding?: BufferEncoding) => {
          const allowed = await authorize("read", path);
          assertActive();
          const handle = await open(allowed, "r");
          try {
            assertActive();
            return encoding === undefined ? handle.readFile() : handle.readFile({ encoding });
          }
          finally { await handle.close(); }
        },
        writeFile: async (path: string, data: string | Uint8Array) => {
          const allowed = await authorize("write", path);
          assertActive();
          return writeFile(allowed, data);
        },
      }) }),
      registerCommand: (name: string, value: unknown) => register("command", name, [value]),
      registerTool: (name: string, value: unknown) => register("tool", name, [value]),
      registerHook: (name: string, value: unknown, options?: unknown) => register("hook", name, [value, options]),
      registerSkillRoot: (name: string, root: string) => {
        const declared = manifest.contributes.skillRoots.find((item) => item.name === name)?.path;
        if (declared === undefined) throw new Error(`skillRoot contribution "${name}" was not declared by ${manifest.name}`);
        const expected = resolveContained(candidate.root, declared, "Declared skill root");
        const registered = resolveContained(candidate.root, root, "Registered skill root");
        if (expected !== registered) throw new Error(`Registered skill root "${name}" does not match its declaration`);
        const info = lstatSync(registered, { bigint: true });
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Skill root "${name}" must be a static directory`);
        const physical = realpathSync.native(registered);
        assertContained(candidate.root, physical, "Skill root");
        const snapshot = fromStats(info);
        const capability: PluginSkillRootCapability = Object.freeze({ path: physical, identity: Object.freeze(pickIdentity(snapshot)) });
        return register("skillRoot", name, [capability]);
      },
      registerModelAdapter: (name: string, value: unknown) => register("modelAdapter", name, [value]),
    }) as PluginContext;
  }

  #assertAllDeclaredRegistered(candidate: Candidate, claimed: readonly string[]): void {
    const actual = new Set(claimed);
    for (const kind of ["command", "tool", "hook", "skillRoot", "modelAdapter"] as const) {
      for (const name of contributionNames(candidate.manifest, kind)) if (!actual.has(`${kind}:${name}`)) {
        throw new Error(`Declared ${kind} contribution "${name}" was not registered`);
      }
    }
  }

  #releaseClaims(plugin: string): void { for (const [key, owner] of this.#claimed) if (owner === plugin) this.#claimed.delete(key); }
  #diagnose(plugin: string, error: unknown, path?: string): void {
    this.#diagnostics.push({ plugin, ...(path === undefined ? {} : { path }), message: message(error) });
  }
}

async function readManifest(path: string): Promise<unknown> {
  const lexical = await lstat(path, { bigint: true });
  if (!lexical.isFile() || lexical.isSymbolicLink()) throw new Error("Plugin manifest must be a static regular file");
  const handle = await open(path, "r");
  try {
    const before = fromStats(await handle.stat({ bigint: true }));
    assertSnapshot(fromStats(lexical), before, "Plugin manifest identity");
    if (before.size > BigInt(MAX_MANIFEST_BYTES)) throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_MANIFEST_BYTES) throw new Error(`Plugin manifest exceeds ${MAX_MANIFEST_BYTES} bytes`);
    const after = fromStats(await handle.stat({ bigint: true }));
    assertSnapshot(before, after, "Plugin manifest");
    const current = fromStats(await lstat(path, { bigint: true }));
    assertSnapshot(before, current, "Plugin manifest path");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
  } finally { await handle.close(); }
}

async function snapshotEntry(root: string, entry: string): Promise<EntrySnapshot> {
  const lexicalStats = await lstat(entry, { bigint: true });
  if (!lexicalStats.isFile() && !lexicalStats.isSymbolicLink()) throw new Error("Plugin entry must be a file");
  const physicalPath = await realpath(entry);
  assertContained(root, physicalPath, "Plugin entry symlink");
  const physicalStats = await stat(physicalPath, { bigint: true });
  if (!physicalStats.isFile()) throw new Error("Plugin entry must resolve to a regular file");
  return { lexical: fromStats(lexicalStats), physical: fromStats(physicalStats), physicalPath };
}

async function verifyEntry(root: string, entry: string, expected: EntrySnapshot): Promise<void> {
  const current = await snapshotEntry(root, entry);
  if (current.physicalPath !== expected.physicalPath) throw new Error("Plugin entry identity changed");
  assertSnapshot(expected.lexical, current.lexical, "Plugin entry path");
  assertSnapshot(expected.physical, current.physical, "Plugin entry");
}

function uniqueTier(candidates: readonly Candidate[], diagnostics: PluginDiagnostic[]): Map<string, Candidate> {
  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) groups.set(candidate.manifest.name, [...(groups.get(candidate.manifest.name) ?? []), candidate]);
  const result = new Map<string, Candidate>();
  for (const [name, group] of groups) {
    if (group.length === 1) result.set(name, group[0]!);
    else for (const candidate of group) diagnostics.push({ plugin: name, path: candidate.root, message: `Duplicate ${candidate.source} plugin name: ${name}` });
  }
  return result;
}

function contributionNames(manifest: PluginManifest, kind: ContributionKind): Set<string> {
  const key = ({ command: "commands", tool: "tools", hook: "hooks", skillRoot: "skillRoots", modelAdapter: "modelAdapters" } as const)[kind];
  return new Set(manifest.contributes[key].map(({ name }) => name));
}

function fromStats(stats: BigIntStats): Snapshot {
  return { dev: stats.dev, ino: stats.ino, mode: stats.mode, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs };
}
function pickIdentity(snapshot: Snapshot) {
  return { dev: snapshot.dev, ino: snapshot.ino, mtimeNs: snapshot.mtimeNs, ctimeNs: snapshot.ctimeNs };
}
function assertSnapshot(expected: Snapshot, actual: Snapshot, label: string): void {
  for (const key of ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"] as const) if (expected[key] !== actual[key]) throw new Error(`${label} changed during validation`);
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
  return Object.freeze({ debug: (v: string) => logger.debug(prefix + v), info: (v: string) => logger.info(prefix + v), warn: (v: string) => logger.warn(prefix + v), error: (v: string) => logger.error(prefix + v) });
}
function deepFreeze(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
async function disposeAll(disposers: readonly PluginDisposer[], timeoutMs: number, onError: (error: unknown) => void): Promise<void> {
  for (const dispose of [...disposers].reverse()) {
    try { await bounded(Promise.resolve().then(dispose), timeoutMs, "Plugin disposer"); }
    catch (error) { onError(error); }
  }
}
class TimeoutError extends Error {}
async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new TimeoutError(`${label} timeout after ${timeoutMs}ms`)), timeoutMs); });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive integer`);
  return result;
}
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
