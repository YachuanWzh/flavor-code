import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SESSION_VERSION, SessionStore, type SessionDocument } from "../../src/session/store.js";
import {
  ProjectSleepOrganizer,
  ProjectSleepScheduler,
  localDateKey,
  previousLocalDateKey,
} from "../../src/sleep/organizer.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-sleep-"));
  roots.push(root);
  return root;
}

function session(root: string, id: string, updatedAt: Date, text = "完成登录修复"): SessionDocument {
  return {
    version: SESSION_VERSION,
    sessionId: id,
    createdAt: updatedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    workspace: { path: root },
    conversation: { messages: [
      { role: "user", content: text },
      { role: "assistant", content: `${text}，测试通过` },
    ] },
    tasks: { states: {}, results: {} },
    models: { main: "capture:main", subagent: "capture:cheap" },
    permissionMode: "default",
    timeline: { version: 1, state: { completed: [], nextId: 1 } },
  };
}

const reviewJson = JSON.stringify({
  title: "登录流程复盘",
  taskSummary: ["修复登录流程并补齐测试"],
  executionReflection: ["先复现再修改，验证路径清晰"],
  decisionsAndLearnings: ["保留错误码作为稳定契约"],
  openQuestionsAndRisks: ["需要观察生产环境指标"],
  tomorrowPlan: ["检查发布后的登录成功率"],
});

describe("project sleep organizer", () => {
  it("uses local calendar dates across a year boundary", () => {
    const midnight = new Date(2027, 0, 1, 0, 0, 0, 0);
    expect(localDateKey(midnight)).toBe("2027-01-01");
    expect(previousLocalDateKey(midnight)).toBe("2026-12-31");
  });

  it("does not call the model or write a report when the previous day has no sessions", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(session(root, "session-today", new Date(2026, 6, 23, 10, 0)));
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => reviewJson);
    const organizer = new ProjectSleepOrganizer({ workspace: root, sessions: store, generate });

    await expect(organizer.organize("2026-07-22")).resolves.toEqual({ status: "no-sessions", date: "2026-07-22" });

    expect(generate).not.toHaveBeenCalled();
    await expect(readdir(join(root, ".flavor", "sleep"))).resolves.toEqual([]);
  });

  it("reviews only sessions updated on the target local day and renders all required sections", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(session(root, "session-target", new Date(2026, 6, 22, 21, 30), "修复登录"));
    await store.save(session(root, "session-other", new Date(2026, 6, 21, 21, 30), "旧任务"));
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => reviewJson);
    const organizer = new ProjectSleepOrganizer({ workspace: root, sessions: store, generate });

    const result = await organizer.organize("2026-07-22");

    expect(result).toMatchObject({ status: "written", date: "2026-07-22", sessionCount: 1 });
    expect(generate).toHaveBeenCalledTimes(1);
    const prompt = generate.mock.calls[0]?.[0] ?? "";
    expect(prompt).toContain("session-target");
    expect(prompt).toContain("修复登录");
    expect(prompt).not.toContain("session-other");
    expect(prompt).not.toContain("旧任务");
    const names = await readdir(join(root, ".flavor", "sleep"));
    expect(names).toEqual(["2026-07-22-登录流程复盘.md"]);
    const report = await readFile(join(root, ".flavor", "sleep", names[0]!), "utf8");
    for (const heading of [
      "当天任务摘要", "执行情况反思", "关键决策与收获", "未决事项与风险", "明日可能规划", "涉及会话",
    ]) expect(report).toContain(`## ${heading}`);
    expect(report).toContain("session-target");
  });

  it("is idempotent for repeated and concurrent runs in one project", async () => {
    const root = await workspace();
    const store = new SessionStore({ workspace: root });
    await store.save(session(root, "session-target", new Date(2026, 6, 22, 21, 30)));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const generate = vi.fn(async (_prompt: string, _signal: AbortSignal) => { await gate; return reviewJson; });
    const first = new ProjectSleepOrganizer({ workspace: root, sessions: store, generate });
    const second = new ProjectSleepOrganizer({ workspace: root, sessions: store, generate });

    const firstRun = first.organize("2026-07-22");
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    const secondResult = await second.organize("2026-07-22");
    release();
    const firstResult = await firstRun;
    const repeatedResult = await second.organize("2026-07-22");

    expect(firstResult.status).toBe("written");
    expect(secondResult.status).toBe("locked");
    expect(repeatedResult.status).toBe("exists");
    expect(generate).toHaveBeenCalledTimes(1);
  });
});

describe("project sleep scheduler", () => {
  it("does nothing when disabled", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 22, 23, 59, 59, 0));
    const organize = vi.fn(async () => undefined);
    const scheduler = new ProjectSleepScheduler({ enabled: false, organize });

    scheduler.start();
    vi.advanceTimersByTime(2_000);

    expect(organize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("organizes the day that just ended at local midnight and schedules the next one", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 22, 23, 59, 59, 0));
    const organize = vi.fn(async () => undefined);
    const scheduler = new ProjectSleepScheduler({ enabled: true, organize });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(organize).toHaveBeenCalledWith("2026-07-22", expect.any(AbortSignal));
    expect(vi.getTimerCount()).toBe(1);
    await scheduler.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
