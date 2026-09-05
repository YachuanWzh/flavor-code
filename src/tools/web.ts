import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { z } from "zod";

import type { ToolDefinition } from "./types.js";
import { waitWithSignal } from "../utils/abort.js";

const WebFetchInput = z.object({
  url: z.string().url().max(8_192),
  timeoutMs: z.coerce.number().int().positive().max(120_000).optional(),
  maxBytes: z.coerce.number().int().positive().max(10 * 1024 * 1024).optional(),
});
const WebSearchInput = z.object({
  query: z.string().trim().min(1).max(1_000),
  maxResults: z.coerce.number().int().min(1).max(20).optional(),
});

export interface WebFetchResult {
  url: string;
  status: number;
  contentType: string;
  content: string;
  truncated: boolean;
}
export interface WebSearchResult { title: string; url: string; snippet: string }
export interface WebSearchResponse { query: string; results: WebSearchResult[] }
export interface WebSearchProvider { search(query: string, maxResults: number, signal: AbortSignal): Promise<readonly WebSearchResult[]> }

export function createWebFetchTool(): ToolDefinition<z.infer<typeof WebFetchInput>, WebFetchResult> {
  return {
    name: "WebFetch",
    description: "Fetch a public HTTP(S) page with SSRF protection and return readable text",
    inputSchema: WebFetchInput,
    outputSchema: z.object({ url: z.string(), status: z.number(), contentType: z.string(), content: z.string(), truncated: z.boolean() }),
    paths: () => [],
    summarize: (input) => input.url,
    presentCall: (input) => ({ kind: "web", title: `Fetching ${new URL(input.url).hostname}`, url: input.url }),
    permissions: () => ({ paths: [] }),
    execute: async (input, signal) => fetchPublic(input.url, {
      signal, timeoutMs: input.timeoutMs ?? 30_000, maxBytes: input.maxBytes ?? 2 * 1024 * 1024,
    }),
    renderForModel: (output) => [
      `URL: ${output.url}`, `Status: ${output.status}`, `Content-Type: ${output.contentType}`,
      output.truncated ? "[Response truncated]" : "", "", output.content,
    ].filter((line, index) => line !== "" || index >= 4).join("\n"),
    presentResult: (output) => ({ kind: "web", title: `Fetched ${new URL(output.url).hostname}`, url: output.url, summary: `${output.status} · ${output.contentType}` }),
  };
}

export function createWebSearchTool(provider: WebSearchProvider = createDefaultWebSearchProvider()): ToolDefinition<z.infer<typeof WebSearchInput>, WebSearchResponse> {
  return {
    name: "WebSearch",
    description: "Search the public web and return titles, URLs, and snippets",
    inputSchema: WebSearchInput,
    outputSchema: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })) }),
    paths: () => [],
    summarize: (input) => input.query,
    presentCall: (input) => ({ kind: "web", title: `Searching: ${input.query}` }),
    permissions: () => ({ paths: [] }),
    execute: async (input, signal) => {
      signal.throwIfAborted();
      const maxResults = input.maxResults ?? 8;
      const results = await waitWithSignal(provider.search(input.query, maxResults, signal), signal);
      return { query: input.query, results: [...results].slice(0, maxResults) };
    },
    renderForModel: (output) => output.results.length === 0
      ? `No web results found for: ${output.query}`
      : output.results.map((item, index) => `${index + 1}. ${item.title}\n${item.url}\n${item.snippet}`).join("\n\n"),
    presentResult: (output) => ({ kind: "web", title: `Search: ${output.query}`, summary: `${output.results.length} results`, items: output.results }),
  };
}

type WebFetcher = (
  initialUrl: string,
  options: { signal: AbortSignal; timeoutMs: number; maxBytes: number; rawHtml?: boolean },
) => Promise<WebFetchResult>;

export function createDefaultWebSearchProvider(fetcher: WebFetcher = fetchPublic): WebSearchProvider {
  return new MultiSourceWebSearchProvider(fetcher);
}

class MultiSourceWebSearchProvider implements WebSearchProvider {
  constructor(private readonly fetcher: WebFetcher) {}

