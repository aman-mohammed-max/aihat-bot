import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { AuditLogRepository } from "./ports.js";

/** Owner-only view of authenticated API mutation attempts. Request bodies and query strings are never stored. */
export function createAuditLogApiHandler(
  authenticator: ApiTokenAuthenticator,
  auditLogs: AuditLogRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/audit-logs") return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      await requireApiScope(principal, "bots:read");
      if (request.method !== "GET") {
        return Response.json(
          { error: "METHOD_NOT_ALLOWED", message: "Use GET for this endpoint." },
          { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
        );
      }
      const limit = parseLimit(url.searchParams.get("limit"));
      const items = await auditLogs.listOwnedAuditLogs({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        limit,
      });
      return Response.json({ items }, { headers: { "cache-control": "no-store" } });
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
        { error: "INTERNAL_ERROR", message: "Audit history could not be loaded." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

function parseLimit(raw: string | null): number {
  if (raw === null) return 50;
  if (!/^\d{1,3}$/.test(raw)) throw invalidLimit();
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalidLimit();
  return limit;
}

function invalidLimit(): AppError {
  return new AppError("VALIDATION_ERROR", "limit must be an integer from 1 to 100.", 400);
}
