import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { createFileTokenStore, type StoredToken } from "../../src/auth/store.js";

const alpha: StoredToken = {
  accessToken: "alpha-access-secret",
  refreshToken: "alpha-refresh-secret",
  expiresAt: "2030-01-01T00:00:00.000Z",
};
const beta: StoredToken = {
  accessToken: "beta-access-secret",
  expiresAt: "2030-02-01T00:00:00.000Z",
};

it("encrypts OAuth tokens at rest and loads the authenticated document", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-encrypted-"));
  const path = join(root, "auth.json");
  const store = createFileTokenStore(path);

  await store.save({ alpha });

  const raw = await readFile(path, "utf8");
  expect(raw).not.toContain(alpha.accessToken);
  expect(raw).not.toContain(alpha.refreshToken);
  expect(raw).toContain("flavor-file:v1:");
  await expect(createFileTokenStore(path).load()).resolves.toEqual({ alpha });
});

it("merges concurrent provider saves under the file lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-concurrent-"));
  const path = join(root, "auth.json");
  const first = createFileTokenStore(path);
  const second = createFileTokenStore(path);

  await Promise.all([first.save({ alpha }), second.save({ beta })]);

  await expect(createFileTokenStore(path).load()).resolves.toEqual({ alpha, beta });
});

it("preserves replacement semantics for providers removed from a loaded snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-delete-"));
  const path = join(root, "auth.json");
  const seed = createFileTokenStore(path);
  await seed.save({ alpha, beta });

  const store = createFileTokenStore(path);
  const tokens = await store.load();
  delete tokens.alpha;
  await store.save(tokens);

  await expect(createFileTokenStore(path).load()).resolves.toEqual({ beta });
});

it("recovers OAuth tokens from an authenticated backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-backup-"));
  const path = join(root, "auth.json");
  const store = createFileTokenStore(path);
  await store.save({ alpha });
  await store.save({ alpha, beta });
  await writeFile(path, "{ corrupted");

  await expect(createFileTokenStore(path).load()).resolves.toEqual({ alpha });
});

it("treats an invalid provider entry as corruption and recovers the backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-invalid-entry-"));
  const path = join(root, "auth.json");
  const store = createFileTokenStore(path);
  await store.save({ alpha });
  await store.save({ alpha, beta });
  await writeFile(path, JSON.stringify({ broken: { accessToken: "" } }));

  await expect(createFileTokenStore(path).load()).resolves.toEqual({ alpha });
});

it("fails closed when both OAuth ciphertext and backup fail authentication", async () => {
  const root = await mkdtemp(join(tmpdir(), "flavor-auth-integrity-"));
  const path = join(root, "auth.json");
  const store = createFileTokenStore(path);
  await store.save({ alpha });
  await store.save({ alpha, beta });
  const tamper = (raw: string) => {
    const envelope = JSON.parse(raw) as string;
    const separator = envelope.lastIndexOf(":");
    const ciphertext = envelope.slice(separator + 1);
    const changed = `${ciphertext[0] === "A" ? "B" : "A"}${ciphertext.slice(1)}`;
    return JSON.stringify(`${envelope.slice(0, separator + 1)}${changed}`);
  };
  await writeFile(path, tamper(await readFile(path, "utf8")));
  await writeFile(`${path}.bak`, tamper(await readFile(`${path}.bak`, "utf8")));

  await expect(createFileTokenStore(path).load()).rejects.toThrow(/authentic|decrypt|integrity|invalid/i);
});
