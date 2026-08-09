import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { importDesign } from "../../src/d2c/store.js";

const fixtureDirectory = resolve(
  process.env.FLAVOR_D2C_FIXTURE_DIR?.trim()
    || join(homedir(), "Desktop", "d2c test case", "d2c-pixso-suite"),
);

describe("D2C Pixso example suite", () => {
  it.skipIf(!existsSync(fixtureDirectory))("imports five offline HTML pages with stable labels and local assets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-fixture-"));
    try {
      const manifest = await importDesign(workspace, "pixso-suite", fixtureDirectory);
      expect(manifest.pages).toEqual([
        { id: "index", label: "北纬旅行 · 城市首页", html: "index.html" },
        { id: "analytics", label: "北纬旅行 · 运营仪表盘", html: "analytics.html" },
        { id: "checkout", label: "北纬旅行 · 预订结算", html: "checkout.html" },
        { id: "journal", label: "北纬旅行 · 城市杂志", html: "journal.html" },
        { id: "journey", label: "北纬旅行 · 冰岛南岸行程", html: "journey.html" },
      ]);
      expect(manifest.files).toEqual(expect.arrayContaining([
        "styles.css", "assets/route-map.svg", "assets/coast.svg", "assets/lodge.svg",
      ]));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
