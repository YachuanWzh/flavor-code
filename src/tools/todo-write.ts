import { z } from "zod";
import type { ToolDefinition } from "./types.js";

export const TodoStatusSchema = z.enum([
  "pending",
  "in_progress",
  "completed",
  "cancelled",
]);

export const TodoItemSchema = z.object({
  content: z.string().trim().min(1),
  status: TodoStatusSchema,
  activeForm: z.string().trim().min(1),
});

const TodoWriteInput = z.object({
  todos: z.array(TodoItemSchema).min(1).max(50),
});

export type TodoStatus = z.infer<typeof TodoStatusSchema>;
export type TodoItem = z.infer<typeof TodoItemSchema>;
export type TodoWriteInput = z.infer<typeof TodoWriteInput>;

export function createTodoWriteTool(): ToolDefinition<TodoWriteInput> {
  return {
    name: "TodoWrite",
    description:
      "Write and update a structured task list to track your own progress during a complex implementation. Use this to plan sub-steps, mark them in_progress one at a time, and mark them completed as you finish. This helps you stay organised and demonstrates thoroughness. Only one todo may be in_progress at a time. The activeForm field is a present-progressive verb phrase describing the current action (e.g. 'Implementing the cache layer').",
    inputSchema: TodoWriteInput,
    paths: () => [],
    summarize: (input) => {
      const total = input.todos.length;
      const done = input.todos.filter((t) => t.status === "completed").length;
      const active = input.todos.find((t) => t.status === "in_progress");
      const head = `${done}/${total} done`;
      return active === undefined ? head : `${head} · ${active.activeForm}`;
    },
    execute: async (input) => {
      // Validate at most one in_progress.
      const active = input.todos.filter((t) => t.status === "in_progress");
      if (active.length > 1) {
        throw new Error("Only one todo may be in_progress at a time");
      }
      // Return a structured snapshot so the model can verify its state.
      const byStatus: Record<string, number> = {};
      for (const item of input.todos) {
        byStatus[item.status] = (byStatus[item.status] ?? 0) + 1;
      }
      return {
        todoCount: input.todos.length,
        byStatus,
        todos: input.todos,
      };
    },
  };
}
