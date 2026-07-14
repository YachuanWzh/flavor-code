import { randomBytes, createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { URL, URLSearchParams } from "node:url";

import type { AuthProvider, AuthResult } from "./types.js";
import type { OAuthTokenStore } from "./store.js";

export interface OAuthCallbackAuthProviderOptions {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scope?: string;
  store: OAuthTokenStore;
  /** Inject browser open for testing. Defaults to platform open command. */
  openBrowser?: (url: string) => Promise<void>;
  /** Override callback server port for testing. 0 = random. */
  callbackPort?: number;
  /** Override callback server host. Defaults to OAUTH_CALLBACK_HOST env var or 127.0.0.1. */
  callbackHost?: string;
}

const DEFAULT_REFRESH_BUFFER_MS = 60_000;
const PKCE_TIMEOUT_MS = 5 * 60_000; // 5 minutes

export class OAuthCallbackAuthProvider implements AuthProvider {
  readonly type = "oauth-callback" as const;

  readonly #authorizationUrl: string;
  readonly #tokenUrl: string;
  readonly #clientId: string;
  readonly #scope: string | undefined;
  readonly #store: OAuthTokenStore;
  readonly #openBrowser: (url: string) => Promise<void>;
  readonly #callbackPort: number;
  readonly #callbackHost: string;
  #pendingFlow: Promise<AuthResult> | undefined;

  constructor(options: OAuthCallbackAuthProviderOptions) {
    this.#authorizationUrl = options.authorizationUrl;
    this.#tokenUrl = options.tokenUrl;
    this.#clientId = options.clientId;
    this.#scope = options.scope;
    this.#store = options.store;
    this.#openBrowser = options.openBrowser ?? defaultOpenBrowser;
    this.#callbackPort = options.callbackPort ?? 0;
    this.#callbackHost = options.callbackHost ?? process.env.OAUTH_CALLBACK_HOST ?? "127.0.0.1";
  }

  async resolve(providerId: string, signal?: AbortSignal): Promise<AuthResult> {
    signal?.throwIfAborted();

    const cached = await this.#loadCachedToken(providerId);
    if (cached !== undefined) return cached;

    if (this.#pendingFlow !== undefined) {
      throw new Error("OAuth PKCE flow already in progress");
    }

    const controller = new AbortController();
    const linkedSignal = signal !== undefined
      ? combineSignals(signal, controller.signal)
      : controller.signal;

    this.#pendingFlow = this.#runPkceFlow(providerId, linkedSignal).finally(() => {
      this.#pendingFlow = undefined;
    });

    return this.#pendingFlow;
  }

  async #loadCachedToken(providerId: string): Promise<AuthResult | undefined> {
    const tokens = await this.#store.load();
    const entry = tokens[providerId];
    if (entry === undefined) return undefined;

    const expiresAt = new Date(entry.expiresAt).getTime();
    const now = Date.now();

    if (expiresAt - DEFAULT_REFRESH_BUFFER_MS > now) {
      return {
        headers: { authorization: `Bearer ${entry.accessToken}` },
        expiresAt: entry.expiresAt,
      };
    }

    delete tokens[providerId];
    await this.#store.save(tokens);
    return undefined;
  }

  async #runPkceFlow(providerId: string, signal: AbortSignal): Promise<AuthResult> {
    signal.throwIfAborted();

    const codeVerifier = this.#generateCodeVerifier();
    const codeChallenge = this.#computeCodeChallenge(codeVerifier);
    const state = this.#generateState();

    const callbackResult = await this.#startCallbackServer(state, signal);

    const authUrl = new URL(this.#authorizationUrl);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", this.#clientId);
    authUrl.searchParams.set("redirect_uri", callbackResult.redirectUri);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("state", state);
    if (this.#scope !== undefined) {
      authUrl.searchParams.set("scope", this.#scope);
    }

    await this.#openBrowser(authUrl.toString());

    const code = await callbackResult.promise;

    const tokenResponse = await this.#exchangeCode(code, codeVerifier, callbackResult.redirectUri, signal);

    const expiresAt = tokenResponse.expires_in !== undefined
      ? new Date(Date.now() + tokenResponse.expires_in * 1000).toISOString()
      : new Date(Date.now() + 3600_000).toISOString();

    const tokens = await this.#store.load();
    tokens[providerId] = {
      accessToken: tokenResponse.access_token,
      ...(tokenResponse.refresh_token === undefined ? {} : { refreshToken: tokenResponse.refresh_token }),
      expiresAt,
      ...(this.#scope === undefined ? {} : { scope: this.#scope }),
    };
    await this.#store.save(tokens);

    return {
      headers: { authorization: `Bearer ${tokenResponse.access_token}` },
      expiresAt,
    };
  }

  async #startCallbackServer(
    expectedState: string,
    signal: AbortSignal,
  ): Promise<{ redirectUri: string; promise: Promise<string> }> {
    let serverResolve: ((code: string) => void) | undefined;
    let serverReject: ((error: Error) => void) | undefined;

    const codePromise = new Promise<string>((resolve, reject) => {
      serverResolve = resolve;
      serverReject = reject;
    });

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://${this.#callbackHost}:${(server.address() as AddressInfo).port}`);

      if (url.searchParams.has("error")) {
        const error = url.searchParams.get("error") ?? "access_denied";
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
          `<html><body><p>Authorization failed: ${escapeHtml(error)}. You may close this window.</p></body></html>`,
        );
        serverReject!(new Error(`OAuth authorization denied: ${error}`));
        return;
      }

      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");

      if (state !== expectedState) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
          "<html><body><p>Invalid state parameter. Authorization failed.</p></body></html>",
        );
        serverReject!(new Error("OAuth callback state mismatch — possible CSRF attack"));
        return;
      }

      if (code === null || code.length === 0) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" }).end(
          "<html><body><p>Missing authorization code.</p></body></html>",
        );
        serverReject!(new Error("OAuth callback missing authorization code"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(
        "<html><body><p>Authorization successful! You may close this window and return to the terminal.</p></body></html>",
      );
      serverResolve!(code);
    });

    return new Promise((resolve, reject) => {
      server.once("error", (error) => {
        reject(new Error(`OAuth callback server failed: ${error.message}`));
      });

      server.listen(this.#callbackPort, this.#callbackHost, () => {
        const addr = server.address() as AddressInfo;
        const redirectUri = `http://${this.#callbackHost}:${addr.port}/callback`;

        // Timeout: if no callback arrives within PKCE_TIMEOUT_MS, reject
        const timeout = setTimeout(() => {
          serverReject!(new Error(`OAuth flow timed out after ${PKCE_TIMEOUT_MS / 1000}s — no callback received`));
        }, PKCE_TIMEOUT_MS);

        codePromise.finally(() => {
          clearTimeout(timeout);
          server.close();
        });

        signal.addEventListener("abort", () => {
          serverReject!(new Error("OAuth flow aborted"));
        }, { once: true });

        resolve({ redirectUri, promise: codePromise });
      });
    });
  }

  async #exchangeCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
    signal: AbortSignal,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: this.#clientId,
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.#tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });

    const json: unknown = await response.json();

    if (!response.ok) {
      const error = isTokenError(json) ? json.error_description ?? json.error : response.statusText;
      throw new Error(`Token exchange failed (${response.status}): ${error}`);
    }

    if (!isTokenResponse(json)) {
      throw new Error(`Unexpected token response: ${JSON.stringify(json)}`);
    }

    return json;
  }

  #generateCodeVerifier(): string {
    return randomBytes(32).toString("base64url");
  }

  #computeCodeChallenge(verifier: string): string {
    return createHash("sha256").update(verifier).digest("base64url");
  }

  #generateState(): string {
    return randomBytes(32).toString("base64url");
  }
}

