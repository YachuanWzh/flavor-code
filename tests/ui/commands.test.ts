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
    ["/config", { name: "config" }], ["/clear", { name: "clear" }],
    ["/loop fix all tests", { name: "loop", goal: "fix all tests" }],
    ["/help", { name: "help" }], ["/exit", { name: "exit" }],
  ])("parses %s", (input, expected) => expect(parseSlashCommand(input)).toEqual(expected));

  it("returns null for ordinary prompts", () => expect(parseSlashCommand("explain this")).toBeNull());

  it("suggests the closest known command", () => {
    expect(parseSlashCommand("/permisions")).toEqual({ name: "unknown", input: "permisions", suggestions: ["permissions"] });
  });

  it("does not include the removed ide command", () => {
    expect(parseSlashCommand("/ide")).toMatchObject({ name: "unknown" });
  });

  it("parses only explicitly registered dynamic plugin commands", () => {
    expect(parseSlashCommand("/taste saffron plum", ["taste"])).toEqual({
      name: "plugin", command: "taste", args: ["saffron", "plum"],
    });
    expect(parseSlashCommand("/taste saffron")).toMatchObject({ name: "unknown" });
    expect(parseSlashCommand("/ide", ["ide"])).toMatchObject({ name: "unknown" });
  });

  it("parses explicitly discovered skills after built-in and plugin commands", () => {
    expect(parseSlashCommand("/frontend-design polish footer", [], ["frontend-design"]))
      .toEqual({ name: "skill", skill: "frontend-design", prompt: "polish footer" });
    expect(parseSlashCommand("/help", ["help"], ["help"])).toEqual({ name: "help" });
    expect(parseSlashCommand("/loop ship it", ["loop"], ["loop"]))
      .toEqual({ name: "loop", goal: "ship it" });
  });

  it("reports invalid arguments without throwing", () => {
    expect(parseSlashCommand("/permissions reckless")).toMatchObject({ name: "invalid", command: "permissions" });
    expect(parseSlashCommand("/model sidekick foo:bar")).toMatchObject({ name: "invalid", command: "model" });
    expect(parseSlashCommand("/loop")).toEqual({ name: "invalid", command: "loop", message: "Use /loop <goal>." });
    expect(parseSlashCommand("/mcp tools")).toEqual({
      name: "invalid", command: "mcp", message: "Use /mcp [status|tools <server>|reconnect <server>|enable [server|all]|disable [server|all]].",
    });
    expect(parseSlashCommand("/mcp remove docs")).toMatchObject({ name: "invalid", command: "mcp" });
  });
});
