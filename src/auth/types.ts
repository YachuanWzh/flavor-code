export interface AuthResult {
  headers: Record<string, string>;
  expiresAt?: string;
}

export interface AuthProvider {
  readonly type: "api-key" | "oauth-callback";
  resolve(providerId: string, signal?: AbortSignal): Promise<AuthResult>;
}

export interface OAuthCallbackOptions {
  authorizationUrl: URL;
  callbackHost: "127.0.0.1";
  callbackPort: number;
  state: string;
  codeVerifier: string;
}

export class ApiKeyAuthProvider implements AuthProvider {
  readonly type = "api-key" as const;

  constructor(private readonly apiKey: string) {}

  async resolve(_providerId: string, _signal?: AbortSignal): Promise<AuthResult> {
    return { headers: { authorization: `Bearer ${this.apiKey}` } };
  }
}
