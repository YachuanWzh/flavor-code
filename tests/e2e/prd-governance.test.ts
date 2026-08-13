import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  approvePrd,
  assertApprovedPrd,
  extractAcceptanceCriteria,
  hashPrd,
  parsePrdSections,
  updatePrdSectionFile,
} from "../../src/e2e/prd-governance.js";

const PRD = `产品导言。

## 背景与目标

帮助店长查看经营异常。

## 验收标准

- [AC-001] 可以按门店查询订单。
- [AC-002] 查询失败后显示可重试提示。
`;

describe("E2E approved PRD governance", () => {
  it("splits Markdown into addressable heading sections", () => {
    expect(parsePrdSections(PRD)).toEqual([
      expect.objectContaining({ id: "preamble", title: "文档说明", level: 0, body: "产品导言。" }),
      expect.objectContaining({ id: "背景与目标", title: "背景与目标", level: 2, body: "帮助店长查看经营异常。" }),
      expect.objectContaining({
        id: "验收标准",
        title: "验收标准",
        level: 2,
        body: "- [AC-001] 可以按门店查询订单。\n- [AC-002] 查询失败后显示可重试提示。",
      }),
    ]);
  });

  it("updates only the selected section when the expected hash is current", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-prd-edit-"));
    const path = join(root, "prd.md");
    await writeFile(path, PRD);

    const updated = await updatePrdSectionFile(path, {
      sectionId: "背景与目标",
      body: "帮助区域经理定位异常门店。",
      expectedHash: hashPrd(PRD),
    });

    expect(updated.markdown).toContain("帮助区域经理定位异常门店。");
    expect(updated.markdown).toContain("[AC-001] 可以按门店查询订单。");
    expect(await readFile(path, "utf8")).toBe(updated.markdown);
  });

  it("rejects a stale section edit instead of overwriting concurrent PRD changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-prd-stale-"));
    const path = join(root, "prd.md");
    await writeFile(path, `${PRD}\n并发补充。\n`);

    await expect(updatePrdSectionFile(path, {
      sectionId: "背景与目标",
      body: "不应写入",
      expectedHash: hashPrd(PRD),
    })).rejects.toThrow(/PRD_EDIT_CONFLICT/);
  });

  it("extracts unique acceptance criteria, allows repeated references and rejects missing ids", () => {
    expect(extractAcceptanceCriteria(PRD)).toEqual([
      { id: "AC-001", text: "可以按门店查询订单。" },
      { id: "AC-002", text: "查询失败后显示可重试提示。" },
    ]);
    expect(extractAcceptanceCriteria(`${PRD}\n## 需求追踪\n\n用户故事引用 [AC-001]。\n\n| 验收项 | 页面 |\n| --- | --- |\n| [AC-001] | 订单页 |\n`))
      .toEqual([
        { id: "AC-001", text: "可以按门店查询订单。" },
        { id: "AC-002", text: "查询失败后显示可重试提示。" },
      ]);
    expect(extractAcceptanceCriteria("## 用户故事\n- [AC-001] 关联订单页\n\n## 验收标准\n- [AC-001] 查询结果必须展示门店订单\n"))
      .toEqual([{ id: "AC-001", text: "查询结果必须展示门店订单" }]);
    expect(() => approvePrd("## 验收标准\n\n- 页面可打开", new Date())).toThrow(/AC-NNN/);
  });

  it("locks the confirmed content hash and detects any later mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-prd-lock-"));
    const path = join(root, "prd.md");
    await writeFile(path, PRD);
    const approved = approvePrd(PRD, new Date("2026-08-13T10:00:00.000Z"));

    await expect(assertApprovedPrd(path, approved)).resolves.toEqual(approved);
    await writeFile(path, PRD.replace("店长", "管理员"));
    await expect(assertApprovedPrd(path, approved)).rejects.toThrow(/PRD_LOCK_VIOLATION/);
  });
});
