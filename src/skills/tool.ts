import { z } from "zod";

import type { ToolDefinition } from "../tools/types.js";
import type { SkillRegistry } from "./registry.js";

const SkillResourceInput = z.object({
  skill: z.string().min(1),
  reference: z.string().min(1),
}).strict();

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
