import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import { EXPERT_AGENT_TEMPLATES, type ExpertAgentCreationKind } from "./expert-templates.js";

const AgentNameSchema = z.string().max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const AgentFrontmatterSchema = z.object({
  name: AgentNameSchema,
  description: z.string().trim().min(1),
  model: z.string().trim().min(3).optional(),
  tools: z.array(z.string().trim().min(1)).min(1).optional(),
  permission: z.enum(["standard", "readOnly"]).default("standard"),
  maxIterations: z.number().int().min(10).max(200).optional(),
}).strict();

export type ExpertAgent = z.infer<typeof AgentFrontmatterSchema> & {
  instructions: string;
  source: "global" | "project";
  path: string;
};

export interface ExpertAgentDiagnostic { path: string; message: string }
export type GeneratedExpertAgent = Pick<ExpertAgent, "description" | "permission" | "tools" | "maxIterations" | "instructions">;

/** Project definitions override global definitions with the same name. */
export class ExpertAgentRegistry {
  readonly #roots: readonly { path: string; source: ExpertAgent["source"] }[];
  readonly #workspace: string;
  #agents = new Map<string, ExpertAgent>();
  #diagnostics: ExpertAgentDiagnostic[] = [];

  constructor(home: string, workspace: string) {
    this.#workspace = workspace;
    this.#roots = [
      { path: join(home, ".flavor-code", "agents"), source: "global" },
      { path: join(workspace, ".flavor", "agents"), source: "project" },
    ];
  }

  get diagnostics(): readonly ExpertAgentDiagnostic[] { return [...this.#diagnostics]; }

  async assertAvailable(name: string): Promise<void> {
    validateAgentName(name);
    const path = join(this.#workspace, ".flavor", "agents", `${name}.md`);
    try {
      await lstat(path);
      throw new Error(`Agent ${name} already exists at ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async create(name: string, kind: ExpertAgentCreationKind, description?: string, readOnly = false): Promise<ExpertAgent> {
    if (kind === "custom") throw new Error("Custom agents must be generated from the configured model");
    const template = EXPERT_AGENT_TEMPLATES[kind];
    if (template === undefined) throw new Error(`Unknown agent template: ${kind}`);
    const focus = description?.replace(/\s+/gu, " ").trim();
    if (focus !== undefined && focus.length > 500) throw new Error("Agent description must be at most 500 characters");
    if (readOnly) throw new Error("--read-only is only available for custom agents");
    return this.#write(name, {
      description: focus || template.description, permission: template.permission,
      tools: [...template.tools], maxIterations: template.maxIterations,
      instructions: `${focus ? `Focus: ${focus}\n\n` : ""}${template.instructions}`,
    });
  }

  async createGenerated(name: string, generated: GeneratedExpertAgent): Promise<ExpertAgent> {
    const metadata = AgentFrontmatterSchema.parse({
      name, description: generated.description, permission: generated.permission,
      tools: generated.tools, maxIterations: generated.maxIterations,
    });
    if (!metadata.tools || new Set(metadata.tools).size !== metadata.tools.length) {
      throw new Error("Generated agent tools must be unique and nonempty");
    }
    if (generated.instructions.trim().length < 100) throw new Error("Generated agent instructions are too short");
    return this.#write(name, { ...metadata, instructions: generated.instructions });
  }

  async #write(name: string, draft: GeneratedExpertAgent): Promise<ExpertAgent> {
    validateAgentName(name);
    const projectRoot = join(this.#workspace, ".flavor");
    try {
      const stat = await lstat(projectRoot);
      if (!stat.isDirectory()) throw new Error(".flavor must be a directory, not a symlink or file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const root = join(projectRoot, "agents");
    await mkdir(root, { recursive: true });
    const stat = await lstat(root);
    if (!stat.isDirectory()) throw new Error("Agent root must be a directory, not a symlink or file");
    const physicalWorkspace = await realpath(this.#workspace);
    const physicalRoot = await realpath(root);
    const within = relative(physicalWorkspace, physicalRoot);
    if (within === ".." || within.startsWith(`..${sep}`) || within.startsWith(sep)) {
      throw new Error("Agent root escapes the workspace");
    }
    const { instructions, ...metadata } = draft;
    const content = `---\n${stringify({ name, ...metadata })}---\n\n${instructions.trim()}\n`;
    const path = join(root, `${name}.md`);
    try {
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Agent ${name} already exists at ${path}`);
      }
      throw error;
    }
    return this.get(name);
  }

  async discover(): Promise<readonly ExpertAgent[]> {
    const agents = new Map<string, ExpertAgent>();
    const diagnostics: ExpertAgentDiagnostic[] = [];
    for (const root of this.#roots) {
      let entries;
      try {
        const stat = await lstat(root.path);
        if (!stat.isDirectory()) throw new Error("Agent root must be a directory, not a symlink or file");
        entries = await readdir(root.path, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        diagnostics.push({ path: root.path, message: errorMessage(error) });
        continue;
      }
      for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        const path = join(root.path, entry.name);
        try {
          if (!entry.isFile()) throw new Error("Agent definition must be a regular file");
          const stat = await lstat(path);
          if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Agent definition must be a regular file of at most 64 KiB");
          const physicalRoot = await realpath(root.path);
          const physicalPath = await realpath(path);
          const within = relative(physicalRoot, physicalPath);
          if (within.startsWith(`..${sep}`) || within === ".." || within.startsWith(sep)) {
            throw new Error("Agent definition escapes its root");
          }
          const agent = parseAgent(await readFile(path, "utf8"), path, root.source);
          agents.set(agent.name, agent);
        } catch (error) {
          diagnostics.push({ path, message: errorMessage(error) });
        }
      }
    }
    this.#agents = agents;
    this.#diagnostics = diagnostics;
    return [...agents.values()];
  }

  async get(name: string): Promise<ExpertAgent> {
    if (!AgentNameSchema.safeParse(name).success) throw new Error(`Invalid agent name: ${name}`);
    await this.discover();
    const agent = this.#agents.get(name);
    if (agent !== undefined) return agent;
    const diagnostic = this.#diagnostics.find((item) => basename(item.path) === `${name}.md`);
    throw new Error(diagnostic === undefined ? `Unknown agent: ${name}` : `Invalid agent ${name}: ${diagnostic.message}`);
  }
}

function validateAgentName(name: string): void {
  if (!AgentNameSchema.safeParse(name).success || ["list", "create", "templates"].includes(name)) {
    throw new Error(`Invalid agent name: ${name}`);
  }
}

function parseAgent(content: string, path: string, source: ExpertAgent["source"]): ExpertAgent {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(content);
  if (match === null) throw new Error("Agent file must start with YAML frontmatter");
  const document = parseDocument(match[1]!, { uniqueKeys: true });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error(`Invalid YAML frontmatter: ${document.errors[0]?.message ?? document.warnings[0]?.message}`);
  }
  const metadata = AgentFrontmatterSchema.parse(document.toJS({ maxAliasCount: 0 }));
  if (metadata.name !== basename(path, ".md")) throw new Error("Agent filename must match its name");
  if (metadata.model !== undefined) {
    const separator = metadata.model.indexOf(":");
    if (separator <= 0 || separator === metadata.model.length - 1) throw new Error("Agent model must be provider:model");
  }
  const instructions = match[2]!.trim();
  if (instructions.length === 0) throw new Error("Agent instructions must not be empty");
  if (metadata.tools !== undefined && new Set(metadata.tools).size !== metadata.tools.length) {
    throw new Error("Agent tools must not contain duplicates");
  }
  return { ...metadata, instructions, path, source };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
