import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ConversationHistoryRepository } from "./ports.js";
import type { BotId, ConversationId } from "./types.js";

const LIST_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/conversations$/;
const CONVERSATION_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/conversations\/(conversation_[a-f0-9-]{36})$/;
const MESSAGES_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/conversations\/(conversation_[a-f0-9-]{36})\/messages$/;

/** Owner-only browsing of persisted bot conversations. Platform identifiers are never returned. */
export function createConversationHistoryApiHandler(
  authenticator: ApiTokenAuthenticator,
  conversations: ConversationHistoryRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const listMatch = LIST_ROUTE.exec(url.pathname);
    const conversationMatch = CONVERSATION_ROUTE.exec(url.pathname);
    const messagesMatch = MESSAGES_ROUTE.exec(url.pathname);
    if (!listMatch && !conversationMatch && !messagesMatch) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (conversationMatch) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        await requireApiScope(principal, "bots:write");
        const deleted = await conversations.deleteOwnedConversation({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId: conversationMatch[1] as BotId,
          conversationId: conversationMatch[2] as ConversationId,
        });
        if (!deleted) throw new AppError("NOT_FOUND", "Conversation was not found.", 404);
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      if (request.method !== "GET") return methodNotAllowed("GET");
      await requireApiScope(principal, "bots:read");
      const limit = parseInteger(url.searchParams.get("limit"), 50, 1, 100, "limit");

      if (listMatch) {
        const offset = parseInteger(url.searchParams.get("offset"), 0, 0, 10_000, "offset");
        const items = await conversations.listOwnedConversations({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId: listMatch[1] as BotId,
          limit,
          offset,
        });
        return Response.json({ items }, { headers: { "cache-control": "no-store" } });
      }

      const botId = messagesMatch?.[1] as BotId | undefined;
      const conversationId = messagesMatch?.[2] as ConversationId | undefined;
      if (!botId || !conversationId) return new Response(null, { status: 404 });
      const beforeSequence = parseOptionalInteger(url.searchParams.get("beforeSequence"), 1, Number.MAX_SAFE_INTEGER);
      const page = await conversations.getOwnedConversationMessages({
        tenantId: principal.tenantId,
        ownerId: principal.ownerId,
        botId,
        conversationId,
        limit,
        ...(beforeSequence === undefined ? {} : { beforeSequence }),
      });
      if (!page) throw new AppError("NOT_FOUND", "Conversation was not found.", 404);
      return Response.json(page, { headers: { "cache-control": "no-store" } });
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
        { error: "INTERNAL_ERROR", message: "Conversation history could not be loaded." },
        { status: 500, headers: { "cache-control": "no-store" } },
      );
    }
  };
}

function parseInteger(raw: string | null, fallback: number, minimum: number, maximum: number, name: string): number {
  if (raw === null) return fallback;
  if (!/^\d{1,8}$/.test(raw)) throw invalidParameter(name, minimum, maximum);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalidParameter(name, minimum, maximum);
  }
  return value;
}

function parseOptionalInteger(raw: string | null, minimum: number, maximum: number): number | undefined {
  if (raw === null) return undefined;
  return parseInteger(raw, minimum, minimum, maximum, "beforeSequence");
}

function invalidParameter(name: string, minimum: number, maximum: number): AppError {
  return new AppError("VALIDATION_ERROR", `${name} must be an integer from ${minimum} to ${maximum}.`, 400);
}

function methodNotAllowed(allow: "GET" | "DELETE"): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
