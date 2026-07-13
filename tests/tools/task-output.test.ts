import { describe, expect, it } from "vitest";

import { createTaskOutputTool } from "../../src/tools/task-output.js";

describe("TaskOutput tool", () => {
  it("returns a structured completion result", async () => {
    const tool = createTaskOutputTool();
    const result = await tool.execute(
      {
        summary: "Implemented the cache layer",
        filesChanged: ["src/cache.ts", "tests/cache.test.ts"],
        commandsRun: [
          { command: "npm test", exitCode: 0, summary: "All tests passed" },
        ],
        verification: [
          { name: "unit test coverage", passed: true, details: "All 12 tests pass" },
          { name: "performance", passed: true, details: "P99 latency under 5ms" },
        ],
        artifacts: ["cache.tar.gz"],
        risks: ["Memory pressure under heavy load"],
        suggestedNextSteps: ["Add documentation", "Run integration tests"],
      },
      new AbortController().signal,
    );

    expect(result).toEqual({
      taskCompleted: true,
      summary: "Implemented the cache layer",
      filesChanged: ["src/cache.ts", "tests/cache.test.ts"],
      commandsRun: [
        { command: "npm test", exitCode: 0, summary: "All tests passed" },
      ],
      verification: [
        { name: "unit test coverage", passed: true, details: "All 12 tests pass" },
        { name: "performance", passed: true, details: "P99 latency under 5ms" },
      ],
      artifacts: ["cache.tar.gz"],
      risks: ["Memory pressure under heavy load"],
      suggestedNextSteps: ["Add documentation", "Run integration tests"],
    });
  });

  it("accepts null exitCode for commands that didn't complete", async () => {
    const tool = createTaskOutputTool();
    const result = await tool.execute(
      {
        summary: "Partial work",
        filesChanged: [],
        commandsRun: [{ command: "npm build", exitCode: null, summary: "Timed out" }],
        verification: [],
        artifacts: [],
        risks: [],
        suggestedNextSteps: [],
      },
      new AbortController().signal,
    );
    expect((result as Record<string, unknown>).commandsRun).toBeDefined();
  });

  it("rejects empty required fields", async () => {
    const tool = createTaskOutputTool();
    const r1 = tool.inputSchema.safeParse({
      summary: "",
      filesChanged: [],
      commandsRun: [],
      verification: [],
      artifacts: [],
      risks: [],
      suggestedNextSteps: [],
    });
    expect(r1.success).toBe(false);
  });

  it("exposes name and paths correctly", () => {
    const tool = createTaskOutputTool();
    expect(tool.name).toBe("TaskOutput");
    expect(tool.paths({
      summary: "x", filesChanged: [], commandsRun: [], verification: [],
      artifacts: [], risks: [], suggestedNextSteps: [],
    })).toEqual([]);
  });

  it("rejects when verification item name is empty", async () => {
    const tool = createTaskOutputTool();
    const result = tool.inputSchema.safeParse({
      summary: "done",
      filesChanged: [],
      commandsRun: [],
      verification: [{ name: "", passed: true, details: "ok" }],
      artifacts: [],
      risks: [],
      suggestedNextSteps: [],
    });
    expect(result.success).toBe(false);
  });
});
