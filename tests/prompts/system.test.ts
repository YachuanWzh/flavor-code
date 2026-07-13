import { describe, expect, it } from "vitest";

import { buildSystemPrompt, type SystemPromptOptions } from "../../src/prompts/system.js";

const base: Omit<SystemPromptOptions, "agent" | "toolNames"> = {
  languageInstruction: "Always reply in Simplified Chinese.",
  workspace: "C:\\repo\nignored",
  model: "openai:gpt-5",
  permissionMode: "workspace",
  environment: {
    date: "2026-07-13",
    platform: "win32",
    osVersion: "Windows 11",
    shell: "powershell",
    isGitRepository: true,
  },
};

describe("buildSystemPrompt", () => {
  it("assembles stable core sections after the language preference", () => {
    const sections = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set(["Read", "Shell"]),
    });

    expect(sections[0]).toBe("Always reply in Simplified Chinese.");
    expect(sections.map(heading)).toEqual([
      "Always reply in Simplified Chinese.",
      "# Identity",
      "# Security and instruction boundaries",
      "# Doing tasks",
      "# Reversible and shared actions",
      "# Using available tools",
      "# Tone and output",
      "# Main agent",
      "# Environment",
    ]);
    expect(sections.join("\n\n")).toContain("You are Flavor");
    expect(sections.join("\n\n")).toContain("verify the result before claiming completion");
  });

  it("emits guidance only for tools that are actually available", () => {
    const allTools = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set([
        "Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Shell",
        "AskUserQuestion", "TodoWrite", "TaskPlan", "TaskUpdate", "Task",
        "TaskOutput", "SkillResource",
      ]),
    }).join("\n\n");
    const readOnly = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set(["Read"]),
    }).join("\n\n");

    for (const name of [
      "Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Shell",
      "AskUserQuestion", "TodoWrite", "TaskPlan", "TaskUpdate", "Task",
      "TaskOutput", "SkillResource",
    ]) expect(allTools).toContain(`\`${name}\``);
    expect(readOnly).toContain("`Read`");
    for (const name of ["Shell", "Task", "TodoWrite", "AskUserQuestion"]) {
      expect(readOnly).not.toContain(`\`${name}\``);
    }
    expect(allTools).not.toMatch(/run .* in parallel/i);
  });

  it("gives subagents a self-contained non-delegating handoff contract", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: "subagent",
      toolNames: new Set(["Read", "Shell"]),
    }).join("\n\n");

    expect(prompt).toContain("Treat the assigned task as self-contained");
    expect(prompt).toContain("Use absolute paths");
    expect(prompt).toContain("Do not delegate");
    expect(prompt).toContain("concise handoff");
    expect(prompt).not.toContain("`Task`");
  });

  it("renders environment values as normalized data", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set(),
    }).at(-1);

    expect(prompt).toContain("- Date: 2026-07-13");
    expect(prompt).toContain("- Working directory: C:\\repo ignored");
    expect(prompt).toContain("- Git repository: yes");
    expect(prompt).toContain("- Platform: win32");
    expect(prompt).toContain("- OS version: Windows 11");
    expect(prompt).toContain("- Shell: powershell");
    expect(prompt).toContain("- Model: openai:gpt-5");
    expect(prompt).toContain("- Permission mode: workspace");
  });

  it("omits a blank language preference", () => {
    const sections = buildSystemPrompt({
      ...base,
      languageInstruction: " \n ",
      agent: "main",
      toolNames: new Set(),
    });

    expect(sections[0]).toMatch(/^# Identity/);
    expect(sections.every((section) => section.trim().length > 0)).toBe(true);
  });
});

function heading(section: string): string {
  return section.split("\n", 1)[0] ?? "";
}
