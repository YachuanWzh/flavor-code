import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ request: mocks.request }));
vi.mock("node:https", () => ({ request: mocks.request }));
import { fetchPublic } from "../../src/tools/web.js";

const signal = new AbortController().signal;
beforeEach(() => { mocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]); mocks.request.mockReset(); });
afterEach(() => vi.useRealTimers());

function response(body: string, contentType: string, end = true): PassThrough {
  const stream = Object.assign(new PassThrough(), { statusCode: 200, headers: { "content-type": contentType } });
  mocks.request.mockImplementation((_options, callback) => {
    const request = Object.assign(new EventEmitter(), {
      end: () => { callback(stream); stream.write(body); if (end) stream.end(); },
      destroy: (error: Error) => request.emit("error", error),
    });
    return request;
  });
  return stream;
}

describe("WebFetch transport limits", () => {
  it("includes DNS resolution in the total timeout", async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    await expect(fetchPublic("https://example.com", { signal, timeoutMs: 20, maxBytes: 10 })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("cancels DNS resolution without waiting for the resolver", async () => {
    mocks.lookup.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const result = fetchPublic("https://example.com", { signal: controller.signal, timeoutMs: 30, maxBytes: 10 });
    controller.abort(new Error("stop DNS"));
    await expect(result).rejects.toThrow("stop DNS");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("returns immediately after exceeding the byte cap even if the server stays open", async () => {
    const stream = response("abcdefgh", "text/plain", false);
    const result = await fetchPublic("https://example.com", { signal, timeoutMs: 1000, maxBytes: 4 });
    expect(result).toMatchObject({ content: "abcd", truncated: true });
    expect(stream.destroyed).toBe(true);
  });

  it("falls back to UTF-8 for unsupported charset labels", async () => {
    response("你好", "text/plain; charset=unknown-encoding");
    const result = await fetchPublic("https://example.com", { signal, timeoutMs: 1000, maxBytes: 100 });
    expect(result.content).toBe("你好");
  });
});