// ---- Types ----

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

function isTokenResponse(value: unknown): value is TokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "access_token" in value &&
    typeof (value as TokenResponse).access_token === "string"
  );
}

function isTokenError(value: unknown): value is TokenErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as TokenErrorResponse).error === "string"
  );
}

// ---- Helpers ----

async function defaultOpenBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const { exec } = await import("node:child_process");

  return new Promise((resolvePromise, reject) => {
    if (platform === "win32") {
      // Use shell:true so cmd handles quote escaping correctly
      const child = exec(`start "" "${url}"`, { shell: "cmd.exe", windowsHide: true }, (error) => {
        if (error) reject(new Error(`Failed to open browser: ${error.message}`));
        else resolvePromise();
      });
      child.unref();
    } else if (platform === "darwin") {
      const child = exec(`open "${url}"`, { shell: true }, (error) => {
        if (error) reject(new Error(`Failed to open browser: ${error.message}`));
        else resolvePromise();
      });
      child.unref();
    } else {
      const child = exec(`xdg-open "${url}"`, { shell: true }, (error) => {
        if (error) reject(new Error(`Failed to open browser: ${error.message}`));
        else resolvePromise();
      });
      child.unref();
    }
  });
}

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted || b.aborted) return AbortSignal.abort(a.aborted ? a.reason : b.reason);

  const controller = new AbortController();
  const onAbort = () => controller.abort((a.aborted ? a.reason : b.reason) ?? new Error("aborted"));
  a.addEventListener("abort", onAbort, { once: true });
  b.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
