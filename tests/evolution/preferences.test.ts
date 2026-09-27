import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreferenceEvolution } from "../../src/evolution/preferences.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flavor-preference-evolution-"));
  roots.push(root);
  return { root, engine: new PreferenceEvolution(root) };
}

const candidate = {
  type: "user" as const, content: "解释修改时先说影响，再列测试结果。",
  topicKey: "user.reporting-order", keywords: ["解释", "测试"],
};

describe("preference evolution", () => {
  it("records one exposure per task and attributable feedback for local outcome analysis", async () => {
    const root = await mkdtemp(join(tmpdir(), "flavor-preference-evolution-"));
    roots.push(root);
    const onExposure = vi.fn(async () => undefined);
    const onFeedback = vi.fn(async () => undefined);
    const engine = new PreferenceEvolution(root, { onExposure, onFeedback });
    const id = (await engine.propose(candidate, "source-a", true))!.id;
    await engine.contextForTask("请解释修改", "task-a");
    await engine.contextForTask("请解释修改", "task-a");
    expect(onExposure).toHaveBeenCalledOnce();
    expect(onExposure).toHaveBeenCalledWith("task-a", [id]);
    await engine.observeFeedback(`这条偏好 ${id} 错了`);
    expect(onFeedback).toHaveBeenCalledWith("task-a", [id], "negative");
  });

  it("requires two independent tasks before an inferred preference enters trial", async () => {
    const { root, engine } = await fixture();
    expect((await engine.propose(candidate, "task-a", false))?.status).toBe("proposed");
    await engine.propose(candidate, "task-a", false);
    expect((await engine.list())[0]?.status).toBe("proposed");
    expect((await engine.propose(candidate, "task-b", false))?.status).toBe("canary");
    const restarted = new PreferenceEvolution(root);
    expect(await restarted.contextForTask("请解释这次修改", "task-c")).toContain("解释修改时先说影响");
    expect((await restarted.list())[0]?.exposures).toEqual(["task-c"]);
  });

  it("activates an explicit instruction without copying the whole task prompt", async () => {
    const { engine } = await fixture();
    await engine.observeExplicitPrompt("以后请用中文解释，顺便修复登录模块。", "task-a");
    const [entry] = await engine.list();
    expect(entry).toMatchObject({ source: "explicit", status: "active", content: "以后请用中文解释" });
    expect(await engine.contextForTask("修复另一个模块", "task-b")).toContain("以后请用中文解释");
    await engine.observeExplicitPrompt("以后我会自己处理这些问题。", "task-c");
    expect(await engine.list()).toHaveLength(1);
  });

  it("promotes a trial only after enough distinct exposures and positive user evidence", async () => {
    const { engine } = await fixture();
    await engine.propose(candidate, "source-a", false);
    await engine.propose(candidate, "source-b", false);
    const id = (await engine.list())[0]!.id;
    for (let index = 0; index < 9; index++) {
      await engine.contextForTask("请解释修改", `use-${index}`);
      if (index === 3) await engine.observeFeedback(`这条偏好 ${id} 这样很好`);
    }
    expect((await engine.list())[0]?.status).toBe("canary");
    await engine.contextForTask("请解释修改", "use-9");
    expect(await engine.observeFeedback(`这条偏好 ${id} 这样很好`)).toBeUndefined();
    expect((await engine.list())[0]).toMatchObject({ status: "active" });
  });

  it("drops an inferred preference after attributable negative feedback and keeps a restore path", async () => {
    const { engine } = await fixture();
    await engine.propose(candidate, "task-a", false);
    await engine.propose(candidate, "task-b", false);
    await engine.contextForTask("请解释这次修改", "task-c");
    const id = (await engine.list())[0]!.id;
    expect(await engine.observeFeedback(`这条偏好 ${id} 错了，不要再用`)).toContain("Stopped");
    expect((await engine.list())[0]?.status).toBe("dropped");
    expect(await engine.contextForTask("请解释这次修改", "task-d")).toContain(`Preference [${id}] has been withdrawn`);
    expect(await engine.restore(id)).toBe(true);
    expect((await engine.list())[0]?.status).toBe("canary");
  });

  it("does not blame an unrelated task failure on an exposed preference", async () => {
    const { engine } = await fixture();
    await engine.propose(candidate, "task-a", false);
    await engine.propose(candidate, "task-b", false);
    await engine.contextForTask("解释修改", "task-c");
    expect(await engine.observeFeedback("登录模块报错了，请修复异常")).toBeUndefined();
    expect((await engine.list())[0]?.status).toBe("canary");
  });

  it("never re-proposes a dropped inferred preference from the same evidence", async () => {
    const { engine } = await fixture();
    const id = (await engine.propose(candidate, "task-a", false))!.id;
    await engine.drop(id);
    await engine.propose(candidate, "task-b", false);
    expect((await engine.list())[0]?.status).toBe("dropped");
    await engine.propose(candidate, "task-c", true);
    expect((await engine.list())[0]).toMatchObject({ status: "active", source: "explicit" });
  });

  it("requires user wording to support an automatic inference", async () => {
    const { engine } = await fixture();
    expect(await engine.propose(candidate, "task-a", false, ["修复登录模块的异常"])).toBeUndefined();
    expect(await engine.list()).toEqual([]);
    expect((await engine.propose(candidate, "task-a", false, ["解释修改时先说影响，再列测试结果"]))?.status)
      .toBe("proposed");
  });

  it("scopes inferred preferences to related tasks and clears stale feedback attribution", async () => {
    const { engine } = await fixture();
    await engine.propose(candidate, "source-a", false);
    await engine.propose(candidate, "source-b", false);
    await engine.contextForTask("请解释这次修改", "task-a");
    expect(await engine.contextForTask("修复登录模块", "task-b")).toBeUndefined();
    expect(await engine.observeFeedback("这条偏好错了")).toBeUndefined();
    expect((await engine.list())[0]).toMatchObject({ status: "canary", exposures: ["task-a"] });
  });

  it("does not promote from unrelated praise", async () => {
    const { engine } = await fixture();
    await engine.propose(candidate, "source-a", false);
    await engine.propose(candidate, "source-b", false);
    await engine.contextForTask("请解释这次修改", "task-a");
    await engine.observeFeedback("这次很好，登录模块也修好了");
    expect((await engine.list())[0]?.positiveTasks).toEqual([]);
  });
});
