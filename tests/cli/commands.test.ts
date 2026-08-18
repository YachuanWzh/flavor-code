import { describe, expect, it } from "vitest";

import { MAX_ALIAS_LENGTH, MAX_MESSAGE_BYTES } from "../../src/pals/protocol.js";
import { parseSlashCommand } from "../../src/ui/commands.js";

describe("evolve slash commands", () => {
  it.each([
    ["/evolve", { name: "evolve", args: [] }],
    ["/evolve signals", { name: "evolve", args: ["signals"] }],
    ["/evolve suggest", { name: "evolve", args: ["suggest"] }],
    ["/evolve improve abc123def456", { name: "evolve", args: ["improve", "abc123def456"] }],
    ["/evolve verify fix-read", { name: "evolve", args: ["verify", "fix-read"] }],
    ["/evolve reload fix-read", { name: "evolve", args: ["reload", "fix-read"] }],
    ["/evolve test", { name: "evolve", args: ["test"] }],
    ["/evolve revert fix-read", { name: "evolve", args: ["revert", "fix-read"] }],
    ["/evolve done abc123def456", { name: "evolve", args: ["done", "abc123def456"] }],
    ["/evolve clear", { name: "evolve", args: ["clear"] }],
    ["/evolve verify fix-read extra", { name: "evolve", args: ["verify", "fix-read", "extra"] }],
  ])("parses %s", (input, expected) => {
    expect(parseSlashCommand(input)).toEqual(expected);
  });

  it("keeps built-in evolve ahead of plugins and skills", () => {
    expect(parseSlashCommand("/evolve signals", ["evolve"], ["evolve"])).toEqual({
      name: "evolve", args: ["signals"],
    });
  });
});

describe("pal slash commands", () => {
  it.each([
    ["/pals", { name: "pals", action: "list", verbose: false }],
    ["/pals --verbose", { name: "pals", action: "list", verbose: true }],
    ["/pals rename B", { name: "pals", action: "rename", alias: "B" }],
    ["/pals info api-window", { name: "pals", action: "info", target: "api-window" }],
    ["/chat B 你好啊", { name: "chat", target: "B", goal: "你好啊" }],
    ["/co-work B upgrade the API", { name: "co-work", action: "start", target: "B", goal: "upgrade the API" }],
    ["/co-work status", { name: "co-work", action: "status" }],
    ["/co-work status work-42", { name: "co-work", action: "status", coWorkId: "work-42" }],
    ["/co-work cancel work-42", { name: "co-work", action: "cancel", coWorkId: "work-42" }],
    ["/co-work cancel work-42 contract changed", {
      name: "co-work", action: "cancel", coWorkId: "work-42", reason: "contract changed",
    }],
  ])("parses %s", (input, expected) => {
    expect(parseSlashCommand(input)).toEqual(expected);
  });

  it("keeps built-in pal commands ahead of plugins and skills", () => {
    expect(parseSlashCommand("/chat B implement it", ["chat"], ["chat"])).toEqual({
      name: "chat", target: "B", goal: "implement it",
    });
  });

  it.each([
    "/pals extra",
    "/pals --verbose extra",
    "/pals rename",
    "/pals rename B extra",
    "/pals info",
    "/pals info B extra",
    "/chat",
    "/chat B",
    "/co-work",
    "/co-work B",
    "/co-work status one two",
    "/co-work cancel",
  ])("rejects invalid arguments for %s", (input) => {
    expect(parseSlashCommand(input)).toMatchObject({ name: "invalid" });
  });

  it("rejects overlong targets, aliases, goals, and reasons", () => {
    const overlongTarget = "a".repeat(MAX_ALIAS_LENGTH + 1);
    const overlongText = "界".repeat(Math.floor(MAX_MESSAGE_BYTES / 3) + 1);

    for (const input of [
      `/pals rename ${overlongTarget}`,
      `/pals info ${overlongTarget}`,
      `/chat ${overlongTarget} hello`,
      `/chat B ${overlongText}`,
      `/co-work ${overlongTarget} goal`,
      `/co-work B ${overlongText}`,
      `/co-work cancel work-42 ${overlongText}`,
    ]) {
      expect(parseSlashCommand(input)).toMatchObject({ name: "invalid" });
    }
  });
});
