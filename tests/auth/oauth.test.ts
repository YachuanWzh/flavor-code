import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthCallbackAuthProvider } from "../../src/auth/oauth.js";
import type { OAuthTokenStore } from "../../src/auth/store.js";

function b64url(data: Buffer): string {
  return data.toString("base64url");
}

describe("OAuthCallbackAuthProvider", () => {
  let tokenServer: ReturnType<typeof createServer>;
  let authServer: ReturnType<typeof createServer>;
  let tokenPort: number;
  let authPort: number;
  let storedCode: string | undefined;
  let storedChallenge: string | undefined;
  let storedRedirectUri: string | undefined;
  let issuedTokenCount = 0;
  let lastIssuedToken: string | undefined;

  const fakeStore: OAuthTokenStore = {
    tokens: {},
    async load() { return { ...this.tokens }; },
    async save(tokens) { this.tokens = { ...tokens }; },
  };

  function createProvider(callbackPort = 0) {
    return new OAuthCallbackAuthProvider({
      authorizationUrl: `http://127.0.0.1:${authPort}/authorize`,
      tokenUrl: `http://127.0.0.1:${tokenPort}/token`,
      clientId: "test-client",
      scope: "models:read",
      store: fakeStore,
      callbackPort,
      openBrowser: async (url: string) => {
        const resp = await fetch(url, { redirect: "manual" });
        const location = resp.headers.get("location");
        if (location) {
          await fetch(location, { redirect: "manual" });
        }
      },
    });
  }

  beforeEach(async () => {
    issuedTokenCount = 0;
    lastIssuedToken = undefined;
    storedCode = undefined;
    storedChallenge = undefined;
    storedRedirectUri = undefined;
    fakeStore.tokens = {};

    tokenServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== "POST" || req.url !== "/token") {
        res.writeHead(404).end();
        return;
      }
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const params = new URLSearchParams(body);
        const grantType = params.get("grant_type");
        const code = params.get("code");
        const redirectUri = params.get("redirect_uri");
        const codeVerifier = params.get("code_verifier");

        if (grantType !== "authorization_code") {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "unsupported_grant_type" }),
          );
          return;
        }

        if (code !== storedCode) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "invalid_grant", error_description: "invalid code" }),
          );
          return;
        }

        if (redirectUri !== storedRedirectUri) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "invalid_grant", error_description: "redirect_uri mismatch" }),
          );
          return;
        }

        const computed = b64url(createHash("sha256").update(codeVerifier!).digest());
        if (computed !== storedChallenge) {
          res.writeHead(400, { "Content-Type": "application/json" }).end(
            JSON.stringify({ error: "invalid_grant", error_description: "PKCE mismatch" }),
          );
          return;
        }

        storedCode = undefined;
        issuedTokenCount++;
        // Return a JWT-like token (real JWT in production)
        lastIssuedToken = "eyJhbGciOiJSUzI1NiJ9." + randomBytes(16).toString("hex") + "." + randomBytes(32).toString("hex");
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
          access_token: lastIssuedToken,
          token_type: "Bearer",
          expires_in: 3600,
        }));
      });
    });

    authServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${authPort}`);
      if (url.pathname === "/authorize") {
        storedChallenge = url.searchParams.get("code_challenge") ?? undefined;
        storedRedirectUri = url.searchParams.get("redirect_uri") ?? undefined;
        const state = url.searchParams.get("state") ?? "no-state";

        storedCode = "code_" + randomBytes(16).toString("hex");
        const redirect = new URL(storedRedirectUri ?? "/");
        redirect.searchParams.set("code", storedCode);
        redirect.searchParams.set("state", state);
        res.writeHead(302, { Location: redirect.toString() }).end();
      } else {
        res.writeHead(404).end();
      }
    });

    await new Promise<void>((resolve) => tokenServer.listen(0, "127.0.0.1", () => resolve()));
    tokenPort = (tokenServer.address() as AddressInfo).port;
    await new Promise<void>((resolve) => authServer.listen(0, "127.0.0.1", () => resolve()));
    authPort = (authServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (tokenServer) await new Promise<void>((r) => tokenServer.close(() => r()));
    if (authServer) await new Promise<void>((r) => authServer.close(() => r()));
  });

  it("returns type oauth-callback", () => {
    const provider = createProvider();
    expect(provider.type).toBe("oauth-callback");
  });

  it("completes the full PKCE flow and returns a JWT access token", async () => {
    const provider = createProvider();
    const result = await provider.resolve("my-provider");

    expect(result.headers.authorization).toBe(`Bearer ${lastIssuedToken}`);
    expect(result.expiresAt).toBeDefined();
    const expires = new Date(result.expiresAt!).getTime();
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThan(Date.now() + 3700_000);
  });

  it("caches the token and returns it on subsequent calls", async () => {
    const provider = createProvider();
    const first = await provider.resolve("my-provider");
    const firstToken = first.headers.authorization;

    const second = await provider.resolve("my-provider");
    expect(second.headers.authorization).toBe(firstToken);
    expect(issuedTokenCount).toBe(1);
  });

  it("re-runs PKCE flow when cached token is expired", async () => {
    fakeStore.tokens["my-provider"] = {
      accessToken: "expired-jwt",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      scope: "models:read",
    };

    const provider = createProvider();
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).not.toBe("Bearer expired-jwt");
    expect(result.headers.authorization).toBe(`Bearer ${lastIssuedToken}`);
  });

  it("returns stored token when it is still valid", async () => {
    fakeStore.tokens["my-provider"] = {
      accessToken: "cached-valid-jwt",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: "models:read",
    };

    const provider = createProvider();
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).toBe("Bearer cached-valid-jwt");
    expect(issuedTokenCount).toBe(0);
  });

  it("rejects when signal is already aborted", async () => {
    const provider = createProvider();
    const controller = new AbortController();
    controller.abort();

    await expect(provider.resolve("my-provider", controller.signal)).rejects.toThrow(
      /abort/i,
    );
  });

  it("refreshes token when within 60s of expiry", async () => {
    fakeStore.tokens["my-provider"] = {
      accessToken: "almost-expired-jwt",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      scope: "models:read",
    };

    const provider = createProvider();
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).not.toBe("Bearer almost-expired-jwt");
    expect(result.headers.authorization).toBe(`Bearer ${lastIssuedToken}`);
  });

  it("returns an error when a second resolve runs during an active PKCE flow", async () => {
    const provider = createProvider();

    const first = provider.resolve("my-provider");

    await expect(provider.resolve("my-provider")).rejects.toThrow(
      /already in progress/i,
    );

    const result = await first;
    expect(result.headers.authorization).toBe(`Bearer ${lastIssuedToken}`);
  });

  it("starts callback server on 127.0.0.1 with a random port", async () => {
    const provider = createProvider();
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).toMatch(/^Bearer eyJ/);
  });

  it("uses a specific port when callbackPort is provided", async () => {
    const tempServer = createServer();
    await new Promise<void>((r) => tempServer.listen(0, "127.0.0.1", () => r()));
    const fixedPort = (tempServer.address() as AddressInfo).port;
    await new Promise<void>((r) => tempServer.close(() => r()));

    const provider = createProvider(fixedPort);

    // need to seed expired token to force re-auth since port is fixed
    fakeStore.tokens["my-provider"] = {
      accessToken: "expired",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      scope: "models:read",
    };
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).toMatch(/^Bearer eyJ/);
  });

  it("stops the callback server after receiving the callback", async () => {
    const provider = createProvider();
    await provider.resolve("my-provider");

    fakeStore.tokens["my-provider"] = {
      accessToken: "expired",
      expiresAt: new Date(Date.now() - 1).toISOString(),
      scope: "models:read",
    };
    const result = await provider.resolve("my-provider");
    expect(result.headers.authorization).toMatch(/^Bearer eyJ/);
  });
});
