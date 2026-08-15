import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { acquirePalFileLock } from "../../src/pals/lifecycle.js";

describe("pals endpoint/startup ownership locks", () => {
  it("reclaims a dead owner's exact lock and only its owner can release it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flavor-pals-lock-"));
    const path = join(directory, "startup.lock");
    await writeFile(path, JSON.stringify({ pid: 111, createdAt: 1, nonce: "dead" }), "utf8");
    const lock = await acquirePalFileLock({
      path, pid: 222, now: () => 10, processAlive: (pid) => pid !== 111, endpointLive: async () => false,
    });
    expect(lock).toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 222, createdAt: 10 });
    await lock!.release();
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not steal from a live owner or when the endpoint is live", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flavor-pals-lock-live-"));
    const path = join(directory, "startup.lock");
    await writeFile(path, JSON.stringify({ pid: 111, createdAt: 1, nonce: "live" }), "utf8");
    await expect(acquirePalFileLock({
      path, pid: 222, processAlive: () => true, endpointLive: async () => false,
    })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ pid: 111 });
    await expect(acquirePalFileLock({
      path: join(directory, "other.lock"), pid: 222, processAlive: () => false, endpointLive: async () => true,
    })).resolves.toBeUndefined();
  });

  it("keeps fresh corrupt locks but reclaims them after a bounded grace period", async () => {
    const directory = await mkdtemp(join(tmpdir(), "flavor-pals-lock-corrupt-"));
    const path = join(directory, "startup.lock");
    await writeFile(path, "partial", "utf8");
    const now = Date.now();
    await utimes(path, new Date(now), new Date(now));
    const options = { path, pid: 222, now: () => now, processAlive: vi.fn(() => false), endpointLive: async () => false, corruptGraceMs: 1000 };
    await expect(acquirePalFileLock(options)).resolves.toBeUndefined();
    await utimes(path, new Date(now - 2000), new Date(now - 2000));
    const reclaimed = await acquirePalFileLock(options);
    expect(reclaimed).toBeDefined();
    await reclaimed!.release();
  });
});
