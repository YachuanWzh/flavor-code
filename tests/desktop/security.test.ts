import { describe, expect, it } from "vitest";

import { DESKTOP_CHANNELS } from "../../src/desktop/contracts.js";
import { isSafeExternalUrl, isTrustedNavigation, normalizePersistedWorkspace } from "../../src/desktop/security.js";

describe("desktop security helpers", () => {
  it("permits only HTTP(S) links outside the renderer", () => {
    expect(isSafeExternalUrl("https://example.com/docs")).toBe(true);
    expect(isSafeExternalUrl("http://localhost:3000/callback")).toBe(true);
    expect(isSafeExternalUrl("file:///C:/secrets.txt")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });

  it("accepts only a small persisted absolute-workspace record", () => {
    expect(normalizePersistedWorkspace({ workspace: "C:\\work\\demo" })).toBe("C:\\work\\demo");
    expect(normalizePersistedWorkspace({ workspace: "" })).toBeUndefined();
    expect(normalizePersistedWorkspace({ workspace: 12 })).toBeUndefined();
    expect(normalizePersistedWorkspace({ workspace: "x".repeat(40_000) })).toBeUndefined();
  });

  it("keeps the preload channel surface explicit", () => {
    expect(Object.values(DESKTOP_CHANNELS).sort()).toEqual([
      "desktop:add-model", "desktop:answer-questions", "desktop:bootstrap", "desktop:choose-workspace", "desktop:create-skill", "desktop:delete-session",
      "desktop:delete-skill", "desktop:event", "desktop:get-skill", "desktop:interrupt", "desktop:list-files", "desktop:list-skills",
      "desktop:open-workspace", "desktop:resolve-approval", "desktop:set-skill-enabled", "desktop:show-app-menu",
      "desktop:start-session", "desktop:submit", "desktop:switch-model", "desktop:update-skill",
    ].sort());
  });

  it("allows the first navigation only when it targets the configured renderer", () => {
    const trusted = "file:///C:/work/dist/desktop-renderer/index.html";
    expect(isTrustedNavigation(trusted, "", trusted)).toBe(true);
    expect(isTrustedNavigation(trusted, trusted, trusted)).toBe(true);
    expect(isTrustedNavigation("file:///C:/secrets.txt", "", trusted)).toBe(false);
    expect(isTrustedNavigation("https://example.com", trusted, trusted)).toBe(false);
  });
});
