import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { UsageRepository } from "./ports.js";

/** Owner-only aggregate usage. This intentionally omits actor IDs and individual prompt content. */
export function createUsageApiHandler(
  authenticator: ApiTokenAuthenticator,
  usage: UsageRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/usage") return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      await requireApiScope(principal, "bots:read");
      if (request.method !== "GET") {
        return Response.json(
          { error: "METHOD_NOT_ALLOWED", message: "Use GET for this endpoint." },
          { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
        );
      }
      const days = parseDays(url.searchParams.get("days"));
      const throughDate = new Date();
      const startDate = new Date(throughDate);
      startDate.setUTCHours(0, 0, 0, 0);
      startDate.setUTCDate(startDate.getUTCDate() - days + 1);
      const summary = await usage.getOwnedUsageSummary({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        from: startDate.toISOString(),
        through: throughDate.toISOString(),
      });
      return Response.json(summary, { headers: { "cache-control": "no-store" } });
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
        { error: "INTERNAL_ERROR", message: "Usage summary could not be loaded." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

function parseDays(raw: string | null): number {
  if (raw === null) return 30;
  if (!/^\d{1,3}$/.test(raw)) throw invalidDays();
  const days = Number(raw);
  if (!Number.isSafeInteger(days) || days < 1 || days > 90) throw invalidDays();
  return days;
}

function invalidDays(): AppError {
  return new AppError("VALIDATION_ERROR", "days must be an integer from 1 to 90.", 400);
}
