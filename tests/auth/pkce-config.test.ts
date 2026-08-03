import { describe, expect, it } from "vitest";
import { parseOAuthLlmConfig, oauthCredentialId } from "../../src/auth/oauth-config.js";

const valid = {
  provider_id: "deepseek",
  service_name: "Enterprise DeepSeek",
  api_type: "anthropic",
  base_url: "http://127.0.0.1:8092",
  default_model: "deepseek-v4-pro",
  cheap_model: "deepseek-v4-flash",
  models: ["deepseek-v4-pro", "deepseek-v4-flash"],
  max_output_tokens: 65536,
};

describe("PKCE LLM configuration", () => {
  it("normalizes the server wire format", () => {
    expect(parseOAuthLlmConfig(valid)).toMatchObject({
      providerId: "deepseek", apiType: "anthropic",
      baseURL: "http://127.0.0.1:8092", defaultModel: "deepseek-v4-pro",
    });
  });

  it.each([
    [{ ...valid, provider_id: "bad provider" }, /provider_id/],
    [{ ...valid, api_type: "other" }, /api_type/],
    [{ ...valid, base_url: "file:///tmp/key" }, /base_url/],
    [{ ...valid, models: ["deepseek-v4-flash"] }, /default_model/],
  ])("rejects invalid server configuration", (input, error) => {
    expect(() => parseOAuthLlmConfig(input)).toThrow(error);
  });

  it("isolates credentials by token URL and client ID", () => {
    expect(oauthCredentialId("https://a.example/token", "client"))
      .not.toBe(oauthCredentialId("https://b.example/token", "client"));
    expect(oauthCredentialId("https://a.example/token", "client"))
      .toBe(oauthCredentialId("https://a.example/token", "client"));
  });
});
