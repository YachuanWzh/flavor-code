import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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

  it("starts the generated server as a plain Node process and tracks its exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "flavor-d2c-mock-")); dirs.push(dir);
    await mkdir(join(dir, "mock"), { recursive: true });
    await mkdir(join(dir, "node_modules", "express"), { recursive: true });
    await writeFile(join(dir, "node_modules", "express", "package.json"), '{"name":"express","version":"5.0.0"}');
    // Minimal stand-in for the generated Express mock: ready line plus the health probe endpoint.
    await writeFile(join(dir, "mock", "server.mjs"), [
      'import { createServer } from "node:http";',
      "const port = Number(process.env.D2C_MOCK_PORT);",
      "const server = createServer((_request, response) => { response.writeHead(200, { \"content-type\": \"application/json\" }); response.end('{\"ok\":true}'); });",
      'server.listen(port, "127.0.0.1", () => console.log(JSON.stringify({ type: "d2c-mock-ready", port })));',
    ].join("\n"));
    const running = await runD2cMockServer(dir, { installDependencies: false });
    try {
      expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(running.exited()).toBe(false);
      const health = await fetch(`${running.url}/_d2c/health`);
      expect(health.ok).toBe(true);
      expect(running.output()).not.toMatch(/gpu/i);
    } finally {
      await running.stop();
    }
    expect(running.exited()).toBe(true);
  }, 30_000);
});
