import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { BotOwnershipTransferRepository } from "./ports.js";
import type { BotId, UserId } from "./types.js";

const BOT_ID = "bot_[a-f0-9-]{36}";
const BOT_TRANSFER_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/ownership-transfer$`);
const BOT_TRANSFER_ITEM_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/ownership-transfer/(transfer_[a-f0-9-]{36})$`);
const ACCEPT_ROUTE = "/v1/bot-transfers/accept";
const MAX_BODY_BYTES = 8 * 1024;
const TRANSFER_LIFETIME_MS = 24 * 60 * 60 * 1000;

/** Same-workspace, one-use transfer tokens that only the named recipient can accept. */
export function createBotOwnershipTransfersApiHandler(
  authenticator: ApiTokenAuthenticator,
  transfers: BotOwnershipTransferRepository,
  now: () => Date = () => new Date(),
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const collection = BOT_TRANSFER_ROUTE.exec(url.pathname);
    const itemRoute = BOT_TRANSFER_ITEM_ROUTE.exec(url.pathname);
    if (!collection && !itemRoute && url.pathname !== ACCEPT_ROUTE) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (url.pathname === ACCEPT_ROUTE) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        await requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request);
        if (Object.keys(body).some((key) => key !== "token")) {
          throw new AppError("VALIDATION_ERROR", "Transfer request contains unsupported fields.", 400);
        }
        const token = parseTransferToken(body.token);
        const item = await transfers.accept({
          tenantId: principal.tenantId,
          recipientId: principal.ownerId,
          tokenHash: await hashTransferToken(token),
          now: now().toISOString(),
        });
        return json({ item });
      }

      const botId = (collection?.[1] ?? itemRoute?.[1]) as BotId;
      if (itemRoute) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        await requireApiScope(principal, "bots:write");
        const item = await transfers.revoke({
          tenantId: principal.tenantId,
          botId,
          ownerId: principal.ownerId,
          transferId: itemRoute[2] ?? "",
          now: now().toISOString(),
        });
        return json({ item });
      }

      if (request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const item = await transfers.getPending({
          tenantId: principal.tenantId,
          botId,
          ownerId: principal.ownerId,
          now: now().toISOString(),
        });
        return json({ item: item ?? null });
      }
      if (request.method !== "POST") return methodNotAllowed("GET, POST");
      await requireApiScope(principal, "bots:write");
      const body = await readJsonBody(request);
      if (Object.keys(body).some((key) => key !== "targetUserId")) {
        throw new AppError("VALIDATION_ERROR", "Transfer request contains unsupported fields.", 400);
      }
      const targetUserId = parseUserId(body.targetUserId);
      if (targetUserId === principal.ownerId) {
        throw new AppError("VALIDATION_ERROR", "Choose another active workspace member.", 400);
      }
      const createdAt = now();
      const token = createTransferToken();
      const item = await transfers.create({
        tenantId: principal.tenantId,
        botId,
        fromOwnerId: principal.ownerId,
        toOwnerId: targetUserId,
        transferId: `transfer_${crypto.randomUUID()}`,
        tokenHash: await hashTransferToken(token),
        createdAt: createdAt.toISOString(),
        expiresAt: new Date(createdAt.getTime() + TRANSFER_LIFETIME_MS).toISOString(),
      });
      return json({ item, token }, 201);
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return json(
          { error: cause.code, message: cause.message },
          cause.status,
          cause.status === 401 ? { "www-authenticate": "Bearer" } : {},
        );
      }
      return json({ error: "INTERNAL_ERROR", message: "The request could not be completed." }, 500);
    }
  };
}

function parseUserId(value: unknown): UserId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "A valid workspace member ID is required.", 400);
  }
  return value as UserId;
}

function parseTransferToken(value: unknown): string {
  if (typeof value !== "string" || !/^ahf_transfer_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "Ownership transfer token is invalid.", 400);
  }
  return value;
}

function createTransferToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `ahf_transfer_${encoded}`;
}

async function hashTransferToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await readBoundedRequestText(request, MAX_BODY_BYTES);
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
}

function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store", ...headers } });
}

function methodNotAllowed(allow: string): Response {
  return json({ error: "METHOD_NOT_ALLOWED", message: "The method is not supported for this endpoint." }, 405, {
    allow,
  });
}
