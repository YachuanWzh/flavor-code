import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { GoalStateSchema, type GoalState } from "../goal/types.js";
import { SessionStore } from "../session/store.js";
import { redactErrorText } from "../utils/redact.js";

const MAX_TEXT = 128_000;
const MAX_ITEMS = 200;

export interface DesktopInstructionFile { name: string; path: string; content: string }
export interface DesktopPermissionFile { tier: "managed" | "user" | "project" | "local"; path: string; content: string }
export interface DesktopWorkbenchInspection {
  goals: readonly GoalState[];
  instructions: readonly DesktopInstructionFile[];
  permissionFiles: readonly DesktopPermissionFile[];
  audit: readonly Record<string, unknown>[];
  context?: { epoch?: unknown; visibility: readonly unknown[]; usage: readonly Record<string, unknown>[] };
}

export class DesktopWorkbenchService {
  readonly #workspace: string;
  readonly #home: string;

  constructor(workspace: string, home = homedir()) {
    this.#workspace = resolve(workspace);
    this.#home = resolve(home);
  }

  async inspect(sessionId?: string): Promise<DesktopWorkbenchInspection> {
    const [goals, instructions, permissionFiles, audit, context] = await Promise.all([
      this.#goals(), this.#instructions(), this.#permissionFiles(), this.#audit(), this.#context(sessionId),
    ]);
    return { goals, instructions, permissionFiles, audit, ...(context === undefined ? {} : { context }) };
  }

  static normalizePreviewUrl(input: string): string {
    let url: URL;
    try { url = new URL(input.trim()); }
    catch { throw new Error("Preview URL must be a valid loopback HTTP(S) URL"); }
    if (!["http:", "https:"].includes(url.protocol)
      || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase())
      || url.username !== "" || url.password !== "") {
      throw new Error("Preview URL must use a loopback HTTP(S) origin");
    }
    return url.toString().replace(/\/$/, input.trim().endsWith("/") ? "/" : "");
  }

  async #goals(): Promise<GoalState[]> {
    const root = join(this.#workspace, ".flavor", "goals");
    const names = await readdir(root).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
    const values = await Promise.all(names.filter((name) => /^goal-[A-Za-z0-9._-]+\.json$/.test(name)).slice(0, MAX_ITEMS).map(async (name) => {
      try { return GoalStateSchema.parse(JSON.parse(await boundedRead(join(root, name)))); }
      catch { return undefined; }
    }));
    return values.filter((item): item is GoalState => item !== undefined)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async #instructions(): Promise<DesktopInstructionFile[]> {
    const names = ["FLAVOR.md", "AGENTS.md", "CLAUDE.md", "AGENTS.local.md", "CLAUDE.local.md"];
    const items = await Promise.all(names.map(async (name) => {
      const path = join(this.#workspace, name);
      try { return { name, path, content: redactErrorText(await boundedRead(path)) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return items.filter((item): item is DesktopInstructionFile => item !== undefined);
  }

  async #permissionFiles(): Promise<DesktopPermissionFile[]> {
    const candidates: DesktopPermissionFile[] = [
      ...(process.env.FLAVOR_MANAGED_PERMISSIONS ? [{ tier: "managed" as const, path: resolve(process.env.FLAVOR_MANAGED_PERMISSIONS), content: "" }] : []),
      { tier: "user", path: join(this.#home, ".flavor-code", "permissions.json"), content: "" },
      { tier: "project", path: join(this.#workspace, ".flavor", "permissions.json"), content: "" },
      { tier: "local", path: join(this.#workspace, ".flavor", "permissions.local.json"), content: "" },
    ];
    const values = await Promise.all(candidates.map(async (item) => {
      try { return { ...item, content: redactErrorText(await boundedRead(item.path)) }; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    }));
    return values.filter((item): item is DesktopPermissionFile => item !== undefined);
  }

  async #audit(): Promise<Record<string, unknown>[]> {
    let raw: string;
    try { raw = await boundedRead(join(this.#workspace, ".flavor", "audit.jsonl")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return raw.split(/\r?\n/).filter(Boolean).slice(-MAX_ITEMS).flatMap((line) => {
      try {
        const value: unknown = JSON.parse(line);
        return typeof value === "object" && value !== null && !Array.isArray(value) ? [redact(value) as Record<string, unknown>] : [];
      } catch { return []; }
    }).reverse();
  }

  async #context(sessionId: string | undefined): Promise<DesktopWorkbenchInspection["context"]> {
    const usage = await readJsonLines(join(this.#workspace, ".flavor", "usage.jsonl"));
    if (sessionId === undefined) return { visibility: [], usage };
    try {
      const document = await new SessionStore({ workspace: this.#workspace }).load(sessionId);
      return { ...(document.conversation.epoch === undefined ? {} : { epoch: redact(document.conversation.epoch) }), visibility: (document.conversation.visibilityLog ?? []).slice(-MAX_ITEMS).map((item) => redact(item)), usage };
    } catch { return { visibility: [], usage }; }
  }
}

async function boundedRead(path: string): Promise<string> {
  const info = await stat(path);
  if (!info.isFile()) throw new Error(`Expected a file: ${path}`);
  if (info.size > MAX_TEXT) throw new Error(`Workbench file exceeds ${MAX_TEXT} bytes: ${path}`);
  return readFile(path, "utf8");
}

async function readJsonLines(path: string): Promise<Record<string, unknown>[]> {
  try { return (await boundedRead(path)).split(/\r?\n/).filter(Boolean).slice(-MAX_ITEMS).flatMap((line) => { try { const value: unknown = JSON.parse(line); return typeof value === "object" && value !== null && !Array.isArray(value) ? [redact(value) as Record<string, unknown>] : []; } catch { return []; } }).reverse(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function redact(value: unknown, key = ""): unknown {
  if (/token|secret|password|authorization|api[-_]?key/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map((item) => redact(item));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).slice(0, MAX_ITEMS).map(([name, item]) => [name, redact(item, name)]));
  return typeof value === "string" && value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}
