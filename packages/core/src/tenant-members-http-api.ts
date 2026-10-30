import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { TenantMembershipRepository } from "./ports.js";
import type { TenantRole, UserId } from "./types.js";

const MEMBER_ROUTE = /^\/v1\/members\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const MAX_BODY_BYTES = 8 * 1024;

/** Owner-only controls for the current tenant's existing user accounts. */
export function createTenantMembersApiHandler(
  authenticator: ApiTokenAuthenticator,
  members: TenantMembershipRepository,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/v1/members" && !MEMBER_ROUTE.test(url.pathname)) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      await requireApiScope(principal, "members:manage");
      if (url.pathname === "/v1/members") {
        if (request.method === "GET") {
          const items = await members.listMembers({ tenantId: principal.tenantId, actorId: principal.ownerId });
          return json({ items });
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          const memberId = parseUserId(body.userId);
          const role = parseAssignableRole(body.role);
          const item = await members.addMember({
            tenantId: principal.tenantId,
            actorId: principal.ownerId,
            memberId,
            role,
            now: now().toISOString(),
          });
          return json({ item }, 201);
        }
        return methodNotAllowed("GET, POST");
      }

      const match = MEMBER_ROUTE.exec(url.pathname);
      const memberId = parseUserId(match?.[1]);
      if (request.method === "PATCH") {
        const body = await readBody(request);
        const item = await members.changeMemberRole({
          tenantId: principal.tenantId,
          actorId: principal.ownerId,
          memberId,
          role: parseRole(body.role),
          now: now().toISOString(),
        });
        return json({ item });
      }
      if (request.method === "DELETE") {
        const item = await members.deactivateMember({
          tenantId: principal.tenantId,
          actorId: principal.ownerId,
          memberId,
          now: now().toISOString(),
        });
        return json({ item });
      }
      return methodNotAllowed("PATCH, DELETE");
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return json({ error: cause.code, message: cause.message }, cause.status, {
          ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}),
        });
      }
      return json({ error: "INTERNAL_ERROR", message: "Tenant membership could not be updated." }, 500);
    }
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value as Record<string, unknown>;
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400, { cause });
  }
}

function parseUserId(value: unknown): UserId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "userId is invalid.", 400);
  }
  return value as UserId;
}

function parseAssignableRole(value: unknown): Exclude<TenantRole, "owner"> {
  if (value !== "admin" && value !== "member") {
    throw new AppError("VALIDATION_ERROR", "New members can be assigned the admin or member role.", 400);
  }
  return value;
}

function parseRole(value: unknown): TenantRole {
  if (value !== "owner" && value !== "admin" && value !== "member") {
    throw new AppError("VALIDATION_ERROR", "role must be owner, admin, or member.", 400);
  }
  return value;
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: "The method is not supported for this endpoint." }, 405, {
    allow,
  });
}
