import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { stringify } from "yaml";

import { loadConfig, setProjectSkillDisabled } from "../config/load.js";
import { SkillNameSchema } from "../config/schema.js";
import { SkillRegistry, type SkillMetadata, type SkillSource } from "./registry.js";
import { PluginManifestSchema } from "../plugins/types.js";

export interface ManagedSkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly root: string;
  readonly enabled: boolean;
  readonly editable: boolean;
  readonly disableModelInvocation: boolean;
}

export interface ManagedSkill extends ManagedSkillSummary {
  readonly body: string;
}

export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly disableModelInvocation?: boolean;
}

export interface SkillManagerOptions {
  workspace: string;
  home?: string;
}

export class SkillManager {
  readonly #workspace: string;
  readonly #home: string;

  constructor(options: SkillManagerOptions) {
    this.#workspace = resolve(options.workspace);
    this.#home = resolve(options.home ?? homedir());
  }

  async list(): Promise<readonly ManagedSkillSummary[]> {
    const { registry, disabled } = await this.#registry();
    return Promise.all((await registry.discover()).map((metadata) => this.#summary(metadata, disabled)));
  }

  async get(name: string): Promise<ManagedSkill> {
    const validName = parseName(name);
    const { registry, disabled } = await this.#registry();
    const metadata = (await registry.discover()).find((skill) => skill.name === validName);
    if (metadata === undefined) throw new Error(`Skill not found: ${validName}`);
    return { ...await this.#summary(metadata, disabled), body: await registry.loadBody(metadata) };
  }

  async create(draft: SkillDraft): Promise<ManagedSkill> {
    const value = parseDraft(draft);
    const projectRoot = this.#projectRoot();
    const directory = join(projectRoot, value.name);
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (isCode(error, "EEXIST")) throw new Error(`A project skill named "${value.name}" already exists`);
      throw error;
    }
    try {
      await writeFile(join(directory, "SKILL.md"), renderSkill(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await this.#persistEnabled(value.name, true);
      return this.get(value.name);
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async update(name: string, draft: SkillDraft): Promise<ManagedSkill> {
    const validName = parseName(name);
    const value = parseDraft(draft);
    if (value.name !== validName) throw new Error("Rename is not supported; create a new skill instead");
    const directory = this.#projectSkillDirectory(validName);
    const info = await lstat(directory).catch((error) => {
      if (isCode(error, "ENOENT")) throw new Error(`Project skill not found: ${validName}`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Project skill path is not a real directory: ${validName}`);
    const skillFile = join(directory, "SKILL.md");
    const fileInfo = await lstat(skillFile);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw new Error(`Project skill file is not a real file: ${validName}`);
    await writeFile(skillFile, renderSkill(value), { encoding: "utf8", mode: 0o600 });
    return this.get(validName);
  }

  async delete(name: string): Promise<void> {
    const validName = parseName(name);
    const directory = this.#projectSkillDirectory(validName);
    const info = await lstat(directory).catch((error) => {
      if (isCode(error, "ENOENT")) throw new Error(`Project skill not found: ${validName}`);
      throw error;
    });
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Project skill path is not a real directory: ${validName}`);
    await rm(directory, { recursive: true });
    await this.#persistEnabled(validName, true);
  }

  async setEnabled(name: string, enabled: boolean): Promise<void> {
    const validName = parseName(name);
    const { registry } = await this.#registry();
    if (!(await registry.discover()).some((skill) => skill.name === validName)) {
      throw new Error(`Skill not found: ${validName}`);
    }
    await this.#persistEnabled(validName, enabled);
  }

  async #persistEnabled(validName: string, enabled: boolean): Promise<void> {
    const loaded = await loadConfig({ cwd: this.#workspace, home: this.#home });
    await setProjectSkillDisabled(this.#workspace, validName, !enabled, loaded.config.skills.disabled);
  }

  async #registry(): Promise<{ registry: SkillRegistry; disabled: ReadonlySet<string> }> {
    const loaded = await loadConfig({ cwd: this.#workspace, home: this.#home });
    const [globalPluginRoots, projectPluginRoots] = await Promise.all([
      discoverPluginSkillRoots(join(this.#home, ".flavor-code", "plugins")),
      discoverPluginSkillRoots(join(this.#workspace, ".flavor", "plugins")),
    ]);
    return {
      registry: new SkillRegistry({
        globalRoots: [join(this.#home, ".flavor-code", "skills"), ...globalPluginRoots],
        projectRoots: [this.#projectRoot(), ...projectPluginRoots],
      }),
      disabled: new Set(loaded.config.skills.disabled),
    };
  }

  async #summary(metadata: SkillMetadata, disabled: ReadonlySet<string>): Promise<ManagedSkillSummary> {
    const expected = this.#projectSkillDirectory(metadata.name);
    const editable = metadata.source === "project"
      && await realpath(expected).then((physical) => physical === metadata.root).catch(() => false);
    return {
      ...metadata,
      enabled: !disabled.has(metadata.name),
      editable,
    };
  }

  #projectRoot(): string { return join(this.#workspace, ".flavor", "skills"); }
  #projectSkillDirectory(name: string): string { return join(this.#projectRoot(), name); }
}

function parseName(value: string): string {
  return SkillNameSchema.parse(value.trim());
}

function parseDraft(draft: SkillDraft): Required<SkillDraft> {
  const name = parseName(draft.name);
  const description = draft.description.trim();
  const body = draft.body.replace(/\r\n/g, "\n").trim();
  if (description.length === 0 || description.length > 4_000) throw new Error("Skill description must be between 1 and 4,000 characters");
  if (body.length === 0 || Buffer.byteLength(body, "utf8") > 256 * 1024) throw new Error("Skill instructions must be between 1 byte and 256 KiB");
  return { name, description, body, disableModelInvocation: draft.disableModelInvocation ?? false };
}

function renderSkill(draft: Required<SkillDraft>): string {
  const frontmatter = stringify({
    name: draft.name,
    description: draft.description,
    "disable-model-invocation": draft.disableModelInvocation,
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${draft.body}\n`;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

async function discoverPluginSkillRoots(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (isCode(error, "ENOENT")) return []; throw error; }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const pluginRoot = await realpath(join(directory, entry.name));
    try {
      const manifest = PluginManifestSchema.parse(JSON.parse(await readFile(join(pluginRoot, "flavor-plugin.json"), "utf8")));
      for (const contribution of manifest.contributes.skillRoots) {
        const candidate = resolve(pluginRoot, contribution.path);
        const info = await lstat(candidate);
        if (!info.isDirectory() || info.isSymbolicLink()) continue;
        const physical = await realpath(candidate);
        const relation = relative(pluginRoot, physical);
        if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) continue;
        roots.push(physical);
      }
    } catch {
      // Invalid plugins are reported by PluginHost; the skill manager simply omits them.
    }
  }
  return roots;
}
