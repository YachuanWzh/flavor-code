import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { parseMockReadyLine, runD2cMockServer } from "../../src/d2c/mock-runner.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("D2C mock runner", () => {
  it("parses only bounded ready events with valid ports", () => {
    expect(parseMockReadyLine('{"type":"d2c-mock-ready","port":3210}')).toBe(3210);
    expect(parseMockReadyLine('{"type":"other","port":3210}')).toBeUndefined();
    expect(parseMockReadyLine('{"type":"d2c-mock-ready","port":70000}')).toBeUndefined();
    expect(parseMockReadyLine("garbage")).toBeUndefined();
  });

  it("rejects a project without generated mock files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-mock-")); dirs.push(dir);
    await expect(runD2cMockServer(dir, { installDependencies: false })).rejects.toThrow(/mock|server/i);
  });
});
