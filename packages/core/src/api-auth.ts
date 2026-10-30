import { AppError } from "./errors.js";
import type { ApiTokenPrincipal, ApiTokenRepository } from "./ports.js";

export const API_TOKEN_SCOPES = [
  "factory:read",
  "factory:write",
  "bots:read",
  "bots:write",
  "agent:run",
  "tokens:manage",
] as const;

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export interface NewApiTokenMaterial {
  readonly token: string;
  readonly tokenHash: string;
  readonly tokenPrefix: string;
}

/** Create a high-entropy opaque token. The plaintext must never be persisted or logged. */
export async function createApiTokenMaterial(): Promise<NewApiTokenMaterial> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const token = `ahf_live_${encoded}`;
  return { token, tokenHash: await hashApiToken(token), tokenPrefix: token.slice(0, 16) };
}

export async function hashApiToken(token: string): Promise<string> {
  if (!/^ahf_live_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new AppError("UNAUTHENTICATED", "API token is invalid.", 401);
  }
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class ApiTokenAuthenticator {
  constructor(private readonly tokens: ApiTokenRepository) {}

  async authenticate(request: Request): Promise<ApiTokenPrincipal> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) throw new AppError("UNAUTHENTICATED", "Bearer API token is required.", 401);
    const tokenHash = await hashApiToken(token);
    const principal = await this.tokens.findActive(tokenHash, new Date().toISOString());
    if (!principal) throw new AppError("UNAUTHENTICATED", "API token is invalid or expired.", 401);
    return principal;
  }
}

export function requireApiScope(principal: ApiTokenPrincipal, required: ApiTokenScope): void {
  if (!principal.scopes.includes(required)) {
    throw new AppError("FORBIDDEN", `API token requires the '${required}' scope.`, 403);
  }
}

function readBearerToken(value: string | null): string | undefined {
  if (!value || value.length > 160) return undefined;
  const match = /^Bearer (\S+)$/i.exec(value);
  return match?.[1];
}
