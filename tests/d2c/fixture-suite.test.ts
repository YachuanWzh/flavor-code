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
  it.skipIf(!existsSync(fixtureDirectory))("imports five interactive enterprise HTML pages with stable labels and local assets", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-fixture-"));
    try {
      const manifest = await importDesign(workspace, "pixso-suite", fixtureDirectory);
      expect(manifest.pages).toEqual([
        { id: "index", label: "矩流工业 · 供应链总览", html: "index.html" },
        { id: "analytics", label: "矩流工业 · 经营分析", html: "analytics.html" },
        { id: "orders", label: "矩流工业 · 采购订单", html: "orders.html" },
        { id: "settings", label: "矩流工业 · 系统设置", html: "settings.html" },
        { id: "suppliers", label: "矩流工业 · 供应商协同", html: "suppliers.html" },
      ]);
      expect(manifest.files).toEqual(expect.arrayContaining([
        "styles.css", "app.js", "interaction-manifest.json",
        "assets/plant-map.svg", "assets/cost-structure.svg",
      ]));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
