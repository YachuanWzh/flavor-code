import { describe, expect, it } from "vitest";

import { isDashScopeBaseURL, resolveCacheProfile } from "../../src/models/cache-profile.js";

describe("cache profile identification", () => {
  it("maps anthropic apiType to explicit cache markers", () => {
    const profile = resolveCacheProfile({ apiType: "anthropic", baseURL: "https://api.deepseek.com/anthropic" });
    expect(profile.strategy).toBe("explicit");
    expect(profile.markersSupported).toBe(true);
  });

  it("flags DashScope openai endpoints as implicit-only", () => {
    const profile = resolveCacheProfile({ apiType: "openai", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1" });
    expect(profile.strategy).toBe("implicit");
    expect(profile.markersSupported).toBe(false);
    expect(profile.reason).toContain("Responses API");
  });

  it("recognizes regional MaaS workspace hosts as DashScope", () => {
    expect(isDashScopeBaseURL("https://ws-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1")).toBe(true);
    expect(isDashScopeBaseURL("https://dashscope-intl.aliyuncs.com/compatible-mode/v1")).toBe(true);
    expect(isDashScopeBaseURL("https://api.openai.com/v1")).toBe(false);
    expect(isDashScopeBaseURL(undefined)).toBe(false);
    expect(isDashScopeBaseURL("not a url")).toBe(false);
  });

  it("treats generic openai endpoints as provider-managed implicit caching", () => {
    const profile = resolveCacheProfile({ apiType: "openai", baseURL: "https://api.openai.com/v1" });
    expect(profile.strategy).toBe("implicit");
    expect(profile.markersSupported).toBe(false);
    expect(profile.reason).not.toContain("DashScope");
  });

  it("reports unknown protocols without cache support", () => {
    const profile = resolveCacheProfile({});
    expect(profile.strategy).toBe("none");
    expect(profile.markersSupported).toBe(false);
  });
});
