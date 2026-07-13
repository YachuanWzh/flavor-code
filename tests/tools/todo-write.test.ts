import { describe, expect, it } from "vitest";

import { createTodoWriteTool } from "../../src/tools/todo-write.js";

describe("TodoWrite tool", () => {
  it("returns a structured snapshot of the todo list", async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: "Read the task description", status: "completed", activeForm: "Reading the task description" },
          { content: "Implement the feature", status: "in_progress", activeForm: "Implementing the feature" },
          { content: "Write tests", status: "pending", activeForm: "Writing tests" },
        ],
      },
      new AbortController().signal,
    );

    const r = result as Record<string, unknown>;

    expect(r.todoCount).toBe(3);
    expect(r.byStatus).toEqual({ completed: 1, in_progress: 1, pending: 1 });
    expect((r.todos as unknown[])).toHaveLength(3);
  });

  it("rejects more than one in_progress todo", async () => {
    const tool = createTodoWriteTool();
    await expect(
      tool.execute(
        {
          todos: [
            { content: "Task A", status: "in_progress", activeForm: "Working on Task A" },
            { content: "Task B", status: "in_progress", activeForm: "Working on Task B" },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/only one todo/i);
  });

  it("accepts a single item", async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [{ content: "Solo task", status: "in_progress", activeForm: "Working on solo task" }],
      },
      new AbortController().signal,
    );
    const r = result as Record<string, unknown>;
    expect(r.todoCount).toBe(1);
    expect(r.byStatus).toEqual({ in_progress: 1 });
  });

  it("rejects empty todos array", async () => {
    const tool = createTodoWriteTool();
    const parsed = tool.inputSchema.safeParse({ todos: [] });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty todo content", async () => {
    const tool = createTodoWriteTool();
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "", status: "pending", activeForm: "Working" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects empty activeForm", async () => {
    const tool = createTodoWriteTool();
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "ok", status: "pending", activeForm: "" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects invalid status", async () => {
    const tool = createTodoWriteTool();
    const parsed = tool.inputSchema.safeParse({
      todos: [{ content: "ok", status: "unknown_status", activeForm: "Working" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("allows all valid statuses", async () => {
    const tool = createTodoWriteTool();
    const result = await tool.execute(
      {
        todos: [
          { content: "A", status: "pending", activeForm: "Pending" },
          { content: "B", status: "in_progress", activeForm: "In progress" },
          { content: "C", status: "completed", activeForm: "Completed" },
          { content: "D", status: "cancelled", activeForm: "Cancelled" },
        ],
      },
      new AbortController().signal,
    );
    const r = result as Record<string, unknown>;
    expect(r.byStatus).toEqual({ pending: 1, in_progress: 1, completed: 1, cancelled: 1 });
  });

  it("exposes name and paths correctly", () => {
    const tool = createTodoWriteTool();
    expect(tool.name).toBe("TodoWrite");
    expect(tool.paths({ todos: [{ content: "x", status: "pending", activeForm: "Working" }] })).toEqual([]);
  });
});
