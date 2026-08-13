import { describe, expect, it } from "vitest";

import {
  createDefaultWebSearchProvider, createWebFetchTool, createWebSearchTool, htmlToText,
  isBlockedAddress, isBlockedResolvedAddress, parseBing, parseDuckDuckGo,
} from "../../src/tools/web.js";

describe("native web tools", () => {
  it("blocks local and metadata network targets before requesting", async () => {
    const tool = createWebFetchTool();
    await expect(tool.execute({ url: "http://127.0.0.1/private" }, new AbortController().signal)).rejects.toThrow(/blocked|private/i);
    await expect(tool.execute({ url: "http://169.254.169.254/latest/meta-data" }, new AbortController().signal)).rejects.toThrow(/blocked|private/i);
    await expect(tool.execute({ url: "http://[::1]/private" }, new AbortController().signal)).rejects.toThrow(/blocked|private/i);
    await expect(tool.execute({ url: "http://[::ffff:7f00:1]/private" }, new AbortController().signal)).rejects.toThrow(/blocked|private/i);
  });

  it("allows proxy fake-IP carriers only for DNS-resolved hostnames", () => {
    expect(isBlockedAddress("198.18.0.74")).toBe(true);
    expect(isBlockedResolvedAddress("198.18.0.74", "nodejs.org")).toBe(false);
    expect(isBlockedResolvedAddress("198.18.0.74", "198.18.0.74")).toBe(true);
    expect(isBlockedResolvedAddress("127.0.0.1", "example.com")).toBe(true);
    expect(isBlockedResolvedAddress("169.254.169.254", "example.com")).toBe(true);
  });

  it("classifies mapped IPv4 and documentation ranges without overblocking public neighbors", () => {
    expect(isBlockedAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isBlockedAddress("::ffff:7f00:1")).toBe(true);
    expect(isBlockedAddress("::ffff:8.8.8.8")).toBe(false);
    expect(isBlockedAddress("198.51.100.7")).toBe(true);
    expect(isBlockedAddress("198.52.100.7")).toBe(false);
    expect(isBlockedAddress("203.0.113.7")).toBe(true);
    expect(isBlockedAddress("203.1.113.7")).toBe(false);
  });

  it("converts HTML to readable deterministic text", () => {
    expect(htmlToText("<html><style>x</style><h1>Hello &amp; world</h1><p>One<br>Two</p><script>bad()</script></html>"))
      .toBe("# Hello & world\n\nOne\nTwo");
  });

  it("normalizes provider search results and presents them", async () => {
    const tool = createWebSearchTool({ search: async () => [{ title: "A", url: "https://example.com/a", snippet: "Alpha" }] });
    const result = await tool.execute({ query: "alpha", maxResults: 3 }, new AbortController().signal);
    expect(result.results).toEqual([{ title: "A", url: "https://example.com/a", snippet: "Alpha" }]);
  });

  it("parses DuckDuckGo Lite result markup", () => {
    const html = `<a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fen%2Fdownload&amp;rut=x" class='result-link'>Download <b>Node.js</b></a>
      <td class='result-snippet'>Get the latest <b>LTS</b> release.</td>`;
    expect(parseDuckDuckGo(html)).toEqual([{
      title: "Download Node.js",
      url: "https://nodejs.org/en/download",
      snippet: "Get the latest LTS release.",
    }]);
  });

  it("parses Bing results and unwraps target URLs", () => {
    const html = `<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9ub2RlanMub3JnL2VuL2Rvd25sb2Fk&amp;ntb=1">Download <strong>Node.js</strong></a></h2><div class="b_caption"><p>Get Node.js LTS.</p></div></li>`;
    expect(parseBing(html)).toEqual([{
      title: "Download Node.js",
      url: "https://nodejs.org/en/download",
      snippet: "Get Node.js LTS.",
    }]);
  });

  it("falls back to a second search source after provider rejection", async () => {
    const calls: string[] = [];
    const provider = createDefaultWebSearchProvider(async (url) => {
      calls.push(url);
      if (calls.length === 1) return { url, status: 403, contentType: "text/html", content: "denied", truncated: false };
      return {
        url, status: 200, contentType: "text/html",
        content: `<li class="b_algo"><h2><a href="https://example.com/result">Example</a></h2><div class="b_caption"><p>Fallback worked.</p></div></li>`,
        truncated: false,
      };
    });
    const results = await provider.search("fallback", 3, new AbortController().signal);
    expect(calls).toHaveLength(2);
    expect(results).toEqual([{ title: "Example", url: "https://example.com/result", snippet: "Fallback worked." }]);
  });
});
