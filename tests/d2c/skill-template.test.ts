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
    expect(content).toContain("d2c.modules.json");
    expect(content).toContain("data-d2c-module");
    expect(content).toContain("stop immediately");
    expect(content).toContain("human review");
    expect(content).toContain("Never retry the same `D2cCompare` failure unchanged");
    expect(content).not.toContain("up to 10 expansions");
    expect(content).toMatch(/Vue/i);
    expect(content).toMatch(/React/i);
    expect(content).toMatch(/which framework/i);
    expect(content).toMatch(/npm install/);
    expect(content).toMatch(/project directory/i);
  });
});
