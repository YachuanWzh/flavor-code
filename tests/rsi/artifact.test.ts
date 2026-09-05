import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
  artifactManifestHash,
  buildArtifactManifest,
  canonicalArtifactManifestJson,
  freezeArtifact,
  normalizeArtifactEntryPath,
  verifyArtifact,
} from "../../src/rsi/artifact.js";

interface Fixture {
  root: string;
  store: string;
}

async function makeFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "flavor-rsi-artifact-"));
  const store = await mkdtemp(join(tmpdir(), "flavor-rsi-store-dir-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "assets"), { recursive: true });
  await writeFile(join(root, "plugin.json"), '{"name":"candidate-a"}\n', "utf8");
  await writeFile(join(root, "src", "index.ts"), "export const value = 1;\n", "utf8");
  await writeFile(join(root, "src", "helper.mjs"), "export const help = 2;\n", "utf8");
  await writeFile(join(root, "assets", "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]), "utf8");
  return { root, store };
}

const BASE_ENTRIES = ["plugin.json", "src/index.ts", "src/helper.mjs", "assets/icon.png"];

function baseInput(root: string, overrides: Record<string, unknown> = {}): Parameters<typeof buildArtifactManifest>[0] {
  return {
    root,
    entries: BASE_ENTRIES,
    runtimeMode: "isolated",
    config: { mode: "strict", retries: 2 },
    stateSchemaVersion: 3,
    dependencyIds: ["dep-b", "dep-a"],
    ...overrides,
  };
}

describe("RSI artifact manifest (rsi.md E5, P0-04a)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await makeFixture();
  });

  it("hashes independently of entry listing and dependency declaration order", async () => {
    const shuffled = await buildArtifactManifest(baseInput(fixture.root, {
      entries: ["src/helper.mjs", "assets/icon.png", "plugin.json", "src/index.ts"],
    }));
    const ordered = await buildArtifactManifest(baseInput(fixture.root));
    const shuffledDeps = await buildArtifactManifest(baseInput(fixture.root, { dependencyIds: ["dep-a", "dep-b"] }));
    expect(artifactManifestHash(shuffled)).toBe(artifactManifestHash(ordered));
    expect(artifactManifestHash(shuffledDeps)).toBe(artifactManifestHash(ordered));
    expect(shuffled.files.map((file) => file.path)).toEqual(["assets/icon.png", "plugin.json", "src/helper.mjs", "src/index.ts"]);
  });

  it("changes the hash for helper-only edits, config, runtime state schema, and dependencies", async () => {
    const baseline = await buildArtifactManifest(baseInput(fixture.root));
    const baselineHash = artifactManifestHash(baseline);

    await writeFile(join(fixture.root, "src", "helper.mjs"), "export const help = 3;\n", "utf8");
    const helperEdited = await buildArtifactManifest(baseInput(fixture.root));
    expect(artifactManifestHash(helperEdited)).not.toBe(baselineHash);

    await writeFile(join(fixture.root, "src", "helper.mjs"), "export const help = 2;\n", "utf8");
    const restored = await buildArtifactManifest(baseInput(fixture.root));
    expect(artifactManifestHash(restored)).toBe(baselineHash);

    for (const overrides of [
      { config: { mode: "strict", retries: 3 } },
      { stateSchemaVersion: 4 },
      { dependencyIds: ["dep-a", "dep-c"] },
    ]) {
      const changed = await buildArtifactManifest(baseInput(fixture.root, overrides));
      expect(artifactManifestHash(changed)).not.toBe(baselineHash);
    }
  });

  it("relocating identical content to another path changes the hash (path is bound)", async () => {
    const baseline = artifactManifestHash(await buildArtifactManifest(baseInput(fixture.root)));
    await mkdir(join(fixture.root, "src2"), { recursive: true });
    await writeFile(join(fixture.root, "src2", "index.ts"), "export const value = 1;\n", "utf8");
    const moved = artifactManifestHash(await buildArtifactManifest(baseInput(fixture.root, {
      entries: ["plugin.json", "src2/index.ts", "src/helper.mjs", "assets/icon.png"],
    })));
    expect(moved).not.toBe(baseline);
  });

  it("rejects traversal, absolute paths, duplicates, and Windows case collisions", async () => {
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: ["../outside.txt"] })))
      .rejects.toThrow(/escapes the artifact root/);
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: ["C:/Windows/win.ini"] })))
      .rejects.toThrow(/relative/);
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: ["/etc/passwd"] })))
      .rejects.toThrow(/relative/);
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: ["plugin.json", "plugin.json"] })))
      .rejects.toThrow(/Duplicate/);
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: ["src/index.ts", "src/INDEX.ts"] })))
      .rejects.toThrow(/case-insensitive/);
    expect(normalizeArtifactEntryPath("./src\\a.ts")).toBe("src/a.ts");
  });

  it("refuses a symlinked entry when links are permitted, without hashing outside content", async () => {
    const external = join(fixture.store, "secret.txt");
    await writeFile(external, "not part of the artifact", "utf8");
    let created = true;
    try {
      await symlink(external, join(fixture.root, "src", "link.ts"));
    } catch {
      created = false; // Windows without developer privileges: EPERM
    }
    if (!created) {
      expect(true).toBe(true);
      return;
    }
    await expect(buildArtifactManifest(baseInput(fixture.root, {
      entries: [...BASE_ENTRIES, "src/link.ts"],
    }))).rejects.toThrow(/symbolic link/);
  });

  it("freezes content-addressed storage and re-verifies the stored bytes", async () => {
    const manifest = await buildArtifactManifest(baseInput(fixture.root));
    const frozen = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });
    expect(frozen.artifactHash).toMatch(/^[a-f0-9]{64}$/);
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash })).resolves.toEqual(manifest);
    // Re-freeze is a verified no-op over immutable content.
    const again = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });
    expect(again.artifactHash).toBe(frozen.artifactHash);
  });

  it("detects tampering with a frozen file or its manifest", async () => {
    const manifest = await buildArtifactManifest(baseInput(fixture.root));
    const frozen = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });

    await writeFile(join(frozen.directory, "files", "src", "index.ts"), "export const value = 999;\n", "utf8");
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash }))
      .rejects.toThrow(/tampered after sealing/);
    await writeFile(join(frozen.directory, "files", "src", "index.ts"), "export const value = 1;\n", "utf8");

    const forged = structuredClone(manifest);
    forged.files[1] = { ...forged.files[1]!, sha256: "0".repeat(64) };
    await writeFile(join(frozen.directory, "manifest.json"), `${canonicalArtifactManifestJson(forged)}\n`, "utf8");
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash }))
      .rejects.toThrow(/does not hash to its content-address/);
  });

  it("refuses to freeze after the source drifted from the built manifest", async () => {
    const manifest = await buildArtifactManifest(baseInput(fixture.root));
    await writeFile(join(fixture.root, "src", "index.ts"), "drifted after build\n", "utf8");
    await expect(freezeArtifact({ store: fixture.store, root: fixture.root, manifest }))
      .rejects.toThrow(/changed while freezing/);
  });

  it("rejects non-isolated runtime modes and empty file sets", async () => {
    await expect(buildArtifactManifest(baseInput(fixture.root, { runtimeMode: "in-process" as never })))
      .rejects.toThrow();
    await expect(buildArtifactManifest(baseInput(fixture.root, { entries: [] }))).rejects.toThrow();
  });

  it("accepts a file whose name repeats its parent directory segment", async () => {
    await mkdir(join(fixture.root, "same"), { recursive: true });
    await writeFile(join(fixture.root, "same", "same"), "ok\n", "utf8");
    const manifest = await buildArtifactManifest(baseInput(fixture.root, {
      entries: [...BASE_ENTRIES, "same/same"],
    }));
    expect(manifest.files.map((file) => file.path)).toContain("same/same");
    const frozen = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash }))
      .resolves.toEqual(manifest);
  });

  it("rejects a frozen subtree swapped for an out-of-tree junction with identical content", async () => {
    const manifest = await buildArtifactManifest(baseInput(fixture.root));
    const frozen = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });
    const external = join(fixture.store, "external-src");
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "index.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(external, "helper.mjs"), "export const help = 2;\n", "utf8");
    await rm(join(frozen.directory, "files", "src"), { recursive: true, force: true });
    let linked = true;
    try {
      await symlink(external, join(frozen.directory, "files", "src"), process.platform === "win32" ? "junction" : "dir");
    } catch {
      linked = false; // platform without link privileges
    }
    if (!linked) return;
    // Byte-level hashes would still pass; the physical boundary must not.
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash }))
      .rejects.toThrow(/outside|symbolic link|link/);
  });

  it("rejects files smuggled into the frozen tree that the manifest does not list", async () => {
    const manifest = await buildArtifactManifest(baseInput(fixture.root));
    const frozen = await freezeArtifact({ store: fixture.store, root: fixture.root, manifest });
    await writeFile(join(frozen.directory, "files", "extra.txt"), "not in the manifest\n", "utf8");
    await expect(verifyArtifact({ store: fixture.store, artifactHash: frozen.artifactHash }))
      .rejects.toThrow(/not listed in the manifest/);
  });

  it("uses one recursive canonical encoding for both JSON output and hashing", async () => {
    const a = await buildArtifactManifest(baseInput(fixture.root, {
      config: { mode: "strict", retries: 2, opts: { z: 1, a: { y: 2, b: 3 } } },
    }));
    const b = await buildArtifactManifest(baseInput(fixture.root, {
      config: { retries: 2, opts: { a: { b: 3, y: 2 }, z: 1 }, mode: "strict" },
    }));
    expect(artifactManifestHash(a)).toBe(artifactManifestHash(b));
    expect(canonicalArtifactManifestJson(a)).toBe(canonicalArtifactManifestJson(b));
    // Cross-implementation recomputation: the hash IS sha256 over exactly
    // the canonical bytes, no second serialization rule.
    expect(createHash("sha256").update(canonicalArtifactManifestJson(a)).digest("hex"))
      .toBe(artifactManifestHash(a));
  });
});
