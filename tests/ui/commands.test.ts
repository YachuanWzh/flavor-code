import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "../../src/ui/commands.js";

describe("parseSlashCommand", () => {
  it.each([
    ["/model main openai:gpt-example", { name: "model", role: "main", modelId: "openai:gpt-example" }],
    ["/model subagent anthropic:claude-example", { name: "model", role: "subagent", modelId: "anthropic:claude-example" }],
    ["/permissions safe", { name: "permissions", mode: "default" }],
    ["/permissions default", { name: "permissions", mode: "default" }],
    ["/permissions acceptEdits", { name: "permissions", mode: "acceptEdits" }],
    ["/permissions plan", { name: "permissions", mode: "plan" }],
    ["/permissions bypassPermissions", { name: "permissions", mode: "bypassPermissions" }],
    ["/permissions auto", { name: "permissions", mode: "auto" }],
    ["/permissions bubble", { name: "permissions", mode: "bubble" }],
    ["/compact", { name: "compact" }], ["/init", { name: "init" }],
    ["/tasks", { name: "tasks" }], ["/skills", { name: "skills" }],
    ["/plugins", { name: "plugins" }], ["/hooks", { name: "hooks" }],
    ["/mcp", { name: "mcp", action: "status" }],
    ["/mcp status", { name: "mcp", action: "status" }],
    ["/mcp tools filesystem", { name: "mcp", action: "tools", target: "filesystem" }],
    ["/mcp reconnect filesystem", { name: "mcp", action: "reconnect", target: "filesystem" }],
    ["/mcp enable", { name: "mcp", action: "enable", target: "all" }],
    ["/mcp disable docs", { name: "mcp", action: "disable", target: "docs" }],
    ["/ide", { name: "ide" }],
    ["/config", { name: "config" }], ["/clear", { name: "clear" }],
    ["/memory", { name: "memory" }],
    ["/remember project Use pnpm for scripts", { name: "remember", type: "project", text: "Use pnpm for scripts" }],
    ["/remember Prefer Chinese responses", { name: "remember", type: "project", text: "Prefer Chinese responses" }],
    ["/forget obsolete convention", { name: "forget", query: "obsolete convention" }],
    ["/forget-cold", { name: "forget-cold" }],
    ["/loop fix all tests", { name: "loop", goal: "fix all tests" }],
    ["/checkpoint before refactor", { name: "checkpoint", label: "before refactor" }],
    ["/checkpoint", { name: "checkpoint" }],
    ["/tree", { name: "tree" }],
    ["/rewind turn-123", { name: "rewind", nodeId: "turn-123" }],
    ["/fork turn-456", { name: "fork", nodeId: "turn-456" }],
    ["/unrevert", { name: "unrevert" }],
    ["/commit", { name: "commit" }],
    ["/commit fix the parser", { name: "commit", hint: "fix the parser" }],
    ["/review", { name: "review" }],
    ["/review error handling", { name: "review", focus: "error handling" }],
    ["/explain", { name: "explain" }],
    ["/explain cancelOrder", { name: "explain", query: "cancelOrder" }],
    ["/explain src/order.ts#cancelOrder 错误处理", { name: "explain", query: "src/order.ts#cancelOrder", focus: "错误处理" }],
    ["/help", { name: "help" }], ["/exit", { name: "exit" }],
  ])("parses %s", (input, expected) => expect(parseSlashCommand(input)).toEqual(expected));

  it("returns null for ordinary prompts", () => expect(parseSlashCommand("explain this")).toBeNull());

  it("suggests the closest known command", () => {
    expect(parseSlashCommand("/permisions")).toEqual({ name: "unknown", input: "permisions", suggestions: ["permissions"] });
  });

  it("parses only explicitly registered dynamic plugin commands", () => {
    expect(parseSlashCommand("/taste saffron plum", ["taste"])).toEqual({
      name: "plugin", command: "taste", args: ["saffron", "plum"],
    });
    expect(parseSlashCommand("/taste saffron")).toMatchObject({ name: "unknown" });
    expect(parseSlashCommand("/ide", ["ide"])).toEqual({ name: "ide" });
  });

  it("parses explicitly discovered skills after built-in and plugin commands", () => {
    expect(parseSlashCommand("/frontend-design polish footer", [], ["frontend-design"]))
      .toEqual({ name: "skill", skill: "frontend-design", prompt: "polish footer" });
    expect(parseSlashCommand("/help", ["help"], ["help"])).toEqual({ name: "help" });
    expect(parseSlashCommand("/loop ship it", ["loop"], ["loop"]))
      .toEqual({ name: "loop", goal: "ship it" });
  });

  it("parses registered tools directly or through the stable /tool command", () => {
    expect(parseSlashCommand('/EchoUpper {"text":"hello world"}', [], [], ["EchoUpper"]))
      .toEqual({ name: "managed-tool", tool: "EchoUpper", input: '{"text":"hello world"}' });
    expect(parseSlashCommand('/echoupper', [], [], ["EchoUpper"]))
      .toEqual({ name: "managed-tool", tool: "EchoUpper", input: "" });
    expect(parseSlashCommand('/tool ECHOUPPER  {"text": "hello world"}', [], [], ["EchoUpper"]))
      .toEqual({ name: "managed-tool", tool: "EchoUpper", input: '{"text": "hello world"}' });
    expect(parseSlashCommand("/tool missing {}", [], [], ["EchoUpper"]))
      .toEqual({ name: "invalid", command: "tool", message: "Use /tool <registered-tool> [JSON object]." });
  });

  it("keeps built-in and plugin precedence while registered tools precede skills", () => {
    expect(parseSlashCommand("/help", [], [], ["help"])).toEqual({ name: "help" });
    expect(parseSlashCommand("/taste value", ["taste"], ["taste"], ["taste"]))
      .toEqual({ name: "plugin", command: "taste", args: ["value"] });
    expect(parseSlashCommand("/paint value", [], ["paint"], ["paint"]))
      .toEqual({ name: "managed-tool", tool: "paint", input: "value" });
  });

  it("reports invalid arguments without throwing", () => {
    expect(parseSlashCommand("/permissions reckless")).toMatchObject({ name: "invalid", command: "permissions" });
    expect(parseSlashCommand("/model sidekick foo:bar")).toMatchObject({ name: "invalid", command: "model" });
    expect(parseSlashCommand("/loop")).toEqual({ name: "invalid", command: "loop", message: "Use /loop <goal>." });
    expect(parseSlashCommand("/remember")).toEqual({
      name: "invalid", command: "remember", message: "Use /remember [user|feedback|project|reference] <text>.",
    });
    expect(parseSlashCommand("/forget")).toEqual({
      name: "invalid", command: "forget", message: "Use /forget <text-or-id>.",
    });
    expect(parseSlashCommand("/mcp tools")).toEqual({
      name: "invalid", command: "mcp", message: "Use /mcp [status|tools <server>|reconnect <server>|enable [server|all]|disable [server|all]].",
    });
    expect(parseSlashCommand("/mcp remove docs")).toMatchObject({ name: "invalid", command: "mcp" });
    expect(parseSlashCommand("/rewind")).toMatchObject({ name: "invalid", command: "rewind" });
    expect(parseSlashCommand("/fork one two")).toMatchObject({ name: "invalid", command: "fork" });
  });

  it("parses explicit task completion without arguments", () => {
    expect(parseSlashCommand("/finish")).toEqual({ name: "finish" });
    expect(parseSlashCommand("/finish now")).toEqual({
      name: "invalid", command: "finish", message: "/finish does not accept arguments.",
    });
  });
});
