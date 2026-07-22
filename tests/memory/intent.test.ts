import { describe, expect, it } from "vitest";

import { isExplicitMemoryIntent } from "../../src/memory/intent.js";

describe("explicit memory intent", () => {
  it.each([
    "请记住这个项目统一使用 pnpm。",
    "帮我记住：不要自动提交代码",
    "这点要记住，以后先给结论。",
    "把 API 入口加入长期记忆",
    "长期记忆中记录发布手册位于团队 Wiki",
    "Please remember that I prefer concise answers.",
  ])("recognizes an explicit request: %s", (prompt) => {
    expect(isExplicitMemoryIntent(prompt)).toBe(true);
  });

  it.each([
    "不要记住这段临时信息。",
    "不用帮我记住这个验证码。",
    "别记这个。",
    "不要把这个加入长期记忆。",
    "无需保存到长期记忆。",
    "你还记得我们上次说了什么吗？",
    "我忘记了 pnpm 的命令。",
    "Don't remember this value.",
    "/remember project 使用 pnpm",
  ])("rejects negation, recall questions, and slash commands: %s", (prompt) => {
    expect(isExplicitMemoryIntent(prompt)).toBe(false);
  });
});
