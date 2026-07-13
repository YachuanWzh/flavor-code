import { z } from "zod";
import type { ToolDefinition } from "./types.js";

const CommandRunSchema = z.object({
  command: z.string().trim().min(1),
  exitCode: z.number().int().nullable(),
  summary: z.string().trim().min(1),
});

const VerificationItemSchema = z.object({
  name: z.string().trim().min(1),
  passed: z.boolean(),
  details: z.string().trim().min(1),
});

const TaskOutputInput = z.object({
  summary: z.string().trim().min(1),
  filesChanged: z.array(z.string().trim().min(1)),
  commandsRun: z.array(CommandRunSchema),
  verification: z.array(VerificationItemSchema),
  artifacts: z.array(z.string().trim().min(1)),
  risks: z.array(z.string().trim().min(1)),
  suggestedNextSteps: z.array(z.string().trim().min(1)),
});

export const TaskOutputResultSchema = TaskOutputInput.extend({
  taskCompleted: z.literal(true),
}).strict();

export type TaskOutputInput = z.infer<typeof TaskOutputInput>;
export type TaskOutputResult = z.infer<typeof TaskOutputResultSchema>;
export type CommandRun = z.infer<typeof CommandRunSchema>;
export type VerificationItem = z.infer<typeof VerificationItemSchema>;

export function createTaskOutputTool(): ToolDefinition<TaskOutputInput> {
  return {
    name: "TaskOutput",
    description:
      "Produce a structured result that summarises task completion. Use this when a subagent has finished its work to report what was accomplished, what files were changed, which commands were run, verification results, and any risks or next steps. The main agent can also use this to produce a structured completion summary.",
    inputSchema: TaskOutputInput,
    paths: () => [],
    summarize: (input) => input.summary,
    execute: async (input) => TaskOutputResultSchema.parse({
        taskCompleted: true,
        summary: input.summary,
        filesChanged: input.filesChanged,
        commandsRun: input.commandsRun,
        verification: input.verification,
        artifacts: input.artifacts,
        risks: input.risks,
        suggestedNextSteps: input.suggestedNextSteps,
      }),
  };
}
