import { describe, expect, it } from "vitest";

import { parseSlashCommand } from "../../src/ui/commands.js";

describe("parseSlashCommand", () => {
  it.each([
    ["/model main openai:gpt-example", { name: "model", role: "main", modelId: "openai:gpt-example" }],
    ["/model subagent anthropic:claude-example", { name: "model", role: "subagent", modelId: "anthropic:claude-example" }],
    ["/permissions safe", { name: "permissions", mode: "safe" }],
    ["/compact", { name: "compact" }], ["/init", { name: "init" }],
    ["/tasks", { name: "tasks" }], ["/skills", { name: "skills" }],
    ["/plugins", { name: "plugins" }], ["/hooks", { name: "hooks" }],
    ["/config", { name: "config" }], ["/clear", { name: "clear" }],
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
  });

  it("reports invalid arguments without throwing", () => {
    expect(parseSlashCommand("/permissions reckless")).toMatchObject({ name: "invalid", command: "permissions" });
    expect(parseSlashCommand("/model sidekick foo:bar")).toMatchObject({ name: "invalid", command: "model" });
  });
});
