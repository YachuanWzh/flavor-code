import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { GlobalInstructions } from "../../src/context/global-instructions.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("reads a manually created file and never creates one itself", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-global-instructions-"));
  roots.push(root);
  const source = new GlobalInstructions(root);

  await source.refresh();
  expect(source.content).toBeUndefined();
  expect(existsSync(join(root, ".flavor-code"))).toBe(false);

  await mkdir(join(root, ".flavor-code"));
  await writeFile(source.path, "  Prefer small functions.\n", "utf8");
  await source.refresh();
  expect(source.content).toBe("Prefer small functions.");

  await rm(source.path);
  await source.refresh();
  expect(source.content).toBeUndefined();
});

it("rejects oversized rules without replacing the last valid contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-global-instructions-"));
  roots.push(root);
  const source = new GlobalInstructions(root);
  await mkdir(join(root, ".flavor-code"));
  await writeFile(source.path, "Keep tests focused.");
  await source.refresh();
  await writeFile(source.path, "x".repeat(GlobalInstructions.MAX_BYTES + 1));

  await expect(source.refresh()).rejects.toThrow("exceed");
  expect(source.content).toBe("Keep tests focused.");
});

it("adds and forgets one rule while preserving hand-written Markdown", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-global-instructions-"));
  roots.push(root);
  const source = new GlobalInstructions(root);
  await mkdir(join(root, ".flavor-code"));
  const original = "\uFEFF# My conventions\r\n\r\nKeep this paragraph.\r\n\r\n- Use clear names.\r\n";
  await writeFile(source.path, original);

  expect(await source.remember("Keep tests focused.")).toBe("added");
  expect(await source.remember("Keep tests focused.")).toBe("already-present");
  expect((await readFile(source.path, "utf8")).match(/Keep tests focused\./gu)).toHaveLength(1);
  expect(await source.forget("clear names")).toBe("removed");
  const result = await readFile(source.path, "utf8");
  expect(result.startsWith("\uFEFF# My conventions\r\n")).toBe(true);
  expect(result).toContain("# My conventions\r\n\r\nKeep this paragraph.\r\n");
  expect(result).not.toContain("Use clear names.");
  expect(result).toContain("- Keep tests focused.\r\n");
  expect(source.content).toContain("Keep tests focused.");
});

it("does not guess when a forget query matches multiple rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-global-instructions-"));
  roots.push(root);
  const source = new GlobalInstructions(root);
  expect(await source.forget("tests")).toBe("not-found");
  expect(existsSync(source.path)).toBe(false);
  await mkdir(join(root, ".flavor-code"));
  const original = "- Keep unit tests focused.\n- Keep integration tests fast.\n";
  await writeFile(source.path, original);

  expect(await source.forget("tests")).toBe("ambiguous");
  expect(await readFile(source.path, "utf8")).toBe(original);
});

it("does not restore a deleted document from a stale backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-global-instructions-"));
  roots.push(root);
  const source = new GlobalInstructions(root);
  await mkdir(join(root, ".flavor-code"));
  await writeFile(`${source.path}.bak`, "- Old rule.\n");

  expect(await source.remember("New rule.")).toBe("added");
  expect(await readFile(source.path, "utf8")).toContain("- New rule.\n");
  expect(await readFile(source.path, "utf8")).not.toContain("Old rule.");
});
