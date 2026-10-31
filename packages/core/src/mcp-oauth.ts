import type {
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/client";
import { AppError } from "./errors.js";

export const MCP_OAUTH_CODE_SECRET_PREFIX = "aihat:mcp:oauth-authorization-code:v1:";
export const MCP_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export interface McpOAuthAuthorizationState {
  readonly mode: "oauth_authorization_code";
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly issuer: string;
  readonly scope?: string | undefined;
  readonly redirectUri: string;
  readonly state?: string | undefined;
  readonly codeVerifier?: string | undefined;
  readonly flowExpiresAt?: string | undefined;
  readonly authorizationUrl?: string | undefined;
  readonly discoveryState?: OAuthDiscoveryState | undefined;
  readonly clientInformation?: StoredOAuthClientInformation | undefined;
  readonly tokens?: StoredOAuthTokens | undefined;
}

export function encodeMcpOAuthAuthorizationState(value: McpOAuthAuthorizationState): string {
  return `${MCP_OAUTH_CODE_SECRET_PREFIX}${JSON.stringify(value)}`;
}

export function decodeMcpOAuthAuthorizationState(value: string): McpOAuthAuthorizationState | undefined {
  if (!value.startsWith(MCP_OAUTH_CODE_SECRET_PREFIX)) return undefined;
  try {
    const parsed: unknown = JSON.parse(value.slice(MCP_OAUTH_CODE_SECRET_PREFIX.length));
    if (!isMcpOAuthAuthorizationState(parsed)) throw new Error("Invalid stored OAuth state");
    return parsed;
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", "Stored MCP OAuth configuration is invalid.", 500, { cause });
  }
}

export class PersistentMcpOAuthProvider implements OAuthClientProvider {
  readonly #persist: (state: McpOAuthAuthorizationState) => Promise<void>;
  #state: McpOAuthAuthorizationState;

  constructor(state: McpOAuthAuthorizationState, persist: (state: McpOAuthAuthorizationState) => Promise<void>) {
    this.#state = state;
    this.#persist = persist;
  }

  get redirectUrl(): string {
    return this.#state.redirectUri;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "AI Hat Bot Factory",
      redirect_uris: [this.#state.redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: this.#state.clientSecret ? "client_secret_basic" : "none",
      ...(this.#state.scope ? { scope: this.#state.scope } : {}),
    };
  }

  get authorizationUrl(): string | undefined {
    return this.#state.authorizationUrl;
  }

  snapshot(): McpOAuthAuthorizationState {
    return this.#state;
  }

  async beginFreshFlow(): Promise<void> {
    this.#state = {
      ...this.#state,
      state: undefined,
      codeVerifier: undefined,
      flowExpiresAt: undefined,
      authorizationUrl: undefined,
    };
    await this.#persist(this.#state);
  }

  async clearAuthorizationChallenge(): Promise<void> {
    this.#state = {
      ...this.#state,
      state: undefined,
      codeVerifier: undefined,
      flowExpiresAt: undefined,
      authorizationUrl: undefined,
    };
    await this.#persist(this.#state);
  }

  async consumeAuthorizationCallback(expectedState: string): Promise<void> {
    if (!this.#state.state || this.#state.state !== expectedState) {
      throw new AppError("FORBIDDEN", "MCP OAuth callback state did not match the active authorization flow.", 403);
    }
    if (!this.#state.flowExpiresAt || Date.parse(this.#state.flowExpiresAt) <= Date.now()) {
      throw new AppError("CONFLICT", "MCP OAuth authorization state has expired. Start authorization again.", 409);
    }
    this.#state = {
      ...this.#state,
      state: undefined,
      flowExpiresAt: undefined,
      authorizationUrl: undefined,
    };
    await this.#persist(this.#state);
  }

  async state(): Promise<string> {
    if (this.#state.state && this.#state.flowExpiresAt && Date.parse(this.#state.flowExpiresAt) > Date.now()) {
      return this.#state.state;
    }
    const state = crypto.randomUUID();
    this.#state = {
      ...this.#state,
      state,
      flowExpiresAt: new Date(Date.now() + MCP_OAUTH_FLOW_TTL_MS).toISOString(),
    };
    await this.#persist(this.#state);
    return state;
  }

  clientInformation(context?: { readonly issuer: string }): StoredOAuthClientInformation {
    assertIssuer(this.#state.issuer, context?.issuer);
    return (
      this.#state.clientInformation ?? {
        client_id: this.#state.clientId,
        ...(this.#state.clientSecret ? { client_secret: this.#state.clientSecret } : {}),
        redirect_uris: [this.#state.redirectUri],
        token_endpoint_auth_method: this.#state.clientSecret ? "client_secret_basic" : "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "AI Hat Bot Factory",
        issuer: this.#state.issuer,
      }
    );
  }

  async saveClientInformation(
    clientInformation: StoredOAuthClientInformation,
    context?: { readonly issuer: string },
  ): Promise<void> {
    assertIssuer(this.#state.issuer, context?.issuer);
    this.#state = { ...this.#state, clientInformation: { ...clientInformation, issuer: this.#state.issuer } };
    await this.#persist(this.#state);
  }

  tokens(context?: { readonly issuer: string }): StoredOAuthTokens | undefined {
    if (this.#state.tokens) assertIssuer(this.#state.issuer, context?.issuer ?? this.#state.tokens.issuer);
    return this.#state.tokens;
  }

  async saveTokens(tokens: StoredOAuthTokens, context?: { readonly issuer: string }): Promise<void> {
    assertIssuer(this.#state.issuer, context?.issuer ?? tokens.issuer);
    this.#state = { ...this.#state, tokens: { ...tokens, issuer: this.#state.issuer } };
    await this.#persist(this.#state);
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    this.#state = { ...this.#state, authorizationUrl: authorizationUrl.href };
    await this.#persist(this.#state);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    this.#state = { ...this.#state, codeVerifier };
    await this.#persist(this.#state);
  }

  async codeVerifier(): Promise<string> {
    if (!this.#state.codeVerifier) throw new AppError("CONFLICT", "MCP OAuth authorization state has expired.", 409);
    return this.#state.codeVerifier;
  }

  async saveDiscoveryState(discoveryState: OAuthDiscoveryState): Promise<void> {
    assertIssuer(this.#state.issuer, discoveryState.authorizationServerUrl);
    this.#state = { ...this.#state, discoveryState };
    await this.#persist(this.#state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#state.discoveryState;
  }

  async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL> {
    const expected = resourceUrlFromServerUrl(serverUrl);
    if (resource && !checkResourceAllowed({ requestedResource: expected, configuredResource: resource })) {
      throw new AppError("FORBIDDEN", "MCP OAuth resource does not match this server.", 403);
    }
    return expected;
  }

  async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
    if (scope === "all") {
      this.#state = {
        ...this.#state,
        clientInformation: undefined,
        tokens: undefined,
        codeVerifier: undefined,
        discoveryState: undefined,
        authorizationUrl: undefined,
        state: undefined,
        flowExpiresAt: undefined,
      };
    } else {
      this.#state = {
        ...this.#state,
        ...(scope === "client" ? { clientInformation: undefined } : {}),
        ...(scope === "tokens" ? { tokens: undefined } : {}),
        ...(scope === "verifier" ? { codeVerifier: undefined, authorizationUrl: undefined, state: undefined } : {}),
        ...(scope === "discovery" ? { discoveryState: undefined } : {}),
      };
    }
    await this.#persist(this.#state);
  }
}

function isMcpOAuthAuthorizationState(value: unknown): value is McpOAuthAuthorizationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.mode === "oauth_authorization_code" &&
    typeof record.clientId === "string" &&
    (record.clientSecret === undefined || typeof record.clientSecret === "string") &&
    typeof record.issuer === "string" &&
    (record.scope === undefined || typeof record.scope === "string") &&
    typeof record.redirectUri === "string" &&
    (record.state === undefined || typeof record.state === "string") &&
    (record.codeVerifier === undefined || typeof record.codeVerifier === "string") &&
    (record.flowExpiresAt === undefined || typeof record.flowExpiresAt === "string") &&
    (record.authorizationUrl === undefined || typeof record.authorizationUrl === "string") &&
    (record.discoveryState === undefined || isRecord(record.discoveryState)) &&
    (record.clientInformation === undefined || isRecord(record.clientInformation)) &&
    (record.tokens === undefined || isRecord(record.tokens))
  );
}

function assertIssuer(expected: string, actual: string | undefined): void {
  if (!actual) return;
  if (normalizeIssuer(actual) !== normalizeIssuer(expected)) {
    throw new AppError("FORBIDDEN", "MCP OAuth authorization server does not match the configured issuer.", 403);
  }
}

function normalizeIssuer(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
