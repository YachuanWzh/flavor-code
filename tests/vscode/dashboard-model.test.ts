import { describe, expect, it } from "vitest";

import { DashboardModel, extractFileReferences } from "../../extensions/vscode/src/dashboard-model.js";

describe("VS Code dashboard model", () => {
  it("tracks plan, subagents, usage, and run phase", () => {
    const model = new DashboardModel();
    model.setConnection(true, "session-1");
    model.accept({
      type: "tasks",
      snapshot: {
        plan: { tasks: [{ id: "one", subject: "Fix parser", activeForm: "Fixing parser", status: "in_progress" }] },
        subagents: {
          graph: { nodes: [{ id: "review", description: "Review the parser" }] },
          states: { review: "running" },
        },
      },
    });
    model.accept({ type: "usage", totalInputTokens: 120, totalOutputTokens: 30 });

    expect(model.snapshot()).toMatchObject({
      connected: true,
      sessionId: "session-1",
      tasks: [{ id: "one", label: "Fixing parser", status: "in_progress" }],
      agents: [{ id: "review", label: "Review the parser", status: "running" }],
      inputTokens: 120,
      outputTokens: 30,
    });
  });

  it("records the most recent action for files touched by tools", () => {
    const model = new DashboardModel();
    model.accept({ type: "tool-start", name: "Read", input: { file_path: "src/old.ts", path: "src/app.ts" } });
    model.accept({ type: "tool-start", name: "Edit", input: { path: "src/app.ts" } });

    expect(model.snapshot().footprints).toEqual([
      { path: "src/app.ts", action: "changed", tool: "Edit" },
    ]);
  });

  it("keeps terminal-started Flavor sessions visible without an RPC client", () => {
    const model = new DashboardModel();
    model.setExternalSessions([{ sessionId: "terminal-one" }]);

    expect(model.snapshot()).toMatchObject({
      connected: true,
      connectionMode: "terminal",
      externalSessionCount: 1,
      sessionId: "terminal-one",
    });

    model.setConnection(true, "rpc-one");
    expect(model.snapshot()).toMatchObject({ connectionMode: "both", sessionId: "rpc-one" });
  });

  it("extracts bounded nested file references", () => {
    expect(extractFileReferences({
      input: { filePath: "C:\\work\\src\\app.ts" },
      result: [{ relativePath: "tests/app.test.ts" }],
      message: "not-a-file",
    })).toEqual(["C:/work/src/app.ts", "tests/app.test.ts"]);
  });
});
