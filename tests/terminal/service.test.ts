import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { JobRegistry } from "../../src/jobs/registry.js";
import { TerminalService, type PtyLike } from "../../src/terminal/service.js";
import { createTerminalTools } from "../../src/tools/terminal.js";

class FakePty implements PtyLike {
  data = (_value: string): void => undefined;
  exit = (_event: { exitCode: number }): void => undefined;
  writes: string[] = [];
  size = { columns: 0, rows: 0 };
  killed = false;
  write(value: string): void { this.writes.push(value); }
  resize(columns: number, rows: number): void { this.size = { columns, rows }; }
  kill(): void { this.killed = true; }
  onData(listener: (data: string) => void) { this.data = listener; return { dispose: () => undefined }; }
  onExit(listener: (event: { exitCode: number }) => void) { this.exit = listener; return { dispose: () => undefined }; }
}

describe("TerminalService", () => {
  it("rejects writes to exited sessions and cleans up PTYs when job registration fails", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-terminal-"));
    const backend = new FakePty();
    const service = new TerminalService(root, { factory: () => backend });
    const opened = service.open({ owner: "main" });
    backend.exit({ exitCode: 0 });
    expect(() => service.write(opened.id, "main", "echo x")).toThrow(/exited/);
    expect(backend.writes).toEqual([]);
    service.dispose();
    const jobs = new JobRegistry({ maxJobs: 1 });
    jobs.create({ kind: "shell", owner: "main", label: "busy" });
    const failing = new TerminalService(root, { jobs, factory: () => backend });
    expect(() => failing.open({ owner: "main" })).toThrow(/limit/);
    expect(backend.killed).toBe(true);
  });
  it("keeps an interactive PTY alive across writes and cursor reads", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-terminal-"));
    const jobs = new JobRegistry();
    const backend = new FakePty();
    const service = new TerminalService(root, { jobs, factory: () => backend, maxOutputChars: 6 });
    const opened = service.open({ owner: "main", shell: "fake" });
    service.write(opened.id, "main", "echo one\r");
    backend.data("abcdef");
    const first = service.read(opened.id, "main");
    backend.data("gh");

    expect(backend.writes).toEqual(["echo one\r"]);
    expect(service.read(opened.id, "main", first.cursor)).toMatchObject({ output: "gh", cursor: 8, truncated: true });
    expect(jobs.list("main")[0]).toMatchObject({ kind: "terminal", state: "running" });
    backend.exit({ exitCode: 0 });
    expect(service.list("main")[0]).toMatchObject({ state: "exited", exitCode: 0 });
  });

  it("enforces workspace and owner boundaries and kills sessions on dispose", () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-terminal-"));
    const backend = new FakePty();
    const service = new TerminalService(root, { factory: () => backend });
    expect(() => service.open({ owner: "main", cwd: ".." })).toThrow(/outside/);
    const opened = service.open({ owner: "main" });
    expect(() => service.read(opened.id, "subagent")).toThrow(/owner/);
    service.dispose();
    expect(backend.killed).toBe(true);
  });

  it("presents persistent terminal output as a terminal rather than a command", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-terminal-"));
    const backend = new FakePty();
    const service = new TerminalService(root, { factory: () => backend });
    const tools = createTerminalTools(service, root);
    const context = { agent: "main" as const };
    const signal = new AbortController().signal;
    const open = tools.find((tool) => tool.name === "TerminalOpen");
    const read = tools.find((tool) => tool.name === "TerminalRead");
    if (open === undefined || read === undefined) throw new Error("terminal tools missing");
    const opened = await open.execute({}, signal, context) as { id: string };
    backend.data("interactive output\n");
    const result = await read.execute({ id: opened.id }, signal, context);
    expect(JSON.parse(read.renderForModel!(result, { id: opened.id }))).toMatchObject({ id: opened.id, cursor: 19, state: "running", output: "interactive output\n" });

    expect(open.presentResult?.(opened, {})).toMatchObject({ kind: "terminal", variant: "terminal", state: "running" });
    expect(read.presentResult?.(result, { id: opened.id })).toMatchObject({
      kind: "terminal", variant: "terminal", state: "running", stdout: "interactive output\n",
    });
    service.dispose();
  });

  it("normalizes string-form enter flags from weak-typed models", async () => {
    const root = mkdtempSync(join(tmpdir(), "flavor-terminal-"));
    const backend = new FakePty();
    const service = new TerminalService(root, { factory: () => backend });
    const tools = createTerminalTools(service, root);
    const context = { agent: "main" as const };
    const signal = new AbortController().signal;
    const open = tools.find((tool) => tool.name === "TerminalOpen");
    const write = tools.find((tool) => tool.name === "TerminalWrite");
    if (open === undefined || write === undefined) throw new Error("terminal tools missing");
    const opened = await open.execute({}, signal, context) as { id: string };

    const parsed = write.inputSchema.safeParse({ id: opened.id, data: "ls", enter: "true" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect((parsed.data as { enter: unknown }).enter).toBe("true");
    expect(write.inputSchema.safeParse({ id: opened.id, data: "ls", enter: "yes" }).success).toBe(false);
    await write.execute({ id: opened.id, data: "ls", enter: "true" }, signal, context);
    // "false" is truthy as a string, so it must normalize to a plain newline-less write.
    await write.execute({ id: opened.id, data: "pwd", enter: "false" }, signal, context);

    expect(backend.writes).toEqual(["ls\r", "pwd"]);
    service.dispose();
  });
});
