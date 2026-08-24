import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import type { SkillRegistry } from "./registry.js";
import { expandSkillArguments } from "./arguments.js";

const SkillInput = z.object({
  skill: z.string().min(1),
  arguments: z.string().optional(),
}).strict();

const SkillResourceInput = z.object({
  skill: z.string().min(1),
  reference: z.string().min(1),
}).strict();

export function createSkillTool(
  registry: SkillRegistry,
): ToolDefinition<z.infer<typeof SkillInput>> {
  return {
    name: "Skill",
    description: "Load another discovered skill by name so composable workflows can follow its complete instructions; optional arguments use Claude-compatible $ARGUMENTS substitution",
    inputSchema: SkillInput,
    readOnly: true,
    paths: () => [],
    summarize: ({ skill }) => skill,
    renderForModel: (output) => {
      const value = output as { skill: string; content: string };
      return `Matched skill: ${value.skill}\n${value.content}`;
    },
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const discovered = await registry.discover();
      const requested = input.skill.trim();
      const alias = requested.includes(":") ? requested.slice(requested.lastIndexOf(":") + 1) : requested;
      const skill = discovered.find((candidate) => candidate.name === requested)
        ?? discovered.find((candidate) => candidate.name === alias);
      if (skill === undefined) throw new Error(`Unknown skill: ${input.skill}`);
      const content = expandSkillArguments(await registry.loadBody(skill), input.arguments ?? "");
      signal.throwIfAborted();
      return { skill: skill.name, content };
    },
  };
}

export function createSkillResourceTool(
  registry: SkillRegistry,
): ToolDefinition<z.infer<typeof SkillResourceInput>> {
  return {
    name: "SkillResource",
    description: "Read a bounded resource explicitly referenced by a discovered skill; scripts are returned as data and never executed",
    inputSchema: SkillResourceInput,
    paths: () => [],
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const skill = (await registry.discover()).find((candidate) => candidate.name === input.skill);
      if (skill === undefined) throw new Error(`Unknown skill: ${input.skill}`);
      const capability = await registry.resolveResource(skill, input.reference);
      const content = await registry.readResource(capability);
      signal.throwIfAborted();
      const metadata = { skill: skill.name, reference: capability.displayPath, kind: capability.kind, size: content.length };
      try {
        return { ...metadata, encoding: "utf8", content: new TextDecoder("utf-8", { fatal: true }).decode(content) };
      } catch {
        return { ...metadata, encoding: "base64", content: content.toString("base64") };
      }
    },
  };
}
