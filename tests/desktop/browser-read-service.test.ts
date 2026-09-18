import { describe, expect, it } from "vitest";

import { READ_PAGE_FUNCTION, readViaCdp } from "../../src/desktop/browser/read-service.js";
import type { RefRegistry } from "../../src/desktop/browser/snapshot.js";
import type { SnapshotCommander } from "../../src/desktop/browser/snapshot-service.js";

interface Sent {
  method: string;
  params?: Record<string, unknown>;
}

function fakeCommander(handlers: Record<string, () => unknown> = {}): { commander: SnapshotCommander; sent: Sent[] } {
  const sent: Sent[] = [];
  const commander = {
    sendCommand: (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      sent.push({ method, ...(params === undefined ? {} : { params }) });
      return Promise.resolve(handlers[method]?.() ?? {});
    },
  } as unknown as SnapshotCommander;
  return { commander, sent };
}

const registryStub = {
  resolve: (ref: number) => ({ frameId: "main", backendNodeId: ref * 10 }),
} as unknown as RefRegistry;

describe("readViaCdp", () => {
  it("reads the whole document through Runtime.evaluate", async () => {
    const { commander, sent } = fakeCommander({
      "Runtime.evaluate": () => ({ result: { value: "页面正文" } }),
    });
    const result = await readViaCdp(commander, registryStub, { mode: "text" });
    expect(result.scope).toBe("document");
    expect(result.text).toBe("页面正文");
    const expression = String((sent[0]?.params as { expression: string }).expression);
    expect(expression).toContain(".call(undefined,");
  });

  it("resolves a snapshot ref to a runtime object before callFunctionOn", async () => {
    const { commander, sent } = fakeCommander({
      "DOM.resolveNode": () => ({ object: { objectId: "object-40" } }),
      "Runtime.callFunctionOn": () => ({ result: { value: "input-value" } }),
    });
    const result = await readViaCdp(commander, registryStub, { mode: "value", ref: 4 });
    expect(result.scope).toBe("ref");
    expect(result.text).toBe("input-value");
    expect(sent.map((call) => call.method)).toEqual([
      "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject",
    ]);
    expect(sent[0]?.params).toMatchObject({ backendNodeId: 40 });
    expect(sent[1]?.params).toMatchObject({ objectId: "object-40" });
  });

  it("truncates oversized output with the truncated flag", async () => {
    const { commander } = fakeCommander({
      "Runtime.evaluate": () => ({ result: { value: "x".repeat(500) } }),
    });
    const result = await readViaCdp(commander, registryStub, { mode: "text", maxChars: 300 });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBe(300);
  });

  it("surfaces page exceptions as typed browser errors", async () => {
    const { commander } = fakeCommander({
      "Runtime.evaluate": () => ({
        result: { wasThrown: true },
        exceptionDetails: { exception: { description: "Error: No element matches selector .missing" } },
      }),
    });
    await expect(readViaCdp(commander, registryStub, { mode: "text", selector: ".missing" }))
      .rejects.toThrow(/No element matches selector/);
  });
});

describe("page read function", () => {
  it("is valid JavaScript and extracts data from DOM stubs", () => {
    const fn = new Function(`return (${READ_PAGE_FUNCTION});`)() as (
      this: unknown, spec: { mode: string; selector: string | null; maxLinks: number },
    ) => string;
    const spec = { mode: "text", selector: null, maxLinks: 100 };
    expect(fn.call({ innerText: "你好\r\n世界" }, spec)).toBe("你好\n世界");
    expect(fn.call({ value: "abc" }, { ...spec, mode: "value" })).toBe("abc");
    expect(fn.call({
      tagName: "INPUT",
      attributes: [{ name: "type", value: "password" }, { name: "placeholder", value: "密码" }],
    }, { ...spec, mode: "attributes" })).toBe("input type=*** placeholder=密码");
    expect(fn.call({
      querySelectorAll: () => [
        { innerText: "首页 ", href: "https://a.test/" },
        { innerText: "恶意", href: "javascript:alert(1)" },
        { innerText: "", href: "https://b.test/" },
      ],
    }, { ...spec, mode: "links" })).toBe("首页 -> https://a.test/\n(no text) -> https://b.test/");
    const globalScope = globalThis as { document?: unknown };
    const previousDocument = globalScope.document;
    globalScope.document = { querySelector: () => null };
    try {
      expect(() => fn.call(undefined, { ...spec, selector: "#nope" })).toThrow(/No element matches/);
    } finally {
      globalScope.document = previousDocument;
    }
  });
});

describe("page read function (cdp path)", () => {
  it("extracts text, values, attributes and javascript-free links", async () => {
    const { commander } = fakeCommander({
      "Runtime.evaluate": () => ({
        result: {
          value: "标题 -> https://a.test/\n(no text) -> https://b.test/",
        },
      }),
    });
    const result = await readViaCdp(commander, registryStub, { mode: "links" });
    expect(result.mode).toBe("links");
    expect(result.text).toContain("https://a.test/");
  });
});
