import { describe, expect, it } from "vitest";

import {
  NPM_PACKAGE_NAME,
  checkForUpdate,
  fetchLatestVersion,
  findNewerVersion,
  type RegistryFetch,
} from "../../src/update/check.js";

type FetchImpl = RegistryFetch;

const respondWith = (ok: boolean, body: unknown): FetchImpl => async () => ({
  ok,
  json: async () => body,
});

describe("findNewerVersion", () => {
  it("returns the latest version only when it is strictly newer", () => {
    expect(findNewerVersion("1.3.17", "1.3.20")).toBe("1.3.20");
    expect(findNewerVersion("1.3.17", "1.4.0")).toBe("1.4.0");
    expect(findNewerVersion("1.3.17", "1.3.17")).toBeUndefined();
    expect(findNewerVersion("1.4.0", "1.3.17")).toBeUndefined();
  });

  it("returns undefined when either version is not valid semver", () => {
    expect(findNewerVersion("1.3.17", "garbage")).toBeUndefined();
    expect(findNewerVersion("beta", "1.3.20")).toBeUndefined();
  });
});

describe("fetchLatestVersion", () => {
  it("queries the npm registry latest endpoint for this package", async () => {
    let requestedUrl = "";
    const fetchImpl: FetchImpl = async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ version: "9.9.9" }) };
    };

    await expect(fetchLatestVersion({ fetchImpl })).resolves.toBe("9.9.9");
    expect(requestedUrl).toContain(NPM_PACKAGE_NAME);
    expect(requestedUrl).toContain("registry.npmjs.org");
    expect(requestedUrl).toMatch(/\/latest$/u);
  });

  it("returns undefined for non-ok responses or missing version fields", async () => {
    await expect(fetchLatestVersion({ fetchImpl: respondWith(false, {}) })).resolves.toBeUndefined();
    await expect(fetchLatestVersion({ fetchImpl: respondWith(true, {}) })).resolves.toBeUndefined();
    await expect(fetchLatestVersion({ fetchImpl: respondWith(true, { version: 42 }) })).resolves.toBeUndefined();
  });

  it("returns undefined when the request throws (offline, DNS failure, ...)", async () => {
    const fetchImpl: FetchImpl = async () => {
      throw new Error("network down");
    };
    await expect(fetchLatestVersion({ fetchImpl })).resolves.toBeUndefined();
  });

  it("gives up without hanging when the request never settles", async () => {
    const fetchImpl: FetchImpl = () => new Promise(() => {});
    await expect(fetchLatestVersion({ fetchImpl, timeoutMs: 20 })).resolves.toBeUndefined();
  });
});

describe("checkForUpdate", () => {
  it("resolves the newer version when the registry has one", async () => {
    await expect(
      checkForUpdate("1.3.17", { fetchImpl: respondWith(true, { version: "1.3.20" }) }),
    ).resolves.toBe("1.3.20");
  });

  it("resolves undefined when already current or the lookup failed", async () => {
    await expect(
      checkForUpdate("1.3.17", { fetchImpl: respondWith(true, { version: "1.3.17" }) }),
    ).resolves.toBeUndefined();
    await expect(
      checkForUpdate("1.3.17", { fetchImpl: respondWith(false, {}) }),
    ).resolves.toBeUndefined();
  });
});
