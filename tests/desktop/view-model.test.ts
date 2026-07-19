import { describe, expect, it } from "vitest";

import { createTranscriptState, transcriptReducer } from "../../src/ui/transcript.js";
import { applyDesktopOutput, groupSessions, permissionLabel, sessionTitle, STARTER_PROMPTS } from "../../src/desktop/renderer/view-model.js";

describe("desktop renderer view model", () => {
  it("groups sessions into today, yesterday and earlier", () => {
    const groups = groupSessions([
      { sessionId: "today", createdAt: "2026-07-19T01:00:00Z", updatedAt: "2026-07-19T10:00:00Z", mainModel: "m" },
      { sessionId: "yesterday", createdAt: "2026-07-18T01:00:00Z", updatedAt: "2026-07-18T10:00:00Z", mainModel: "m" },
      { sessionId: "older", createdAt: "2026-07-01T01:00:00Z", updatedAt: "2026-07-01T10:00:00Z", mainModel: "m" },
    ], new Date("2026-07-19T12:00:00Z"));
    expect(groups.map((group) => [group.label, group.sessions.map((session) => session.sessionId)])).toEqual([
      ["今天", ["today"]], ["昨天", ["yesterday"]], ["更早", ["older"]],
    ]);
  });

  it("maps every runtime permission mode to concise Chinese copy", () => {
    expect(permissionLabel("default")).toBe("按需确认");
    expect(permissionLabel("acceptEdits")).toBe("自动编辑");
    expect(permissionLabel("plan")).toBe("只读规划");
    expect(permissionLabel("bypassPermissions")).toBe("完全访问");
    expect(permissionLabel("auto")).toBe("智能判断");
    expect(permissionLabel("bubble")).toBe("向上确认");
  });

  it("uses a useful session preview and completes transcript turns on done", () => {
    expect(sessionTitle({ sessionId: "session-20260719-abc", createdAt: "", updatedAt: "", mainModel: "m", preview: " 修复登录流程  " }))
      .toBe("修复登录流程");
    let state = transcriptReducer(createTranscriptState(), { type: "submit", prompt: "hello" });
    state = applyDesktopOutput(state, { type: "text", text: "world" });
    state = applyDesktopOutput(state, { type: "done", usage: { inputTokens: 1, outputTokens: 1 } });
    expect(state.active).toBeUndefined();
    expect(state.completed[0]?.assistantText).toBe("world");
  });

  it("provides three actionable starter prompts", () => {
    expect(STARTER_PROMPTS).toEqual(["梳理项目并给出改进方向", "帮我排查一个问题", "实现一个新功能"]);
  });
});
