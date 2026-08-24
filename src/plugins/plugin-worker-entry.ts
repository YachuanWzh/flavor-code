// Runs plugin modules in a dedicated V8 isolate and a separate vm.Context.
// Plugin source is never passed to Node's native module loader: only relative
// files contained by the plugin root are linked, and no host globals are injected.

import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, runInContext, SourceTextModule, type Module } from "node:vm";
import { parentPort, workerData } from "node:worker_threads";

import type {
  SandboxedPluginResult, SandboxParentMessage, SandboxPluginContributions, SandboxWorkerMessage,
} from "./sandbox-protocol.js";

const MAX_MODULE_BYTES = 2 * 1024 * 1024;
const CONTRIBUTION_NAME_SOURCE = "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$";
const data = workerData as { entryPath: string; pluginRoot: string; pluginName: string; pluginVersion: string; configJson: string };
const port = parentPort;
if (port === null) throw new Error("Plugin sandbox requires a parent port");
const activationKeepAlive = setInterval(() => undefined, 1_000);

function send(message: SandboxWorkerMessage): void { port!.postMessage(message); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function assertContained(root: string, candidate: string): void {
  const delta = relative(root, candidate);
  if (delta === ".." || delta.startsWith(`..${sep}`) || isAbsolute(delta)) throw new Error("Plugin module import escapes the plugin root");
}

const SANDBOX_BOOTSTRAP = `(() => {
  "use strict";
  const stores = { command: new Map(), tool: new Map(), hook: new Map(), skillRoot: new Map(), modelAdapter: new Map() };
  let deactivate;
  let accepting = true;
  const signal = Object.freeze({ aborted: false, reason: undefined, addEventListener() {}, removeEventListener() {}, throwIfAborted() {} });
  const cloneJson = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const deepFreeze = (value) => {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value)) deepFreeze(child);
    return Object.freeze(value);
  };
  const config = deepFreeze(JSON.parse(globalThis.__flavorConfigJson));
  delete globalThis.__flavorConfigJson;
  const namePattern = new RegExp(${JSON.stringify(CONTRIBUTION_NAME_SOURCE)});
  const name = (value) => {
    const result = String(value);
    if (!namePattern.test(result)) throw new Error("Invalid contribution name: " + result);
    return result;
  };
  const register = (kind, rawName, value, metadata) => {
    if (!accepting) throw new Error("Plugin registrations are closed after activation");
    const contributionName = name(rawName);
    if (stores[kind].has(contributionName)) throw new Error("Duplicate " + kind + " contribution: " + contributionName);
    stores[kind].set(contributionName, { value, metadata });
    let active = true;
    return Object.freeze(function disposeRegistration() {
      if (!active) return;
      active = false;
      stores[kind].delete(contributionName);
    });
  };
  const context = Object.freeze({
    signal,
    config,
    logger: Object.freeze({ debug() {}, info() {}, warn() {}, error() {} }),
    services: Object.freeze({ filesystem: Object.freeze({
      async readFile() { throw new Error("Filesystem read is not available in sandbox"); },
      async writeFile() { throw new Error("Filesystem write is not available in sandbox"); },
    }) }),
    registerCommand(rawName, handler, description) {
      if (typeof handler !== "function") throw new Error("Sandbox command handler must be a function");
      return register("command", rawName, handler, { description: typeof description === "string" ? description : undefined });
    },
    registerTool(rawName, tool) {
      if (!tool || typeof tool !== "object" || typeof tool.execute !== "function") throw new Error("Sandbox tool must provide execute(input, signal, context)");
      return register("tool", rawName, tool, {
        toolName: typeof tool.name === "string" ? tool.name : String(rawName),
        description: typeof tool.description === "string" ? tool.description : "Plugin tool " + String(rawName),
        modelInputSchema: cloneJson(tool.modelInputSchema), readOnly: tool.readOnly === true,
      });
    },
    registerHook(rawName, handler, options) {
      if (typeof handler !== "function") throw new Error("Sandbox hook handler must be a function");
      return register("hook", rawName, handler, { options: cloneJson(options) });
    },
    registerSkillRoot(rawName, root) {
      if (typeof root !== "string") throw new Error("Sandbox skill root must be a string");
      return register("skillRoot", rawName, root, { root });
    },
    registerModelAdapter(rawName, adapter) {
      if (!adapter || typeof adapter.stream !== "function") throw new Error("Sandbox model adapter must provide stream(request)");
      return register("modelAdapter", rawName, adapter, {});
    },
  });
  const describe = () => ({
    commands: [...stores.command].map(([entryName, entry]) => ({ name: entryName, ...entry.metadata })),
    tools: [...stores.tool].map(([entryName, entry]) => ({ name: entryName, ...entry.metadata })),
    hooks: [...stores.hook].map(([entryName, entry]) => ({ name: entryName, ...entry.metadata })),
    skillRoots: [...stores.skillRoot].map(([entryName, entry]) => ({ name: entryName, ...entry.metadata })),
    modelAdapters: [...stores.modelAdapter].map(([entryName]) => ({ name: entryName })),
  });
  const invoke = async (kind, entryName, args) => {
    const entry = stores[kind]?.get(entryName);
    if (!entry) throw new Error("Unknown sandbox contribution: " + kind + ":" + entryName);
    if (kind === "command") return entry.value(args[0], Object.freeze({ ...(args[1] || {}), signal }));
    if (kind === "tool") return entry.value.execute(args[0], signal, args[1]);
    if (kind === "hook") return entry.value(args[0], signal);
    if (kind === "modelAdapter") {
      const events = [];
      for await (const event of entry.value.stream(args[0])) events.push(event);
      return events;
    }
    throw new Error("Unsupported sandbox invocation kind: " + kind);
  };
  globalThis.__flavorSandbox = Object.freeze({
    async activate(fn) {
      const result = await fn(context);
      if (result !== undefined && typeof result !== "function") throw new Error("Plugin activate result must be a disposer or undefined");
      deactivate = result;
      accepting = false;
      return JSON.stringify(describe());
    },
    async invokeJson(kind, entryName, argsJson) {
      try { return JSON.stringify({ ok: true, value: await invoke(kind, entryName, JSON.parse(argsJson)) }); }
      catch (error) { return JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
    },
    async shutdown() { if (deactivate) await deactivate(); deactivate = undefined; },
  });
})();`;

interface LoadedSandbox { context: ReturnType<typeof createContext>; contributions: SandboxPluginContributions }

async function loadPlugin(pluginRoot: string, entryPath: string): Promise<LoadedSandbox> {
  const context = createContext(Object.create(null), {
    name: `flavor-plugin:${data.pluginName}`,
    codeGeneration: { strings: false, wasm: false },
  });
  (context as Record<string, unknown>).__flavorConfigJson = data.configJson;
  runInContext(SANDBOX_BOOTSTRAP, context, { timeout: 1_000 });
  const modules = new Map<string, SourceTextModule>();

  const getModule = async (input: string): Promise<SourceTextModule> => {
    const physical = await realpath(input);
    assertContained(pluginRoot, physical);
    const existing = modules.get(physical);
    if (existing !== undefined) return existing;
    const source = await readFile(physical, "utf8");
    if (Buffer.byteLength(source) > MAX_MODULE_BYTES) throw new Error(`Plugin module exceeds ${MAX_MODULE_BYTES} bytes`);
    const module = new SourceTextModule(source, {
      context,
      identifier: pathToFileURL(physical).href,
      initializeImportMeta(meta) { meta.url = pathToFileURL(physical).href; },
      importModuleDynamically: async (specifier, referencingModule) => {
        const imported = await resolveModule(specifier, referencingModule);
        if (imported.status === "unlinked") await imported.link(linker);
        if (imported.status === "linked") await imported.evaluate();
        return imported;
      },
    });
    modules.set(physical, module);
    return module;
  };
  const resolveModule = async (specifier: string, referencingModule: Module): Promise<SourceTextModule> => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) throw new Error(`Sandbox blocks external module import: ${specifier}`);
    return getModule(resolve(fileURLToPath(referencingModule.identifier), "..", specifier));
  };
  const linker = (specifier: string, referencingModule: Module): Promise<SourceTextModule> => resolveModule(specifier, referencingModule);

  const entry = await getModule(entryPath);
  await entry.link(linker);
  await entry.evaluate();
  const activate = (entry.namespace as Record<string, unknown>).activate;
  if (typeof activate !== "function") throw new Error("Plugin entry must export activate(context)");
  (context as Record<string, unknown>).__flavorActivate = activate;
  const contributionsJson = await runInContext(
    "globalThis.__flavorSandbox.activate(globalThis.__flavorActivate)", context,
  ) as string;
  return { context, contributions: JSON.parse(contributionsJson) as SandboxPluginContributions };
}

