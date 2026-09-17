/**
 * Browser security policy: top-level navigation URL validation, untrusted
 * bounds checks and snapshot redaction. The same URL policy must be applied to
 * initial navigations, redirects and window.open targets.
 * See md_docs/todo.md sections 7 and 15.
 */

import type { BrowserBounds } from "./types.js";

export type UrlPolicyDenial =
  | "unparseable"
  | "protocol-denied"
  | "credentials-denied"
  | "hostname-denied"
  | "address-denied";

export interface UrlPolicyOptions {
  /** Allow RFC1918 / IPv6 unique-local addresses (off by default). */
  allowPrivateNetwork?: boolean;
}

export type UrlPolicyResult =
  | { ok: true; url: string }
  | { ok: false; reason: UrlPolicyDenial };

const ALLOWED_PROTOCOLS = new Set(["https:", "http:"]);

/** Hostnames that are treated as loopback (allowed for local dev preview). */
const LOOPBACK_HOSTNAMES = new Set(["localhost"]);

/** Cloud metadata hostnames are denied even if they would resolve publicly. */
const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
]);

const REDACTION = "[REDACTED]";
const SENSITIVE_KEY_RE = /pass|token|secret|authorization|cookie|otp|cvv|api[_-]?key|apikey|access[_-]?key|client[_-]?id/i;

export function validateBrowserNavigationUrl(
  raw: string,
  options: UrlPolicyOptions = {},
): UrlPolicyResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (url.protocol === "about:") {
    return url.href === "about:blank"
      ? { ok: true, url: "about:blank" }
      : { ok: false, reason: "protocol-denied" };
  }
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: "protocol-denied" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials-denied" };
  }
  const hostCheck = classifyHost(url.hostname, options);
  if (!hostCheck.ok) {
    return { ok: false, reason: hostCheck.reason };
  }
  return { ok: true, url: url.href };
}

type HostCheck = { ok: true } | { ok: false; reason: UrlPolicyDenial };

function classifyHost(rawHostname: string, options: UrlPolicyOptions): HostCheck {
  // WHATWG URLs keep IPv6 literals bracketed; new URL() already lowercases.
  let hostname = rawHostname.toLowerCase();
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
  if (hostname === "") return { ok: false, reason: "hostname-denied" };
  // Reject non-ASCII hostnames: IDN homographs and DNS-rebind tricks out of scope.
  if (/[^\x20-\x7e]/.test(hostname)) return { ok: false, reason: "hostname-denied" };
  // WHATWG URLs percent-encode non-ASCII hosts; a percent sign never appears in
  // a legal hostname, so treat it as an evasion attempt.
  if (hostname.includes("%")) return { ok: false, reason: "hostname-denied" };
  // IDN/punycode hosts are unreadable to the user and are a homograph vector;
  // deny them by default (xn-- labels).
  if (hostname.split(".").some((label) => label.startsWith("xn--"))) {
    return { ok: false, reason: "hostname-denied" };
  }
  if (METADATA_HOSTNAMES.has(hostname) || hostname.endsWith(".metadata.google.internal")) {
    return { ok: false, reason: "address-denied" };
  }
  if (isLoopbackHostname(hostname)) return { ok: true };
  const ipv4 = parseIpv4(hostname);
  if (ipv4 !== undefined) {
    return checkIpv4(ipv4, options);
  }
  const ipv6 = parseIpv6(hostname);
  if (ipv6 !== undefined) {
    return checkIpv6(ipv6, options);
  }
  // Bare IPv6-ish or numeric-looking hosts that failed both parsers: deny.
  if (/^[0-9a-f:.]+$/.test(hostname) && /[0-9]/.test(hostname)) {
    return { ok: false, reason: "hostname-denied" };
  }
  return { ok: true };
}

function isLoopbackHostname(hostname: string): boolean {
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return hostname.endsWith(".localhost");
}

/** Returns the 32-bit value of a dotted-quad IPv4 literal, else undefined. */
export function parseIpv4(hostname: string): number | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4) return undefined;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    value = value * 256 + octet;
  }
  return value;
}

function checkIpv4(value: number, options: UrlPolicyOptions): HostCheck {
  const a = Math.floor(value / 2 ** 24);
  const b = Math.floor(value / 2 ** 16) % 256;
  const isLoopbackRange = a === 127;
  const isCurrentNetwork = a === 0;
  const isLinkLocal = a === 169 && b === 254; // includes 169.254.169.254 metadata
  const isSharedAddressSpace = a === 100 && b >= 64 && b <= 127; // CGNAT 100.64.0.0/10
  const isMulticastOrFuture = a >= 224;
  const isPrivate =
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
  if (isLoopbackRange) return { ok: true };
  if (isCurrentNetwork || isLinkLocal || isSharedAddressSpace || isMulticastOrFuture) {
    return { ok: false, reason: "address-denied" };
  }
  if (isPrivate) {
    return options.allowPrivateNetwork ? { ok: true } : { ok: false, reason: "address-denied" };
  }
  return { ok: true };
}

