import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { DESKTOP_CHANNELS } from "../../src/desktop/contracts.js";
import { isSafeExternalUrl, isTrustedNavigation, normalizePersistedDesktopProjects, normalizePersistedWorkspace } from "../../src/desktop/security.js";

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

  it("loads legacy and multi-project desktop records without duplicate projects", () => {
    expect(normalizePersistedDesktopProjects({ workspace: "C:\\work\\demo" })).toEqual({
      workspace: "C:\\work\\demo", projects: ["C:\\work\\demo"],
    });
    expect(normalizePersistedDesktopProjects({
      workspace: "C:\\work\\two", projects: ["C:\\work\\one", "C:\\work\\two", 12, ""],
    })).toEqual({ workspace: "C:\\work\\two", projects: ["C:\\work\\two", "C:\\work\\one"] });
  });

  it("keeps the preload channel surface explicit", () => {
    expect(Object.values(DESKTOP_CHANNELS).sort()).toEqual([
      "desktop:add-model", "desktop:answer-questions", "desktop:app-icon", "desktop:bootstrap", "desktop:choose-workspace", "desktop:create-memory", "desktop:create-skill",
      "desktop:d2c-confirm-mapping", "desktop:d2c-generate-integration", "desktop:d2c-get-integration", "desktop:d2c-get-mock-status",
      "desktop:d2c-get-preview-status", "desktop:d2c-get-report", "desktop:d2c-import", "desktop:d2c-import-openapi", "desktop:d2c-list-reports",
      "desktop:d2c-create-product", "desktop:d2c-decide-product", "desktop:d2c-get-product", "desktop:d2c-get-product-preview-status", "desktop:d2c-open-product-preview", "desktop:d2c-regenerate-prd", "desktop:d2c-start-product-preview", "desktop:d2c-stop-product-preview", "desktop:d2c-update-prd-section",
      "desktop:d2c-get-judge-config", "desktop:d2c-open-preview", "desktop:d2c-resolve-quality-issue", "desktop:d2c-run-interaction-tests", "desktop:d2c-run-quality-judge", "desktop:d2c-save-judge-config", "desktop:d2c-set-manual-acceptance", "desktop:d2c-start-mock",
      "desktop:d2c-start-preview", "desktop:d2c-stop-mock", "desktop:d2c-stop-preview", "desktop:d2c-update-review",
      "desktop:delete-mcp-server", "desktop:delete-memory", "desktop:delete-session", "desktop:delete-skill", "desktop:e2e-get-delivery-run", "desktop:event", "desktop:finish-task", "desktop:get-skill", "desktop:interrupt",
      "desktop:acknowledge-session", "desktop:close-project", "desktop:copy-project-path", "desktop:dismiss-recovery",
      "desktop:git-commit", "desktop:git-diff", "desktop:git-discard", "desktop:git-stage", "desktop:git-status", "desktop:git-unstage",
      "desktop:list-files", "desktop:list-mcp-servers", "desktop:list-memory", "desktop:list-skills",
      "desktop:open-workspace", "desktop:resolve-approval", "desktop:resolve-memory-review", "desktop:save-mcp-server", "desktop:set-mcp-server-enabled", "desktop:set-skill-enabled", "desktop:show-app-menu",
      "desktop:reveal-project", "desktop:select-session", "desktop:start-session", "desktop:submit", "desktop:switch-model", "desktop:update-memory", "desktop:update-project", "desktop:update-session", "desktop:update-skill",
    ].sort());
  });

  it("allows embedded D2C frames only from loopback origins", async () => {
    const html = await readFile(new URL("../../src/desktop/renderer/index.html", import.meta.url), "utf8");
    expect(html).toContain("frame-src http://127.0.0.1:* http://localhost:*");
    expect(html).not.toMatch(/frame-src[^\"]*https:/);
  });

  it("opens only the controller-owned loopback preview, never a renderer-provided URL", async () => {
    const main = await readFile(new URL("../../src/desktop/main.ts", import.meta.url), "utf8");
    const handler = main.slice(main.indexOf("DESKTOP_CHANNELS.d2cOpenPreview"), main.indexOf("DESKTOP_CHANNELS.d2cRunInteractionTests"));
    expect(handler).toContain("controller.getD2cPreviewStatus");
    expect(handler).toContain("isLoopbackPreviewUrl(status.url)");
    expect(handler).toContain("shell.openExternal(status.url)");
    expect(handler).not.toContain("value.url");
  });

  it("allows the first navigation only when it targets the configured renderer", () => {
    const trusted = "file:///C:/work/dist/desktop-renderer/index.html";
    expect(isTrustedNavigation(trusted, "", trusted)).toBe(true);
    expect(isTrustedNavigation(trusted, trusted, trusted)).toBe(true);
    expect(isTrustedNavigation("file:///C:/secrets.txt", "", trusted)).toBe(false);
    expect(isTrustedNavigation("https://example.com", trusted, trusted)).toBe(false);
  });
});
