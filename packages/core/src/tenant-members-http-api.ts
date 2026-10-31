import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { TenantMembershipRepository } from "./ports.js";
import type { TenantRole, UserId } from "./types.js";

const MEMBER_ROUTE = /^\/v1\/members\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const INVITATIONS = "/v1/invitations";
const ACCEPT_INVITATION = `${INVITATIONS}/accept`;
const INVITATION_ROUTE = /^\/v1\/invitations\/(invite_[a-f0-9-]{36})$/;
const MAX_BODY_BYTES = 8 * 1024;
const MAX_INVITATION_LIFETIME_DAYS = 90;

/** Workspace membership administration and one-use, account-bound invitation links. */
export function createTenantMembersApiHandler(
  authenticator: ApiTokenAuthenticator,
  members: TenantMembershipRepository,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const memberRoute = MEMBER_ROUTE.test(url.pathname);
    const invitationRoute = INVITATION_ROUTE.test(url.pathname);
    if (
      url.pathname !== "/v1/members" &&
      !memberRoute &&
      url.pathname !== INVITATIONS &&
      url.pathname !== ACCEPT_INVITATION &&
      !invitationRoute
    ) {
      return undefined;
    }
    try {
      const principal = await authenticator.authenticate(request);
      if (url.pathname === ACCEPT_INVITATION) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const body = await readBody(request);
        if (Object.keys(body).some((key) => key !== "token")) {
          throw new AppError("VALIDATION_ERROR", "Invitation request contains unsupported fields.", 400);
        }
        const token = parseInvitationToken(body.token);
        const accepted = await members.acceptInvitation({
          tokenHash: await hashInvitationToken(token),
          userId: principal.ownerId,
          now: now().toISOString(),
        });
        return json(accepted);
      }
      await requireApiScope(principal, "members:manage");
      if (url.pathname === INVITATIONS) {
        if (request.method === "GET") {
          const items = await members.listInvitations({
            tenantId: principal.tenantId,
            actorId: principal.ownerId,
            now: now().toISOString(),
          });
          return json({ items });
        }
        if (request.method === "POST") {
          const body = await readBody(request);
          if (Object.keys(body).some((key) => key !== "role" && key !== "expiresInDays")) {
            throw new AppError("VALIDATION_ERROR", "Invitation settings contain unsupported fields.", 400);
          }
          const role = parseAssignableRole(body.role);
          const expiresInDays = parseInvitationLifetime(body.expiresInDays);
          const createdAt = now();
          const expiresAt = new Date(createdAt.getTime() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
          const token = await createInvitationToken();
          const item = await members.createInvitation({
            tenantId: principal.tenantId,
            actorId: principal.ownerId,
            invitationId: `invite_${crypto.randomUUID()}`,
            tokenHash: await hashInvitationToken(token),
            role,
            createdAt: createdAt.toISOString(),
            expiresAt,
          });
          return json({ item, token }, 201);
        }
        return methodNotAllowed("GET, POST");
      }
      if (invitationRoute) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        const invitationId = INVITATION_ROUTE.exec(url.pathname)?.[1];
        if (!invitationId) return json({ error: "NOT_FOUND", message: "Invitation was not found." }, 404);
        const item = await members.revokeInvitation({
          tenantId: principal.tenantId,
          actorId: principal.ownerId,
          invitationId,
          now: now().toISOString(),
        });
        return json({ item });
      }
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
  const text = await readBoundedRequestText(request, MAX_BODY_BYTES);
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

function parseInvitationLifetime(value: unknown): number {
  if (value !== 1 && value !== 7 && value !== 30 && value !== MAX_INVITATION_LIFETIME_DAYS) {
    throw new AppError("VALIDATION_ERROR", "Invitation expiry must be 1, 7, 30, or 90 days.", 400);
  }
  return value;
}

function parseInvitationToken(value: unknown): string {
  if (typeof value !== "string" || !/^ahf_invite_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "Invitation token is invalid.", 400);
  }
  return value;
}

async function createInvitationToken(): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `ahf_invite_${encoded}`;
}

async function hashInvitationToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: "The method is not supported for this endpoint." }, 405, {
    allow,
  });
}
