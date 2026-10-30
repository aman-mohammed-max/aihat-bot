import { AppError } from "./errors.js";
import type { ApiAuthorizationDenialRepository, ApiTokenPrincipal, ApiTokenRepository } from "./ports.js";
import type { TenantRole } from "./types.js";

export const API_TOKEN_SCOPES = [
  "factory:read",
  "factory:write",
  "bots:read",
  "bots:write",
  "skills:publish",
  "agent:run",
  "tokens:manage",
  "members:manage",
] as const;

export const DEFAULT_API_REQUESTS_PER_MINUTE = 120;

interface RequestAuthorizationAuditContext {
  readonly repository: ApiAuthorizationDenialRepository;
  readonly tenantId: ApiTokenPrincipal["tenantId"];
  readonly ownerId: ApiTokenPrincipal["ownerId"];
  readonly tokenId: string;
  readonly method: string;
  readonly pathname: string;
  readonly createdAt: string;
  recorded: boolean;
}

const requestAuthorizationAudits = new WeakMap<Request, RequestAuthorizationAuditContext>();
const principalAuthorizationAudits = new WeakMap<ApiTokenPrincipal, RequestAuthorizationAuditContext>();

export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

const SCOPES_BY_TENANT_ROLE: Readonly<Record<TenantRole, readonly ApiTokenScope[]>> = {
  owner: API_TOKEN_SCOPES,
  admin: ["factory:read", "factory:write", "bots:read", "bots:write", "agent:run", "tokens:manage", "members:manage"],
  member: ["factory:read", "factory:write", "bots:read", "bots:write", "agent:run", "tokens:manage"],
};

export function scopesAllowedForTenantRole(role: TenantRole): readonly ApiTokenScope[] {
  return SCOPES_BY_TENANT_ROLE[role];
}

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
  private readonly now: () => Date;
  private readonly requestsPerMinute: number;
  private readonly authorizationAudit: ApiAuthorizationDenialRepository | undefined;

  constructor(
    private readonly tokens: ApiTokenRepository,
    options: {
      readonly now?: () => Date;
      readonly requestsPerMinute?: number;
      readonly authorizationAudit?: ApiAuthorizationDenialRepository;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.requestsPerMinute = options.requestsPerMinute ?? DEFAULT_API_REQUESTS_PER_MINUTE;
    this.authorizationAudit = options.authorizationAudit;
    if (
      !Number.isSafeInteger(this.requestsPerMinute) ||
      this.requestsPerMinute < 1 ||
      this.requestsPerMinute > 10_000
    ) {
      throw new AppError("VALIDATION_ERROR", "API request limit must be between 1 and 10000 per minute.", 400);
    }
  }

  async authenticate(request: Request): Promise<ApiTokenPrincipal> {
    const token = readBearerToken(request.headers.get("authorization"));
    if (!token) throw new AppError("UNAUTHENTICATED", "Bearer API token is required.", 401);
    const tokenHash = await hashApiToken(token);
    const now = this.now().toISOString();
    const principal = await this.tokens.findActive(tokenHash, now);
    if (!principal) throw new AppError("UNAUTHENTICATED", "API token is invalid or expired.", 401);
    const allowed = await this.tokens.consumeApiRequest({
      tenantId: principal.tenantId,
      ownerId: principal.ownerId,
      now,
      limitPerMinute: this.requestsPerMinute,
    });
    if (!allowed) throw new AppError("RATE_LIMITED", "This account has reached its API request limit.", 429);
    const method = request.method.toUpperCase();
    const pathname = new URL(request.url).pathname;
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      !pathname.startsWith("/v1/agent/") &&
      pathname !== "/v1/agent" &&
      !pathname.endsWith("/messages")
    ) {
      await this.tokens.recordApiMutation({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        tokenId: principal.tokenId,
        method,
        pathname,
        createdAt: now,
      });
    }
    const delegableScopes = principal.delegableScopes ?? principal.scopes;
    const allowedScopes = scopesAllowedForTenantRole(principal.tenantRole ?? "owner");
    const authenticatedPrincipal: ApiTokenPrincipal = {
      ...principal,
      scopes: allowedScopes.filter((scope) => delegableScopes.includes(scope)),
      delegableScopes,
    };
    if (this.authorizationAudit) {
      const auditContext: RequestAuthorizationAuditContext = {
        repository: this.authorizationAudit,
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        tokenId: principal.tokenId,
        method,
        pathname,
        createdAt: now,
        recorded: false,
      };
      requestAuthorizationAudits.set(request, auditContext);
      principalAuthorizationAudits.set(authenticatedPrincipal, auditContext);
    }
    return authenticatedPrincipal;
  }
}

export async function requireApiScope(principal: ApiTokenPrincipal, required: ApiTokenScope): Promise<void> {
  if (!principal.scopes.includes(required)) {
    const context = principalAuthorizationAudits.get(principal);
    if (context) {
      await persistAuthorizationDenial(context, {
        denialType: "scope",
        errorCode: "FORBIDDEN",
        requiredScope: required,
      });
    }
    throw new AppError("FORBIDDEN", `API token requires the '${required}' scope.`, 403);
  }
}

/** Audit authenticated resource denials while keeping query values and error details out of the log. */
export async function recordApiAuthorizationDenial(request: Request, cause: unknown): Promise<void> {
  const context = requestAuthorizationAudits.get(request);
  if (!context || !(cause instanceof AppError) || (cause.code !== "FORBIDDEN" && cause.code !== "NOT_FOUND")) return;
  await persistAuthorizationDenial(context, { denialType: "resource", errorCode: cause.code });
}

async function persistAuthorizationDenial(
  context: RequestAuthorizationAuditContext,
  input: {
    readonly denialType: "scope" | "resource";
    readonly errorCode: "FORBIDDEN" | "NOT_FOUND";
    readonly requiredScope?: string;
  },
): Promise<void> {
  if (context.recorded) return;
  await context.repository.recordApiAuthorizationDenial({
    tenantId: context.tenantId,
    ownerId: context.ownerId,
    tokenId: context.tokenId,
    method: context.method,
    pathname: context.pathname,
    denialType: input.denialType,
    errorCode: input.errorCode,
    ...(input.requiredScope ? { requiredScope: input.requiredScope } : {}),
    createdAt: context.createdAt,
  });
  context.recorded = true;
}

function readBearerToken(value: string | null): string | undefined {
  if (!value || value.length > 160) return undefined;
  const match = /^Bearer (\S+)$/i.exec(value);
  return match?.[1];
}
