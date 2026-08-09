import { describe, expect, it } from "vitest";

import { D2C_SKILL_NAME, d2cSkillContent } from "../../src/d2c/skill-template.js";

describe("d2cSkillContent", () => {
  it("opens with YAML frontmatter naming the skill", () => {
    const content = d2cSkillContent();
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain(`name: ${D2C_SKILL_NAME}`);
    expect(content).toMatch(/description: .+/);
  });

  it("guides the agent through import, framework choice, generation and comparison", () => {
    const content = d2cSkillContent();
    expect(content).toContain("D2cImport");
    expect(content).toContain("D2cCompare");
    expect(content).toContain("at most three comparisons");
    expect(content).toMatch(/Vue/i);
    expect(content).toMatch(/React/i);
    expect(content).toMatch(/which framework/i);
    expect(content).toMatch(/npm install/);
    expect(content).toMatch(/project directory/i);
  });
});