  async search(query: string, maxResults: number, signal: AbortSignal): Promise<readonly WebSearchResult[]> {
    const sources = [
      { name: "DuckDuckGo Lite", url: `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, parse: parseDuckDuckGo },
      { name: "Bing", url: `https://www.bing.com/search?q=${encodeURIComponent(query)}`, parse: parseBing },
    ];
    const failures: string[] = [];
    for (const source of sources) {
      try {
        const response = await this.fetcher(source.url, {
          signal, timeoutMs: 30_000, maxBytes: 2 * 1024 * 1024, rawHtml: true,
        });
        if (response.status < 200 || response.status >= 300) {
          failures.push(`${source.name}: HTTP ${response.status}`);
          continue;
        }
        const results = source.parse(response.content);
        if (results.length > 0) return results.slice(0, maxResults);
        failures.push(`${source.name}: no results parsed`);
      } catch (error) {
        if (signal.aborted) throw error;
        failures.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`Web search providers failed (${failures.join("; ")})`);
  }
}

export async function fetchPublic(
  initialUrl: string,
  options: { signal: AbortSignal; timeoutMs: number; maxBytes: number; rawHtml?: boolean },
): Promise<WebFetchResult> {
  options.signal.throwIfAborted();
  const deadline = AbortSignal.timeout(options.timeoutMs);
  options = { ...options, signal: AbortSignal.any([options.signal, deadline]) };
  let current = new URL(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    options.signal.throwIfAborted();
    validateUrl(current);
    const addresses = await waitWithSignal(lookup(normalizedHostname(current.hostname), { all: true, verbatim: true }), options.signal);
    if (addresses.length === 0) throw new Error("Host did not resolve");
    if (addresses.some((entry) => isBlockedResolvedAddress(entry.address, current.hostname))) {
      throw new Error("Blocked private or special network destination");
    }
    const response = await requestAddress(current, addresses[0]!.address, options);
    if (response.redirect !== undefined) {
      if (redirects === 5) throw new Error("Too many redirects");
      current = new URL(response.redirect, current);
      continue;
    }
    const contentType = response.contentType;
    let decoder: TextDecoder;
    try { decoder = new TextDecoder(charset(contentType), { fatal: false }); }
    catch { decoder = new TextDecoder("utf-8"); }
    const decoded = decoder.decode(response.body);
    const content = !options.rawHtml && /text\/html|application\/xhtml\+xml/i.test(contentType) ? htmlToText(decoded) : decoded;
    return { url: current.href, status: response.status, contentType, content, truncated: response.truncated };
  }
  throw new Error("Too many redirects");
}

async function requestAddress(
  url: URL,
  address: string,
  options: { signal: AbortSignal; timeoutMs: number; maxBytes: number },
): Promise<{ status: number; contentType: string; body: Uint8Array; truncated: boolean; redirect?: string }> {
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    const finish = (value: { status: number; contentType: string; body: Uint8Array; truncated: boolean; redirect?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      resolvePromise(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(totalTimer);
      reject(error);
    };
    const secure = url.protocol === "https:";
    const request = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (secure ? 443 : 80),
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, accept: "text/html,application/json,text/plain;q=0.9,*/*;q=0.5", "accept-encoding": "identity", "user-agent": "Flavor-Code/1" },
      ...(secure ? { servername: normalizedHostname(url.hostname) } : {}),
      signal: options.signal,
    }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (location !== undefined && [301, 302, 303, 307, 308].includes(status)) {
        finish({ status, contentType: "", body: new Uint8Array(), truncated: false, redirect: location });
        response.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      response.on("data", (chunk: Buffer) => {
        if (bytes >= options.maxBytes) {
          truncated = true;
          finish({ status, contentType: String(response.headers["content-type"] ?? "application/octet-stream"), body: Buffer.concat(chunks), truncated });
          response.destroy();
          return;
        }
        const accepted = chunk.subarray(0, options.maxBytes - bytes);
        chunks.push(accepted);
        bytes += accepted.length;
        if (accepted.length < chunk.length) {
          truncated = true;
          finish({ status, contentType: String(response.headers["content-type"] ?? "application/octet-stream"), body: Buffer.concat(chunks), truncated });
          response.destroy();
        }
      });
      response.once("end", () => finish({
        status,
        contentType: String(response.headers["content-type"] ?? "application/octet-stream"),
        body: Buffer.concat(chunks),
        truncated,
      }));
      response.once("error", fail);
    });
    const totalTimer = setTimeout(() => request.destroy(new Error(`Web request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    totalTimer.unref();
    request.once("error", fail);
    request.end();
  });
}

function validateUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP(S) URLs are supported");
  if (url.username !== "" || url.password !== "") throw new Error("URL credentials are not allowed");
  const hostname = normalizedHostname(url.hostname).toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("Blocked private destination");
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (![80, 443].includes(port)) throw new Error(`Blocked network port: ${port}`);
  if (isIP(hostname) && isBlockedAddress(hostname)) throw new Error("Blocked private or special network destination");
}

export function isBlockedResolvedAddress(input: string, hostname: string): boolean {
  // Clash/TUN and similar proxy DNS modes intentionally map public hostnames to
  // RFC 2544's 198.18.0.0/15 benchmark range. Keep literal benchmark IP URLs
  // blocked, but allow this range as a DNS carrier so the local proxy can route
  // it. Private, loopback, link-local, and metadata ranges remain blocked.
  return isBlockedAddress(input, { allowBenchmarkCarrier: isIP(normalizedHostname(hostname)) === 0 });
}

export function isBlockedAddress(input: string, options: { allowBenchmarkCarrier?: boolean } = {}): boolean {
  const address = input.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0]!;
  if (address === "::" || address === "::1") return true;
  const mappedIpv4 = extractMappedIpv4(address);
  if (mappedIpv4 !== undefined) return isBlockedAddress(mappedIpv4, options);
  if (address.includes(":")) {
    return address.startsWith("fc") || address.startsWith("fd") || /^fe[89ab]/.test(address)
      || address.startsWith("ff") || address.startsWith("2001:db8:");
  }
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (!options.allowBenchmarkCarrier && a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113);
}

function extractMappedIpv4(address: string): string | undefined {
  if (isIP(address) !== 6) return undefined;
  let canonical: string;
  try { canonical = new URL(`http://[${address}]/`).hostname.replace(/^\[|\]$/g, ""); }
  catch { return undefined; }
  const match = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(canonical);
  if (match === null) return undefined;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function normalizedHostname(hostname: string): string { return hostname.replace(/^\[|\]$/g, ""); }

export function htmlToText(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3\b[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(p|div|section|article|main|header|footer|ul|ol|table|tr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|li|ul|ol|table|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  text = decodeEntities(text).replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function parseDuckDuckGo(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const pattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    const url = unwrapDuckDuckGoUrl(match[1]!);
    if (url !== undefined) results.push({ title: htmlToText(match[2]!), url, snippet: htmlToText(match[3]!) });
  }
  const litePattern = /<a\b[^>]*href=(["'])(.*?)\1[^>]*class=(["'])[^"']*\bresult-link\b[^"']*\3[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td\b[^>]*class=(["'])[^"']*\bresult-snippet\b[^"']*\5[^>]*>([\s\S]*?)<\/td>/gi;
  for (const match of html.matchAll(litePattern)) {
    const url = unwrapDuckDuckGoUrl(match[2]!);
    if (url !== undefined) results.push({ title: htmlToText(match[4]!), url, snippet: htmlToText(match[6]!) });
  }
  return uniqueResults(results);
}

export function parseBing(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const itemPattern = /<li\b[^>]*class=(["'])[^"']*\bb_algo\b[^"']*\1[^>]*>([\s\S]*?)<\/li>/gi;
  for (const itemMatch of html.matchAll(itemPattern)) {
    const item = itemMatch[2]!;
    const titleMatch = /<h2\b[^>]*>[\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(item);
    const snippetMatch = /<div\b[^>]*class=(["'])[^"']*\bb_caption\b[^"']*\1[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(item);
    if (titleMatch === null) continue;
    const href = readHtmlAttribute(titleMatch[1]!, "href");
    const url = href === undefined ? undefined : unwrapBingUrl(href);
    if (url === undefined) continue;
    results.push({ title: htmlToText(titleMatch[2]!), url, snippet: snippetMatch === null ? "" : htmlToText(snippetMatch[2]!) });
  }
  return uniqueResults(results);
}

function unwrapDuckDuckGoUrl(input: string): string | undefined {
  try {
    const parsed = new URL(decodeEntities(input), "https://lite.duckduckgo.com");
    return publicResultUrl(parsed.searchParams.get("uddg") ?? parsed.href);
  } catch { return undefined; }
}

function unwrapBingUrl(input: string): string | undefined {
  try {
    const parsed = new URL(decodeEntities(input), "https://www.bing.com");
    const encoded = parsed.hostname.endsWith("bing.com") && parsed.pathname === "/ck/a" ? parsed.searchParams.get("u") : null;
    if (encoded?.startsWith("a1")) {
      const target = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
      return publicResultUrl(target);
    }
    return publicResultUrl(parsed.href);
  } catch { return undefined; }
}

function publicResultUrl(input: string): string | undefined {
  try {
    const parsed = new URL(input);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : undefined;
  } catch { return undefined; }
}

function readHtmlAttribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
  return match?.[1] ?? match?.[2];
}

function uniqueResults(results: readonly WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    if (seen.has(result.url)) return false;
    seen.add(result.url);
    return true;
  });
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (_all, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? `&${entity};`;
  });
}

function charset(contentType: string): "utf-8" | "utf-16le" {
  return /charset\s*=\s*(?:utf-16|utf-16le)/i.test(contentType) ? "utf-16le" : "utf-8";
}
