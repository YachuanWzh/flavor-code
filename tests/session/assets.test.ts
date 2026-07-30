import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SessionAssetStore, type ImageAttachmentInput } from "../../src/session/assets.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flavor-assets-"));
  roots.push(root);
  return root;
}

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function attachment(overrides: Partial<ImageAttachmentInput> = {}): ImageAttachmentInput {
  return {
    name: "screenshot.png",
    mediaType: "image/png",
    dataBase64: png.toString("base64"),
    ...overrides,
  };
}

describe("SessionAssetStore", () => {
  it("stores validated image bytes outside session JSON and deduplicates by hash", async () => {
    const root = await workspace();
    const store = new SessionAssetStore({ workspace: root });

    const [first] = await store.store("session-one", [attachment()]);
    const [second] = await store.store("session-one", [attachment({ name: "copy.png" })]);

    expect(first).toMatchObject({
      type: "image",
      mediaType: "image/png",
      bytes: png.byteLength,
      name: "screenshot.png",
      source: { type: "file" },
    });
    expect(first?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(second?.source.path).toBe(first?.source.path);
    await expect(readFile(first!.source.path)).resolves.toEqual(png);
    await expect(readdir(join(root, ".flavor", "session-assets", "session-one"))).resolves.toHaveLength(1);
  });

  it("rejects spoofed media types and malformed base64", async () => {
    const store = new SessionAssetStore({ workspace: await workspace() });

    await expect(store.store("session-one", [attachment({ mediaType: "image/jpeg" })]))
      .rejects.toThrow(/does not match/i);
    await expect(store.store("session-one", [attachment({ dataBase64: "not base64!" })]))
      .rejects.toThrow(/base64/i);
  });

  it("enforces per-image, count, and session-id limits", async () => {
    const store = new SessionAssetStore({
      workspace: await workspace(),
      maxImageBytes: 8,
      maxTotalBytes: 12,
      maxImages: 2,
    });

    await expect(store.store("session-one", [attachment()])).rejects.toThrow(/maximum/i);
    await expect(store.store("../escape", [])).rejects.toThrow(/session id/i);
    await expect(store.store("session-one", [attachment(), attachment(), attachment()]))
      .rejects.toThrow(/at most 2/i);
  });
});
