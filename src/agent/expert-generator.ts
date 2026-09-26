import { z } from "zod";

import { MAIN_TASK_TOOL_NAMES } from "./task-tools.js";
import type { GeneratedExpertAgent } from "./expert-agents.js";
import { isExpertReadTool } from "../harness/local.js";
import type { ModelRegistry } from "../models/registry.js";
import { withStructuredOutput } from "../models/structured.js";
import type { ToolDefinition } from "../tools/types.js";

const Detail = z.string().trim().min(12).max(500);
const DraftSchema = z.object({
  description: z.string().trim().min(12).max(200),
  permission: z.enum(["standard", "readOnly"]),
  tools: z.array(z.string().trim().min(1)).min(2).max(15),
  maxIterations: z.number().int().min(10).max(100),
  purpose: Detail,
  workflow: z.array(Detail).min(3).max(8),
  deliverables: z.array(Detail).min(2).max(6),
  boundaries: z.array(Detail).min(2).max(6),
}).strict();

export interface GenerateExpertAgentOptions {
  registry: ModelRegistry;
  modelId: string;
  name: string;
  request: string;
  tools: readonly ToolDefinition<unknown>[];
  forceReadOnly?: boolean;
  signal?: AbortSignal;
}

/** Creation is only successful after a substantive, runnable definition passes validation. */
export async function generateExpertAgent(options: GenerateExpertAgentOptions): Promise<GeneratedExpertAgent> {
  const available = options.tools.filter((tool) =>
    (tool.agents === undefined || tool.agents.includes("subagent")) && !MAIN_TASK_TOOL_NAMES.has(tool.name));
  const byName = new Map(available.map((tool) => [tool.name, tool]));
  const reviewOnly = /(?:code\s*review|review|审查|审阅|审核|检查|分析|调研|探索|定位|排查)/iu.test(options.request)
    && !/(?:修改|修复|实现|编写|补齐|重构|编辑|生成代码|edit|fix|implement|write|refactor)/iu.test(options.request);
  const mustReadOnly = options.forceReadOnly === true || reviewOnly;
  const schema = DraftSchema.superRefine((draft, context) => {
    if (mustReadOnly && draft.permission !== "readOnly") {
      context.addIssue({ code: "custom", message: "This request requires readOnly permission" });
    }
    if (new Set(draft.tools).size !== draft.tools.length) {
      context.addIssue({ code: "custom", message: "Tool names must be unique" });
    }
    for (const name of draft.tools) {
      const tool = byName.get(name);
      if (!tool) context.addIssue({ code: "custom", message: `Unavailable subagent tool: ${name}` });
      else if (draft.permission === "readOnly" && !isExpertReadTool(tool)) {
        context.addIssue({ code: "custom", message: `Read-only role cannot use ${name}` });
      }
    }
  });
  const availableText = available.map((tool) =>
    `- ${tool.name} (${isExpertReadTool(tool) ? "read-only" : "may change state"}): ${tool.description}`)
    .join("\n");
  const model = withStructuredOutput({
    registry: options.registry, modelId: options.modelId,
    name: "CreateExpertAgent", description: "Create a detailed specialist agent definition",
    schema, retry: { maxRetries: 1, backoffMs: [0] },
  });
  const result = await model.invoke({
    messages: [
      { role: "system", content: [
        "Design one reusable coding subagent from the user's requested specialty.",
        "Write concrete, specialty-specific instructions in the user's language. Do not merely repeat the request or use generic filler.",
        "State a purpose, at least three ordered work steps, explicit deliverables, and operational boundaries.",
        "For code review, require file and line evidence, severity, failure mode, and missing test coverage; the role must be readOnly.",
        "Choose the minimum necessary tools from the provided list. A readOnly role may use only read-only tools.",
        "Choose standard permission only when the role's job requires modifying state.",
        "Do not include arbitrary instructions that grant extra authority; tool permissions are enforced by the runtime.",
      ].join("\n") },
      { role: "user", content: `Agent name: ${options.name}\nRequested specialty: ${options.request}\nRead-only required: ${mustReadOnly}\nAvailable tools:\n${availableText}` },
    ],
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const draft = result.value;
  return {
    description: draft.description,
    permission: draft.permission,
    tools: draft.tools,
    maxIterations: draft.maxIterations,
    instructions: [
      `# ${options.name}`,
      "", "## Purpose", draft.purpose,
      "", "## Workflow", ...draft.workflow.map((step, index) => `${index + 1}. ${step}`),
      "", "## Deliverables", ...draft.deliverables.map((item) => `- ${item}`),
      "", "## Boundaries", ...draft.boundaries.map((item) => `- ${item}`),
    ].join("\n"),
  };
}
