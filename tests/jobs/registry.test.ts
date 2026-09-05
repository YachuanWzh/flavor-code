import { describe, expect, it, vi } from "vitest";
import { getEventListeners } from "node:events";

import { JobRegistry } from "../../src/jobs/registry.js";
import { createJobTools } from "../../src/tools/jobs.js";

describe("JobRegistry", () => {
  it("releases wait listeners, enforces capacity, and reuses completed slots", async () => {
    const jobs = new JobRegistry({ maxJobs: 1 });
    const job = jobs.create({ kind: "shell", owner: "main", label: "first" });
    expect(() => jobs.create({ kind: "shell", owner: "main", label: "second" })).toThrow(/limit/);
    const signal = new AbortController().signal;
    const waiting = jobs.wait(job.id, "main", signal);
    job.complete();
    await waiting;
    expect(getEventListeners(signal, "abort")).toHaveLength(0);
    expect(() => jobs.create({ kind: "shell", owner: "main", label: "second" })).not.toThrow();
  });

  it("reports cancellation callback failures without unhandled rejections", async () => {
    const jobs = new JobRegistry();
    const job = jobs.create({ kind: "shell", owner: "main", label: "broken", cancel: async () => { throw new Error("kill failed"); } });
    jobs.kill(job.id, "main");
    await vi.waitFor(() => expect(jobs.read(job.id, "main")).toMatchObject({ state: "failed", error: "Cancellation failed: kill failed" }));
  });

  it("does not report a diagnostic with a null exit code as successful", () => {
    const jobs = new JobRegistry();
    const job = jobs.create({ kind: "shell", owner: "main", label: "terminated" });
    job.complete({ exitCode: null, error: "terminated by signal" });
    expect(jobs.read(job.id, "main").state).toBe("failed");
  });
  it("tracks incremental bounded output and terminal state", async () => {
    const jobs = new JobRegistry({ maxOutputChars: 8 });
    const job = jobs.create({ kind: "shell", owner: "main", label: "serve" });
    job.append("abcdef");
    const first = jobs.read(job.id, "main", 0);
    job.append("ghijkl");
    job.complete({ exitCode: 0 });

    expect(first).toMatchObject({ output: "abcdef", cursor: 6 });
    expect(jobs.read(job.id, "main", first.cursor)).toMatchObject({ output: "ghijkl", cursor: 12, truncated: true });
    expect(await jobs.wait(job.id, "main")).toMatchObject({ state: "completed", exitCode: 0 });
  });

  it("enforces owner isolation and cancellation", () => {
    const jobs = new JobRegistry();
    let killed = false;
    const job = jobs.create({ kind: "shell", owner: "subagent:a", label: "x", cancel: () => { killed = true; } });
    expect(() => jobs.read(job.id, "main", 0)).toThrow(/owner/i);
    jobs.kill(job.id, "subagent:a");
    expect(killed).toBe(true);
    expect(jobs.list("subagent:a")[0]?.state).toBe("cancelled");
  });

  it("marks a non-zero process exit as failed", async () => {
    const jobs = new JobRegistry();
    const job = jobs.create({ kind: "shell", owner: "main", label: "broken command" });
    job.complete({ exitCode: 1 });
    expect(await jobs.wait(job.id, "main")).toMatchObject({ state: "failed", exitCode: 1 });
  });

  it("builds semantic presentations for list, read, wait, and kill tools", async () => {
    const jobs = new JobRegistry();
    const job = jobs.create({ kind: "shell", owner: "main", label: "npm run verify" });
    job.append("phase one\nERR: failed\n");
    job.complete({ exitCode: 2 });
    const tools = createJobTools(jobs);
    const context = { agent: "main" as const };
    const signal = new AbortController().signal;
    for (const name of ["JobList", "JobRead", "JobWait", "JobKill"] as const) {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`missing ${name}`);
      const input = name === "JobList" ? {} : { id: job.id };
      const output = await tool.execute(input, signal, context);
      expect(tool.presentResult?.(output, input)).toMatchObject({ kind: "job", action: name.slice(3).toLowerCase() });
    }
  });
});
