import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  applyD2cProductDecision,
  buildD2cDesignPrompt,
  buildD2cPrdPrompt,
  createD2cProductPlan,
  discoverD2cProductArtifacts,
  readD2cProductPlan,
  readD2cProductPlanView,
  resolveD2cProductTechnology,
  buildD2cProductOpenApi,
  writeD2cProductPlan,
} from "../../src/d2c/product.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("D2C product discovery workflow", () => {
  it("defaults requirement-driven products to Vue and Python and honors explicit overrides", async () => {
    expect(resolveD2cProductTechnology("做一个门店经营后台", "vue")).toEqual({
      framework: "vue",
      frontend: "Vue 3",
      backend: "Python",
      frontendSource: "default",
      backendSource: "default",
    });

    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-product-")); dirs.push(workspace);
    const plan = await createD2cProductPlan(workspace, {
      task: "explicit-stack", framework: "vue", requirement: "前端使用 React，服务端使用 Java Spring Boot",
    });
    expect(plan).toMatchObject({
      framework: "react",
      technology: {
        frontend: "React",
        backend: "Java / Spring Boot",
        frontendSource: "requirement",
        backendSource: "requirement",
      },
    });
    expect(buildD2cPrdPrompt(plan)).toContain("前端 React，服务端 Java / Spring Boot");
  });

  it("derives a deterministic OpenAPI contract for requirement-driven modules", () => {
    const raw = buildD2cProductOpenApi("inventory", [{
      id: "page-products", label: "商品管理", sourceFiles: ["src/Products.vue"],
      keywords: ["products", "商品"], dataNeeds: ["products"], actions: ["applyQuery", "saveProduct"],
    }]);
    const document = JSON.parse(raw);
    expect(document).toMatchObject({ openapi: "3.1.0", info: { title: "inventory API" } });
    expect(document.paths["/api/page-products"].get.operationId).toBe("getPageProducts");
  });

  it("persists a coarse requirement and generates a bounded PRD prompt", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-product-")); dirs.push(workspace);
    const plan = await createD2cProductPlan(workspace, {
      task: "merchant-console", framework: "react", requirement: "给小商户做一个能看今日经营情况的后台",
    }, () => new Date("2026-08-12T02:00:00.000Z"));

    expect(plan).toMatchObject({ schema: 1, task: "merchant-console", phase: "prd-generating", revision: 0 });
    await expect(readD2cProductPlan(workspace, "merchant-console")).resolves.toEqual(plan);
    const prompt = buildD2cPrdPrompt(plan);
    expect(prompt).toContain("product/prd.md");
    expect(prompt).toContain("目标用户");
    expect(prompt).toContain("验收标准");
    expect(prompt).not.toContain("src/d2c-output");
  });

  it("discovers artifacts and enforces PRD/design confirmation gates", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-product-")); dirs.push(workspace);
    let plan = await createD2cProductPlan(workspace, {
      task: "merchant-console", framework: "vue", requirement: "经营分析后台",
    });
    const product = join(workspace, ".flavor", "d2c", "merchant-console", "product");
    await mkdir(join(product, "prototype"), { recursive: true });
    await writeFile(join(product, "prd.md"), "# 商户经营台\n\n## 验收标准\n- 能查看今日交易额\n");
    plan = await discoverD2cProductArtifacts(workspace, plan);
    expect(plan.phase).toBe("prd-review");

    const rejectedPrd = applyD2cProductDecision(plan, "prd", false, "补充异常退款流程");
    expect((await discoverD2cProductArtifacts(workspace, rejectedPrd)).phase).toBe("prd-generating");

    plan = applyD2cProductDecision(plan, "prd", true, undefined, "2026-08-12T03:00:00.000Z");
    expect(plan.phase).toBe("design-generating");
    const designPrompt = buildD2cDesignPrompt(plan, "# 商户经营台");
    expect(designPrompt).toContain("interaction-manifest.json");
    expect(designPrompt).toContain(`.flavor/d2c/${plan.task}/product/prototype/interaction-manifest.json`);
    expect(designPrompt).toContain("输入条件 → 点击查询 → 结果断言 → 重置");
    expect(designPrompt).toContain("二级、三级菜单");
    expect(designPrompt).toContain("每次点击后必须紧跟");

    await writeFile(join(product, "prototype", "index.html"), "<!doctype html><button>刷新</button>");
    const partial = await discoverD2cProductArtifacts(workspace, plan);
    expect(partial).toEqual(plan);

    await writeFile(join(product, "interaction-manifest.json"), JSON.stringify({ schemaVersion: 1 }));
    expect((await discoverD2cProductArtifacts(workspace, plan)).phase).toBe("design-generating");
    await writeD2cProductPlan(workspace, plan);
    await expect(readD2cProductPlanView(workspace, plan.task)).resolves.toMatchObject({
      plan: { phase: "design-generating" },
      validationError: { stage: "design", message: expect.stringContaining("Invalid D2C interaction manifest") },
    });

    await writeFile(join(product, "prototype", "interaction-manifest.json"), JSON.stringify({
      schemaVersion: 1, product: "merchant-console", deterministic: true,
      pages: [{ url: "index.html", requireApi: false, scenarios: [{ id: "loads", requireApi: false, steps: [
        { action: "visible", selector: "button" },
      ] }] }],
    }));
    plan = await discoverD2cProductArtifacts(workspace, plan);
    expect(plan.phase).toBe("design-review");
    await expect(readFile(join(product, "prototype", "interaction-manifest.json"), "utf8"))
      .resolves.toContain('"expect": "visible"');
    plan = applyD2cProductDecision(plan, "design", true, undefined, "2026-08-12T04:00:00.000Z");
    expect(plan.phase).toBe("ready-for-d2c");
  });

  it("falls back to an in-place replacement when Windows refuses rename-over-existing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-product-")); dirs.push(workspace);
    const initial = await createD2cProductPlan(workspace, {
      task: "windows-locked-plan", framework: "vue", requirement: "Create an inventory management console",
    });
    const updated = { ...initial, revision: 1, updatedAt: "2026-08-12T05:00:00.000Z" };
    let renameAttempts = 0;

    await writeD2cProductPlan(workspace, updated, {
      rename: async () => {
        renameAttempts += 1;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      },
      copyFile,
      unlink,
    });

    expect(renameAttempts).toBe(1);
    await expect(readD2cProductPlan(workspace, initial.task)).resolves.toEqual(updated);
  });

  it("records actionable feedback and returns only to the rejected stage", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "flavor-d2c-product-")); dirs.push(workspace);
    const initial = await createD2cProductPlan(workspace, {
      task: "merchant-console", framework: "react", requirement: "经营分析后台",
    });
    const review = { ...initial, phase: "prd-review" as const, prd: { path: "product/prd.md" as const, updatedAt: initial.updatedAt } };
    const rejected = applyD2cProductDecision(review, "prd", false, "补充异常退款流程", "2026-08-12T03:00:00.000Z");
    expect(rejected).toMatchObject({ phase: "prd-generating", feedback: { stage: "prd", message: "补充异常退款流程" } });
    expect((await discoverD2cProductArtifacts(workspace, rejected)).phase).toBe("prd-generating");
    expect(() => applyD2cProductDecision(initial, "design", true)).toThrow(/design review/i);
  });
});
