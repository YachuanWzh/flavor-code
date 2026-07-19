import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { updateProtectedFile } from "../../src/config/protected-file.js";

it("does not steal an old lock owned by a live process", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-live-lock-"));
  const path = join(root, "flavor.json");
  const lockPath = `${path}.lock`;
  await writeFile(path, "0");
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: "live" }));
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  await expect(updateProtectedFile<number>({
    path,
    decode: (raw) => Number(raw),
    encode: String,
    update: (current) => (current ?? 0) + 1,
    lockTimeoutMs: 40,
    staleLockMs: 1,
  })).rejects.toThrow(/timed out/i);
  expect(await readFile(path, "utf8")).toBe("0");
  expect(await readFile(lockPath, "utf8")).toContain(`\"pid\":${process.pid}`);
});
