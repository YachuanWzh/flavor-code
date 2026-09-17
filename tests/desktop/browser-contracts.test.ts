import { describe, expect, it } from "vitest";

import {
  BrowserActSchema,
  BrowserBoundsSchema,
  BrowserCloseTabInputSchema,
  BrowserEventSchema,
  BrowserNavigateInputSchema,
  BrowserNewTabInputSchema,
  BrowserSetVisibleInputSchema,
  BrowserSnapshotInputSchema,
} from "../../src/desktop/browser/contracts.js";

describe("browser IPC contracts", () => {
  it("accepts well-formed navigation input", () => {
    const parsed = BrowserNavigateInputSchema.safeParse({
      spaceId: "bspace-task-1",
      tabId: "btab-9f2c",
      url: "https://example.com/login",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown fields, oversized urls and malformed ids", () => {
    expect(
      BrowserNewTabInputSchema.safeParse({ spaceId: "bspace-1", url: "https://x.test", evil: true }).success,
    ).toBe(false);
    expect(
      BrowserNavigateInputSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        url: "https://x.test/".concat("a".repeat(4_000)),
      }).success,
    ).toBe(false);
    expect(
      BrowserCloseTabInputSchema.safeParse({ spaceId: "space-1", tabId: "btab-1" }).success,
    ).toBe(false);
    expect(
      BrowserCloseTabInputSchema.safeParse({ spaceId: "bspace-1", tabId: "tab;rm" }).success,
    ).toBe(false);
  });

  it("caps renderer-supplied bounds", () => {
    expect(BrowserBoundsSchema.safeParse({ x: 0, y: 0, width: 1280, height: 800 }).success).toBe(true);
    expect(BrowserBoundsSchema.safeParse({ x: -5, y: 0, width: 10, height: 10 }).success).toBe(false);
    expect(BrowserBoundsSchema.safeParse({ x: 0, y: 0, width: 999_999, height: 10 }).success).toBe(false);
    expect(BrowserBoundsSchema.safeParse({ x: 0, y: 0, width: 10 }).success).toBe(false);
  });

  it("requires renderer visible intents to be boolean", () => {
    expect(BrowserSetVisibleInputSchema.safeParse({ spaceId: "bspace-1", visible: true }).success).toBe(true);
    expect(BrowserSetVisibleInputSchema.safeParse({ spaceId: "bspace-1", visible: "yes" }).success).toBe(false);
  });

  it("validates the act discriminated union", () => {
    expect(
      BrowserActSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        action: "click",
        target: "@12",
      }).success,
    ).toBe(true);
    expect(
      BrowserActSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        action: "fill",
        target: "@2",
        value: "alice@example.com",
      }).success,
    ).toBe(true);
    // unknown action
    expect(
      BrowserActSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        action: "drag",
        target: "@1",
      }).success,
    ).toBe(false);
    // click with an unexpected value field is rejected (strict objects)
    expect(
      BrowserActSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        action: "click",
        target: "@1",
        value: "sneak",
      }).success,
    ).toBe(false);
    // fill without a value is rejected
    expect(
      BrowserActSchema.safeParse({ spaceId: "bspace-1", tabId: "btab-1", action: "fill", target: "@2" }).success,
    ).toBe(false);
    // scroll needs either a target or a delta
    expect(
      BrowserActSchema.safeParse({ spaceId: "bspace-1", tabId: "btab-1", action: "scroll" }).success,
    ).toBe(false);
    expect(
      BrowserActSchema.safeParse({ spaceId: "bspace-1", tabId: "btab-1", action: "scroll", deltaY: 300 }).success,
    ).toBe(true);
    // deltas are bounded
    expect(
      BrowserActSchema.safeParse({
        spaceId: "bspace-1",
        tabId: "btab-1",
        action: "scroll",
        deltaY: 1_000_000,
      }).success,
    ).toBe(false);
  });

  it("keeps snapshot node budgets within the hard cap", () => {
    expect(BrowserSnapshotInputSchema.safeParse({ spaceId: "bspace-1", maxNodes: 500 }).success).toBe(true);
    expect(BrowserSnapshotInputSchema.safeParse({ spaceId: "bspace-1", maxNodes: 20_000 }).success).toBe(false);
    expect(
      BrowserSnapshotInputSchema.safeParse({ spaceId: "bspace-1", scope: "full_page" }).success,
    ).toBe(true);
    expect(BrowserSnapshotInputSchema.safeParse({ spaceId: "bspace-1", scope: "everything" }).success).toBe(false);
  });

  it("only emits serializable, size-capped browser events", () => {
    expect(
      BrowserEventSchema.safeParse({
        kind: "tab-state",
        spaceId: "bspace-1",
        tabId: "btab-1",
        url: "https://example.com",
        title: "Example",
        loading: false,
        canGoBack: true,
        canGoForward: false,
      }).success,
    ).toBe(true);
    expect(
      BrowserEventSchema.safeParse({
        kind: "tab-state",
        spaceId: "bspace-1",
        tabId: "btab-1",
        url: "https://example.com",
        title: "x".repeat(400),
        loading: false,
        canGoBack: false,
        canGoForward: false,
      }).success,
    ).toBe(false);
    expect(BrowserEventSchema.safeParse({ kind: "html-dump", spaceId: "bspace-1", html: "<..." }).success).toBe(
      false,
    );
    expect(
      BrowserEventSchema.safeParse({ kind: "ownership-changed", spaceId: "bspace-1", ownership: "user" }).success,
    ).toBe(true);
  });
});