function parseIpv6Side(side: string, isTail: boolean): number[] | undefined {
  if (side === "") return [];
  const parts = side.split(":");
  const groups: number[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    const isLast = i === parts.length - 1;
    if (isLast && part.includes(".")) {
      // Embedded IPv4 suffix, e.g. ::ffff:127.0.0.1 (only valid at the very end).
      if (!isTail) return undefined;
      const ipv4 = parseIpv4(part);
      if (ipv4 === undefined) return undefined;
      groups.push(Math.floor(ipv4 / 65536), ipv4 % 65536);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    groups.push(parseInt(part, 16));
  }
  return groups;
}

/** Normalizes an IPv6 literal (without brackets, optional embedded IPv4) to 8 groups. */
export function parseIpv6(hostname: string): number[] | undefined {
  if (!hostname.includes(":")) return undefined;
  const halves = hostname.split("::");
  if (halves.length > 2) return undefined;
  if (halves.length === 1) {
    const groups = parseIpv6Side(hostname, true);
    return groups !== undefined && groups.length === 8 ? groups : undefined;
  }
  const head = parseIpv6Side(halves[0] ?? "", false);
  const tail = parseIpv6Side(halves[1] ?? "", true);
  if (head === undefined || tail === undefined) return undefined;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return undefined;
  return [...head, ...new Array<number>(missing).fill(0), ...tail];
}

function checkIpv6(groups: number[], options: UrlPolicyOptions): HostCheck {
  const at = (index: number): number => groups[index] ?? 0;
  const first = at(0);
  const second = at(1);
  // IPv4-mapped addresses (::ffff:x:y) must follow the IPv4 policy so that
  // ::ffff:10.0.0.1 cannot smuggle past the private-range denial.
  const isMapped =
    at(0) === 0 && at(1) === 0 && at(2) === 0 && at(3) === 0 && at(4) === 0 && at(5) === 0xffff;
  if (isMapped) {
    return checkIpv4(at(6) * 65536 + at(7), options);
  }
  const isLoopback = groups.every((g, i) => (i === 7 ? g === 1 : g === 0));
  const isUnspecified = groups.every((g) => g === 0);
  const isLinkLocal = (first & 0xffc0) === 0xfe80; // fe80::/10
  const isUniqueLocal = (first & 0xfe00) === 0xfc00; // fc00::/7
  const isMulticast = (first & 0xff00) === 0xff00; // ff00::/8 — covers multicast and future-use multicast
  // AWS IPv6 instance metadata endpoint fd00:ec2::254
  const isMetadata = first === 0xfd00 && second === 0xec2 && at(7) === 0x0254;
  if (isLoopback) return { ok: true };
  if (isUnspecified || isLinkLocal || isMulticast || isMetadata) {
    return { ok: false, reason: "address-denied" };
  }
  if (isUniqueLocal) {
    return options.allowPrivateNetwork ? { ok: true } : { ok: false, reason: "address-denied" };
  }
  return { ok: true };
}

export type BoundsDenial = "negative" | "non-finite" | "too-large";

export type BoundsPolicyResult = { ok: true } | { ok: false; reason: BoundsDenial };

/** Renderer-supplied view bounds: non-negative integers within hard caps. */
export function validateBrowserBounds(bounds: BrowserBounds): BoundsPolicyResult {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height];
  for (const value of values) {
    if (!Number.isFinite(value)) return { ok: false, reason: "non-finite" };
    if (!Number.isInteger(value) || value < 0) return { ok: false, reason: "negative" };
  }
  if (
    bounds.x > 100_000 ||
    bounds.y > 100_000 ||
    bounds.width > 30_000 ||
    bounds.height > 30_000
  ) {
    return { ok: false, reason: "too-large" };
  }
  return { ok: true };
}

/** Redacts a snapshot attribute value when the field name looks sensitive. */
export function redactSnapshotValue(fieldName: string | undefined, value: string): string {
  if (fieldName !== undefined && SENSITIVE_KEY_RE.test(fieldName)) return REDACTION;
  return redactSecretText(value);
}

/** Scrubs secret-looking material out of free text (names, URLs, values). */
export function redactSecretText(text: string): string {
  let out = text.replace(
    /\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|password|passwd|pwd|token|cookie|set-cookie|otp|cvv)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:(?:Bearer|Basic|Digest)\s+)?[^\s,;&]+)/gi,
    (_match, key: string, sep: string) => `${key}${sep}${REDACTION}`,
  );
  out = out.replace(
    /([?&](?:access_token|token|api_key|apikey|password|secret|auth)=)[^&#\s]*/gi,
    (_match, prefix: string) => `${prefix}${REDACTION}`,
  );
  return out;
}