async function main(): Promise<void> {
  const pluginRoot = await realpath(data.pluginRoot);
  assertContained(pluginRoot, await realpath(data.entryPath));
  const loaded = await loadPlugin(pluginRoot, data.entryPath);
  const { contributions } = loaded;
  const result: SandboxedPluginResult = {
    ok: true, name: data.pluginName, version: data.pluginVersion,
    registeredTools: contributions.tools.map(({ name }) => name),
    registeredCommands: contributions.commands.map(({ name }) => name),
    registeredHooks: contributions.hooks.map(({ name }) => name),
    registeredSkillRoots: contributions.skillRoots.map(({ name }) => name),
    registeredModelAdapters: contributions.modelAdapters.map(({ name }) => name),
    contributions,
  };
  send({ type: "ready", result });
  port!.on("message", (raw: unknown) => { void handleMessage(raw, loaded.context); });
  clearInterval(activationKeepAlive);
}

async function handleMessage(raw: unknown, context: ReturnType<typeof createContext>): Promise<void> {
  if (typeof raw !== "object" || raw === null || !("type" in raw)) { send({ type: "fatal", error: "Invalid sandbox parent message" }); return; }
  const message = raw as SandboxParentMessage;
  if (message.type === "shutdown") {
    try { await runInContext("globalThis.__flavorSandbox.shutdown()", context); send({ type: "disposed" }); }
    catch (error) { send({ type: "fatal", error: `Plugin sandbox shutdown failed: ${errorMessage(error)}` }); }
    return;
  }
  if (message.type !== "invoke" || !Number.isSafeInteger(message.id) || typeof message.name !== "string"
    || typeof message.argsJson !== "string" || !["command", "tool", "hook", "modelAdapter"].includes(message.kind)) {
    send({ type: "fatal", error: "Invalid sandbox invocation message" }); return;
  }
  (context as Record<string, unknown>).__flavorKind = message.kind;
  (context as Record<string, unknown>).__flavorName = message.name;
  (context as Record<string, unknown>).__flavorArgs = message.argsJson;
  try {
    const responseJson = await runInContext(
      "globalThis.__flavorSandbox.invokeJson(globalThis.__flavorKind, globalThis.__flavorName, globalThis.__flavorArgs)", context,
    ) as string;
    const response = JSON.parse(responseJson) as { ok: boolean; value?: unknown; error?: string };
    if (response.ok) send({ type: "response", id: message.id, ok: true, valueJson: response.value === undefined ? "null" : JSON.stringify(response.value) });
    else send({ type: "response", id: message.id, ok: false, error: response.error ?? "Sandbox invocation failed" });
  } catch (error) { send({ type: "response", id: message.id, ok: false, error: errorMessage(error) }); }
}

main().catch((error) => { clearInterval(activationKeepAlive); send({ type: "fatal", error: errorMessage(error) }); });
