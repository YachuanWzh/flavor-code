import { describe, expect, it } from "vitest";

import {
  applyD2cAgentProgress,
  applyD2cEngineProgress,
  createD2cPendingTask,
} from "../../src/desktop/renderer/d2c-progress.js";

describe("D2C execution progress", () => {
  it("derives real phases and bounded activity from agent events", () => {
    let pending = createD2cPendingTask("homepage", "vue", 1_000);
    pending = applyD2cAgentProgress(pending, { type: "model-start", id: "m1" }, 2_000);
    pending = applyD2cAgentProgress(pending, {
      type: "tool-start", id: "w1", name: "Write", input: {}, label: "App.vue",
    }, 3_000);
    pending = applyD2cAgentProgress(pending, {
      type: "tool-end", id: "w1", name: "Write", result: { ok: true, output: "done" }, label: "App.vue",
    }, 4_000);

    expect(pending.phase).toBe("building");
    expect(pending.activity).toContainEqual(expect.objectContaining({ id: "tool:w1", label: "创建 App.vue", state: "completed" }));

    for (let index = 0; index < 20; index += 1) {
      pending = applyD2cAgentProgress(pending, {
        type: "tool-start", id: `r${index}`, name: "Read", input: {}, label: `${index}.css`,
      }, 5_000 + index);
    }
    expect(pending.activity).toHaveLength(12);
    expect(pending.activity.at(-1)).toMatchObject({ label: "读取 19.css" });
  });

  it("surfaces internal comparison stages without inventing a percentage", () => {
    let pending = createD2cPendingTask("homepage", "react", 1_000);
    pending = applyD2cEngineProgress(pending, {
      task: "homepage", cycle: 1, stage: "dependencies", state: "running", message: "正在准备项目依赖",
    }, 2_000);
    pending = applyD2cEngineProgress(pending, {
      task: "homepage", cycle: 1, stage: "capture-design", state: "completed", message: "设计稿快照已就绪", cached: true,
    }, 3_000);

    expect(pending.phase).toBe("evaluating");
    expect(pending.comparisonCycle).toBe(1);
    expect(pending.activity).toContainEqual(expect.objectContaining({
      id: "engine:1:capture-design", state: "completed", detail: "已复用缓存",
    }));
    expect(pending).not.toHaveProperty("percent");
  });

  it("ignores progress belonging to another D2C task", () => {
    const pending = createD2cPendingTask("homepage", "vue", 1_000);
    expect(applyD2cEngineProgress(pending, {
      task: "other", cycle: 1, stage: "report", state: "completed", message: "done",
    }, 2_000)).toBe(pending);
  });
});
