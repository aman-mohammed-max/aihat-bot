import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { BotMemoryService } from "./ports.js";
import type { BotId } from "./types.js";

const MEMORY_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/memory(?:\/([A-Za-z0-9][A-Za-z0-9._-]{0,79}))?$/;
const MAX_VALUE_LENGTH = 2_000;

/** Owner-only CRUD for persistent bot notes. */
export function createMemoryApiHandler(
  authenticator: ApiTokenAuthenticator,
  memory: BotMemoryService,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const match = MEMORY_ROUTE.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    const botId = match[1] as BotId;
    const key = match[2];
    try {
      const principal = await authenticator.authenticate(request);
      const collection = key === undefined;
      if (request.method === "GET" && collection) {
        await requireApiScope(principal, "bots:read");
        const items = await memory.listOwnedBotMemory({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        return Response.json({ items }, { headers: { "cache-control": "no-store" } });
      }
      await requireApiScope(principal, "bots:write");
      if (request.method === "PUT" && key !== undefined) {
        const body = await readMemoryBody(request);
        const now = new Date().toISOString();
        const item = await memory.putOwnedBotMemory({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          key,
          value: body.value,
          ...(body.expiresAt === undefined ? {} : { expiresAt: body.expiresAt }),
          now,
        });
        return Response.json(item, { status: 200, headers: { "cache-control": "no-store" } });
      }
      if (request.method === "DELETE" && key !== undefined) {
        const deleted = await memory.deleteOwnedBotMemory({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          key,
        });
        if (!deleted) throw new AppError("NOT_FOUND", "Memory record was not found.", 404);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return methodNotAllowed(collection);
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
        { error: "INTERNAL_ERROR", message: "Memory could not be updated." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

async function readMemoryBody(request: Request): Promise<{ value: string; expiresAt?: string }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const raw = await readBoundedRequestText(request, 8_000);
  if (new TextEncoder().encode(raw).byteLength > 8_000) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch (cause) {
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
  const body = input as Record<string, unknown>;
  if (typeof body.value !== "string" || body.value.trim().length === 0 || body.value.length > MAX_VALUE_LENGTH) {
    throw new AppError("VALIDATION_ERROR", `Memory value must contain 1 to ${MAX_VALUE_LENGTH} characters.`, 400);
  }
  if (body.expiresAt !== undefined) {
    const expiry = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
    const now = Date.now();
    if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 365 * 24 * 60 * 60 * 1000) {
      throw new AppError("VALIDATION_ERROR", "expiresAt must be within the next 365 days.", 400);
    }
  }
  return {
    value: body.value.trim(),
    ...(typeof body.expiresAt === "string" ? { expiresAt: new Date(body.expiresAt).toISOString() } : {}),
  };
}

function methodNotAllowed(collection: boolean): Response {
  const allow = collection ? "GET" : "PUT, DELETE";
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
