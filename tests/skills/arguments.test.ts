import { describe, expect, it } from "vitest";

import { expandSkillArguments, splitSkillArguments } from "../../src/skills/arguments.js";

describe("skill argument expansion", () => {
  it("expands full, indexed, and shorthand placeholders", () => {
    expect(expandSkillArguments(
      "Goal: $ARGUMENTS\nFirst: $ARGUMENTS[0]\nSecond: $1",
      '"fix login" src/auth.ts',
    )).toBe('Goal: "fix login" src/auth.ts\nFirst: fix login\nSecond: src/auth.ts');
  });

  it("appends arguments when a portable skill does not declare a placeholder", () => {
    expect(expandSkillArguments("Run the workflow.", "fix login"))
      .toBe("Run the workflow.\n\nARGUMENTS: fix login");
  });

  it("splits quoted and escaped arguments without invoking a shell", () => {
    expect(splitSkillArguments("one 'two three' four\\ five \"six seven\" C:\\work\\src"))
      .toEqual(["one", "two three", "four five", "six seven", "C:\\work\\src"]);
  });
});
