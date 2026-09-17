import { describe, expect, it } from "vitest";

import { formatLocator, parseLocator } from "../../src/desktop/browser/element-resolver.js";
import { BrowserError } from "../../src/desktop/browser/types.js";

describe("locator parsing", () => {
  it("parses snapshot refs in @N and ref=N forms", () => {
    expect(parseLocator("@12")).toEqual({ kind: "ref", ref: 12 });
    expect(parseLocator("ref=7")).toEqual({ kind: "ref", ref: 7 });
    expect(() => parseLocator("@0")).toThrowError(BrowserError);
    expect(parseLocator("@abc")).toEqual({ kind: "css", selector: "@abc" });
  });

  it("parses explicit schemes", () => {
    expect(parseLocator("loc=css:button.primary")).toEqual({ kind: "css", selector: "button.primary" });
    expect(parseLocator("loc=role:button[name='Save']")).toEqual({ kind: "role", role: "button", name: "Save" });
    expect(parseLocator('loc=role:button[name="Save draft"]')).toEqual({
      kind: "role",
      role: "button",
      name: "Save draft",
    });
    expect(parseLocator("loc=role:link")).toEqual({ kind: "role", role: "link" });
    expect(parseLocator("loc=href:/docs/getting-started")).toEqual({
      kind: "href",
      value: "/docs/getting-started",
    });
    expect(parseLocator("text=Sign in")).toEqual({ kind: "text", value: "Sign in" });
    expect(parseLocator("xpath=//div[@id='x']")).toEqual({
      kind: "xpath",
      expression: "//div[@id='x']",
    });
  });

  it("treats bare input as CSS for compatibility", () => {
    expect(parseLocator("div.primary > span")).toEqual({ kind: "css", selector: "div.primary > span" });
  });

  it("rejects malformed locators as bad-locator errors", () => {
    for (const raw of [
      "",
      "loc=",
      "loc=js:alert(1)",
      "loc=role:",
      "loc=role:[name='x']",
      "text=",
      "xpath=div",
      "   ",
    ]) {
      let thrown: unknown;
      try {
        parseLocator(raw);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, raw).toBeInstanceOf(BrowserError);
      expect((thrown as BrowserError).code).toBe("bad-locator");
    }
  });

  it("rejects over-long locators", () => {
    expect(() => parseLocator("text=".concat("x".repeat(3_000)))).toThrow(BrowserError);
  });

  it("round-trips canonical formatting", () => {
    expect(formatLocator(parseLocator("@5"))).toBe("@5");
    expect(formatLocator(parseLocator("loc=role:button[name='Save']"))).toBe("loc=role:button[name='Save']");
    expect(formatLocator(parseLocator("text=Sign in"))).toBe("text=Sign in");
  });
});
