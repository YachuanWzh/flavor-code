import { describe, expect, it } from "vitest";

import {
  parseIpv4,
  parseIpv6,
  redactSecretText,
  redactSnapshotValue,
  validateBrowserBounds,
  validateBrowserNavigationUrl,
} from "../../src/desktop/browser/browser-security.js";

function allow(raw: string): boolean {
  return validateBrowserNavigationUrl(raw).ok;
}

describe("browser url policy", () => {
  it("permits https, http and about:blank only", () => {
    expect(allow("https://example.com/login")).toBe(true);
    expect(allow("http://localhost:3000/preview")).toBe(true);
    expect(allow("http://127.0.0.1:5173/")).toBe(true);
    expect(allow("about:blank")).toBe(true);
    expect(allow("file:///C:/secrets.txt")).toBe(false);
    expect(allow("javascript:alert(1)")).toBe(false);
    expect(allow("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(allow("blob:https://example.com/uuid")).toBe(false);
    expect(allow("chrome://settings")).toBe(false);
    expect(allow("devtools://devtools/bundled/inspector.html")).toBe(false);
    expect(allow("not a url")).toBe(false);
    expect(allow("about:config")).toBe(false);
  });

  it("denies embedded credentials", () => {
    const result = validateBrowserNavigationUrl("https://user:pass@example.com/");
    expect(result).toEqual({ ok: false, reason: "credentials-denied" });
  });

  it("denies link-local, metadata and multicast but allows loopback", () => {
    expect(allow("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(allow("http://169.254.1.1/")).toBe(false);
    expect(allow("http://0.0.0.0/")).toBe(false);
    expect(allow("http://224.0.0.1/")).toBe(false);
    expect(allow("http://100.64.0.1/")).toBe(false);
    expect(allow("http://[fe80::1]/")).toBe(false);
    expect(allow("http://[fd00:ec2::254]/")).toBe(false);
    expect(allow("http://[::1]:3000/")).toBe(true);
    expect(allow("http://[::ffff:127.0.0.1]/")).toBe(true);
    expect(allow("http://[::ffff:a00:1]/")).toBe(false); // ::ffff:10.0.0.1 private-mapped smuggle
    expect(allow("http://metadata.google.internal/")).toBe(false);
  });

  it("denies private ranges by default, allows them only with an explicit policy", () => {
    expect(allow("http://10.1.2.3/")).toBe(false);
    expect(allow("http://172.16.0.1/")).toBe(false);
    expect(allow("http://192.168.1.254/")).toBe(false);
    expect(allow("http://[fc00::abcd]/")).toBe(false);
    expect(validateBrowserNavigationUrl("http://10.1.2.3/", { allowPrivateNetwork: true }).ok).toBe(true);
    expect(validateBrowserNavigationUrl("http://[fc00::abcd]/", { allowPrivateNetwork: true }).ok).toBe(true);
  });

  it("denies non-ASCII/punycode hostnames and malformed numeric hosts", () => {
    expect(allow("http://例え.jp/")).toBe(false); // WHATWG rewrites this to xn--r8jz45g.jp
    expect(allow("http://xn--r8jz45g.jp/")).toBe(false);
    expect(allow("http://999.1.1.1/")).toBe(false);
    // WHATWG IPv4 shorthand normalisation matches what the browser will fetch.
    expect(allow("http://1.2.3/")).toBe(true); // -> public 1.2.0.3
    expect(allow("http://0x7f.1/")).toBe(true); // WHATWG normalises to 127.0.0.1, a permitted loopback
  });

  it("parses literal address helpers", () => {
    expect(parseIpv4("192.168.0.1")).toBe(0xc0a80001);
    expect(parseIpv4("example.com")).toBeUndefined();
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("fe80::1")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:127.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1]);
    expect(parseIpv6("::ffff:a00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 1]);
    expect(parseIpv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(parseIpv6("1:2:3:4:5:6:7:8:9")).toBeUndefined();
    expect(parseIpv6("1::2::3")).toBeUndefined();
  });
});

describe("browser bounds policy", () => {
  it("accepts non-negative bounded integers only", () => {
    expect(validateBrowserBounds({ x: 0, y: 0, width: 800, height: 600 })).toEqual({ ok: true });
    expect(validateBrowserBounds({ x: -1, y: 0, width: 800, height: 600 }).ok).toBe(false);
    expect(validateBrowserBounds({ x: 0, y: 0, width: 99_999, height: 600 }).ok).toBe(false);
    expect(validateBrowserBounds({ x: 0.5, y: 0, width: 800, height: 600 }).ok).toBe(false);
    expect(validateBrowserBounds({ x: NaN, y: 0, width: 800, height: 600 }).ok).toBe(false);
  });
});

describe("browser redaction", () => {
  it("redacts sensitive field values by name", () => {
    expect(redactSnapshotValue("password", "hunter2")).toBe("[REDACTED]");
    expect(redactSnapshotValue("access_token", "abc")).toBe("[REDACTED]");
    expect(redactSnapshotValue("username", "alice")).toBe("alice");
  });

  it("scrubs secret-looking material from free text", () => {
    expect(redactSecretText("password=hunter2 next")).toBe("password=[REDACTED] next");
    expect(redactSecretText("Authorization: Bearer xyz")).toBe("Authorization: [REDACTED]");
    expect(redactSecretText("https://x.test/cb?access_token=abc&i=1")).toBe(
      "https://x.test/cb?access_token=[REDACTED]&i=1",
    );
    expect(redactSecretText("plain heading text")).toBe("plain heading text");
  });
});
