import { describe, expect, it } from "vitest";

import { buildCurrentDateSection, buildRuntimeEnvironmentSection, buildSystemPrompt, type SystemPromptOptions } from "../../src/prompts/system.js";

const base: Omit<SystemPromptOptions, "agent" | "toolNames"> = {
  languageInstruction: "Always reply in Simplified Chinese.",
  workspace: "C:\\repo\nignored",
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
      "# Boundaries",
      "# Work",
      "# Tools",
      "# Main agent",
      "# Environment",
    ]);
    expect(sections.join("\n\n")).toContain("You are Flavor");
    expect(sections.join("\n\n")).toContain("verify the result");
    expect(sections.join("\n\n")).toContain("Respect the active permission mode");
    expect(sections.join("\n\n").length).toBeLessThan(2_500);
  });

  it("emits guidance only for tools that are actually available", () => {
    const allTools = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set([
        "Read", "Write", "Edit", "ApplyPatch", "Glob", "Grep", "Shell",
        "AskUserQuestion", "TodoWrite", "TaskPlan", "TaskUpdate", "Task",
        "TaskOutput", "Skill", "SkillResource", "RegisterTool", "RemoveTool", "ListRegisteredTools",
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
      "TaskOutput", "Skill", "SkillResource", "RegisterTool", "RemoveTool", "ListRegisteredTools",
    ]) expect(allTools).toContain(name);
    expect(allTools).toContain("copy oldText exactly");
    expect(allTools).toContain("Tool schemas and descriptions are authoritative");
    expect(readOnly).toContain("Read");
    expect(readOnly).toContain("Available: Read.");
    expect(readOnly).not.toContain("Use Shell");
    expect(allTools.length).toBeLessThan(2_500);
  });

  it("gives subagents a self-contained non-delegating handoff contract", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: "subagent",
      toolNames: new Set(["Read", "Shell"]),
    }).join("\n\n");

    expect(prompt).toContain("Work only on the assigned task");
    expect(prompt).toContain("Use absolute paths");
    expect(prompt).toContain("Do not delegate");
    expect(prompt).toContain("concise handoff");
    expect(prompt).not.toContain("Available: Task");
  });

  it("renders environment values as normalized data", () => {
    const prompt = buildSystemPrompt({
      ...base,
      agent: "main",
      toolNames: new Set(),
    }).at(-1);

    expect(prompt).not.toContain("2026-07-13");
    expect(prompt).toContain("- Working directory: C:\\repo ignored");
    expect(prompt).toContain("- Git repository: yes");
    expect(prompt).toContain("- Platform: win32");
    expect(prompt).toContain("- OS version: Windows 11");
    expect(prompt).toContain("- Shell: powershell");
    expect(prompt).not.toContain("- Model:");
    expect(prompt).not.toContain("- Permission mode:");
    expect(buildCurrentDateSection(base.environment.date)).toBe("# Current date\n\n2026-07-13");
  });

  it("emits model and permission mode as a volatile runtime section", () => {
    const runtime = buildRuntimeEnvironmentSection({
      model: "openai:gpt-5\nignored",
      permissionMode: "default",
    });

    expect(runtime).toMatch(/^# Runtime environment/);
    expect(runtime).toContain("- Model: openai:gpt-5 ignored");
    expect(runtime).toContain("- Permission mode: default");
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
