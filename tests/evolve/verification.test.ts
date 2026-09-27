import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scaffoldFixPlugin, snapshotFixPlugin } from "../../src/evolve/loader.js";
import { EvolveVerificationStore, hashFixPlugin, unverifiedFixPlugins } from "../../src/evolve/verification.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "flavor-evolve-verification-"));
  roots.push(root);
  await scaffoldFixPlugin(root, "fix-read");
  return { root, store: new EvolveVerificationStore(root), plugin: join(root, ".flavor", "plugins", "fix-read") };
}

describe("version-bound fix plugin verification", () => {
  it("blocks startup until the exact tested version has been activated", async () => {
    const { root, store } = await fixture();
    const digest = await hashFixPlugin(root, "fix-read");
    expect(await unverifiedFixPlugins(root, store)).toEqual(["fix-read"]);
    await store.markVerified("fix-read", digest);
    expect(await store.eligible("fix-read", digest)).toBe(false);
    await store.markTested("fix-read", digest, "npm test");
    expect(await store.eligible("fix-read", digest)).toBe(true);
    expect(await unverifiedFixPlugins(root, store)).toEqual(["fix-read"]);
    const snapshot = await snapshotFixPlugin(root, "fix-read");
    await store.markActive("fix-read", digest, snapshot);
    expect(await unverifiedFixPlugins(root, store)).toEqual([]);
    expect(await store.goodSnapshot("fix-read")).toBe(snapshot);
  });

  it("invalidates approval when even one plugin byte changes and keeps last-good rollback", async () => {
    const { root, store, plugin } = await fixture();
    const original = await hashFixPlugin(root, "fix-read");
    await store.markVerified("fix-read", original);
    await store.markTested("fix-read", original, "npm test");
    const snapshot = await snapshotFixPlugin(root, "fix-read");
    await store.markActive("fix-read", original, snapshot);
    const entry = join(plugin, "index.js");
    await writeFile(entry, `${await readFile(entry, "utf8")}\n// changed\n`);
    const changed = await hashFixPlugin(root, "fix-read");
    expect(changed).not.toBe(original);
    expect(await store.eligible("fix-read", changed)).toBe(false);
    expect(await unverifiedFixPlugins(root, store)).toEqual(["fix-read"]);
    await store.markVerified("fix-read", changed);
    expect(await store.goodSnapshot("fix-read")).toBe(snapshot);
  });

  it("rejects path traversal and special plugin names", async () => {
    const { root } = await fixture();
    await expect(hashFixPlugin(root, "../outside")).rejects.toThrow();
    await mkdir(join(root, ".flavor", "plugins", "fix-bad_name"));
    expect(await unverifiedFixPlugins(root)).toContain("fix-bad_name");
  });
});
