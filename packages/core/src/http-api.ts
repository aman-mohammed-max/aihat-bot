import { recordApiAuthorizationDenial, API_TOKEN_SCOPES, createApiTokenMaterial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator, ApiTokenScope } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ApiTokenRepository } from "./ports.js";

/** Shared token-management API used by the Bun and Cloudflare entrypoints. */
export function createManagementApiHandler(
  authenticator: ApiTokenAuthenticator,
  tokens: ApiTokenRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const isIdentityRoute = url.pathname === "/v1/whoami";
    const isTokenCollection = url.pathname === "/v1/tokens";
    const revokeMatch = /^\/v1\/tokens\/(token_[a-f0-9-]{36})$/.exec(url.pathname);
    if (!isIdentityRoute && !isTokenCollection && !revokeMatch) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (isIdentityRoute) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return Response.json(
          {
            tenantId: principal.tenantId,
            userId: principal.ownerId,
            tokenId: principal.tokenId,
            scopes: principal.scopes,
          },
          { headers: { "cache-control": "no-store" } },
        );
      }

      await requireApiScope(principal, "tokens:manage");
      if (isTokenCollection) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const input = await readTokenRequest(request);
        if (input.scopes.some((scope) => !principal.scopes.includes(scope))) {
          throw new AppError("FORBIDDEN", "API tokens cannot grant scopes the caller does not hold.", 403);
        }
        const now = new Date();
        const expiresAt = input.expiresAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();
        const material = await createApiTokenMaterial();
        const tokenId = `token_${crypto.randomUUID()}`;
        await tokens.create({
          tokenId,
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          tokenHash: material.tokenHash,
          tokenPrefix: material.tokenPrefix,
          scopes: input.scopes,
          createdAt: now.toISOString(),
          expiresAt,
        });
        return Response.json(
          {
            tokenId,
            token: material.token,
            tokenPrefix: material.tokenPrefix,
            scopes: input.scopes,
            expiresAt,
          },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      }

      if (!revokeMatch) return undefined;
      if (request.method !== "DELETE") return methodNotAllowed("DELETE");
      const tokenId = revokeMatch[1];
      if (!tokenId) return new Response(null, { status: 404 });
      await tokens.revoke(principal.tenantId, principal.ownerId, tokenId, new Date().toISOString());
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: {
              "cache-control": "no-store",
              ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}),
            },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

async function readTokenRequest(request: Request): Promise<{
  scopes: readonly ApiTokenScope[];
  expiresAt?: string;
}> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > 8192) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let value: unknown;
  try {
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > 8192) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(body);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Token settings are invalid.", 400);
  }
  const input = value as Record<string, unknown>;
  const scopes = Array.isArray(input.scopes) ? input.scopes : [];
  const parsedScopes = scopes.filter(
    (scope): scope is ApiTokenScope => typeof scope === "string" && API_TOKEN_SCOPES.includes(scope as ApiTokenScope),
  );
  if (
    parsedScopes.length !== scopes.length ||
    parsedScopes.length < 1 ||
    parsedScopes.length > API_TOKEN_SCOPES.length ||
    new Set(parsedScopes).size !== parsedScopes.length
  ) {
    throw new AppError("VALIDATION_ERROR", "Token scopes are invalid.", 400);
  }
  if (input.expiresAt === undefined) return { scopes: parsedScopes };
  if (typeof input.expiresAt !== "string" || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new AppError("VALIDATION_ERROR", "Token expiration must be an ISO timestamp.", 400);
  }
  const expiration = Date.parse(input.expiresAt);
  const now = Date.now();
  if (expiration <= now || expiration > now + 366 * 24 * 60 * 60 * 1000) {
    throw new AppError("VALIDATION_ERROR", "Token expiration must be within the next 366 days.", 400);
  }
  return { scopes: parsedScopes, expiresAt: new Date(expiration).toISOString() };
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
