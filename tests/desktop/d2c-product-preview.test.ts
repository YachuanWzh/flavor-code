import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { startD2cProductPreview } from "../../src/desktop/d2c-product-preview.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("D2C product prototype preview", () => {
  it("serves only local prototype files with restrictive headers", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-d2c-preview-")); dirs.push(root);
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<!doctype html><h1>Prototype</h1>");
    await writeFile(join(root, "assets", "app.css"), "h1{color:navy}");
    const preview = await startD2cProductPreview(root);
    try {
      expect(preview.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
      const html = await fetch(preview.url);
      expect(await html.text()).toContain("Prototype");
      expect(html.headers.get("content-security-policy")).toContain("connect-src 'none'");
      expect((await fetch(new URL("assets/app.css", preview.url))).headers.get("content-type")).toContain("text/css");
      expect((await fetch(new URL("..%2F..%2Fpackage.json", preview.url))).status).toBe(404);
    } finally { await preview.stop(); }
  });
});
