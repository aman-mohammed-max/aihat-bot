import {
  API_TOKEN_SCOPES,
  createApiTokenMaterial,
  recordApiAuthorizationDenial,
  scopesAllowedForTenantRole,
} from "./api-auth.js";
import type { ApiTokenAuthenticator, ApiTokenScope } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ApiTokenRepository, TenantMembershipRepository } from "./ports.js";
import type { TenantId } from "./types.js";

const WORKSPACES = "/v1/workspaces";
const SWITCH_WORKSPACE = `${WORKSPACES}/switch`;
const MAX_BODY_BYTES = 4 * 1024;
const SWITCH_TOKEN_LIFETIME_MS = 12 * 60 * 60 * 1000;

/** Lists a user's active workspaces and exchanges a token for a selected active membership. */
export function createWorkspacesApiHandler(
  authenticator: ApiTokenAuthenticator,
  tokens: ApiTokenRepository,
  memberships: TenantMembershipRepository,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== WORKSPACES && url.pathname !== SWITCH_WORKSPACE) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      if (url.pathname === WORKSPACES) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const items = await memberships.listWorkspacesForUser(principal.ownerId);
        return json({ items });
      }
      if (request.method !== "POST") return methodNotAllowed("POST");

      const body = await readBody(request);
      if (Object.keys(body).some((key) => key !== "tenantId")) {
        throw new AppError("VALIDATION_ERROR", "Workspace switch contains unsupported fields.", 400);
      }
      const tenantId = parseTenantId(body.tenantId);
      if (tenantId === principal.tenantId) {
        throw new AppError("CONFLICT", "This workspace is already active.", 409);
      }
      const role = await memberships.getActiveRole({ tenantId, userId: principal.ownerId });
      if (!role) throw new AppError("NOT_FOUND", "Workspace was not found.", 404);

      const delegableScopes = principal.delegableScopes ?? principal.scopes;
      const tokenScopes = API_TOKEN_SCOPES.filter((scope) => delegableScopes.includes(scope));
      const roleScopes = scopesAllowedForTenantRole(role);
      const effectiveScopes = tokenScopes.filter((scope) => roleScopes.includes(scope));
      if (effectiveScopes.length === 0) {
        throw new AppError("FORBIDDEN", "This API token has no scopes available in the selected workspace.", 403);
      }

      const receivedAt = now();
      const maximumExpiry = receivedAt.getTime() + SWITCH_TOKEN_LIFETIME_MS;
      const sourceExpiry = principal.expiresAt ? Date.parse(principal.expiresAt) : maximumExpiry;
      if (!Number.isFinite(sourceExpiry) || sourceExpiry <= receivedAt.getTime()) {
        throw new AppError("UNAUTHENTICATED", "API token is invalid or expired.", 401);
      }
      const expiresAt = new Date(Math.min(sourceExpiry, maximumExpiry)).toISOString();
      const material = await createApiTokenMaterial();
      const tokenId = `token_${crypto.randomUUID()}`;
      await tokens.create({
        tokenId,
        tenantId,
        ownerId: principal.ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: tokenScopes as readonly ApiTokenScope[],
        createdAt: receivedAt.toISOString(),
        expiresAt,
      });
      return json(
        {
          tenantId,
          role,
          tokenId,
          token: material.token,
          tokenPrefix: material.tokenPrefix,
          scopes: effectiveScopes,
          expiresAt,
        },
        201,
      );
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return json({ error: cause.code, message: cause.message }, cause.status, {
          ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}),
        });
      }
      return json({ error: "INTERNAL_ERROR", message: "Workspace access could not be changed." }, 500);
    }
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let value: unknown;
  try {
    const serialized = await request.text();
    if (new TextEncoder().encode(serialized).byteLength > MAX_BODY_BYTES) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(serialized);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Workspace settings are invalid.", 400);
  }
  return value as Record<string, unknown>;
}

function parseTenantId(value: unknown): TenantId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "tenantId is invalid.", 400);
  }
  return value as TenantId;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: "The method is not supported for this endpoint." }, 405, {
    allow,
  });
}
