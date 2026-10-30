import { requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { AgentEngine, ApiConversationRepository, BotRepository } from "./ports.js";
import type { BotId } from "./types.js";

const BOT_MESSAGE_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/messages$/;
const MAX_MESSAGE_LENGTH = 10_000;

/** Owner-scoped message endpoint backed by the shared agent engine. */
export function createAgentApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  conversations: ApiConversationRepository,
  engine: AgentEngine,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const match = BOT_MESSAGE_ROUTE.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      requireApiScope(principal, "agent:run");
      if (request.method !== "POST") return methodNotAllowed();
      const body = await readMessageBody(request);
      const botId = match[1] as BotId;
      const bot = await bots.get(principal.tenantId, botId);
      if (!bot || bot.ownerId !== principal.ownerId) {
        throw new AppError("NOT_FOUND", "Bot was not found.", 404);
      }
      if (bot.status === "disabled") {
        throw new AppError("CONFLICT", "This bot is disabled.", 409);
      }

      const conversationHandle = body.conversationId ?? `conv_${crypto.randomUUID().replaceAll("-", "")}`;
      const conversationId = await conversations.getOrCreateApiConversation({
        tenantId: principal.tenantId,
        botId,
        actorId: principal.ownerId,
        conversationKey: `${principal.ownerId}:${conversationHandle}`,
      });
      const result = await engine.respond({
        bot,
        conversationId,
        actorId: principal.ownerId,
        actorContext: { platform: "api" },
        messages: [{ role: "user", content: body.message }],
      });
      return Response.json(
        {
          conversationId: conversationHandle,
          message: result.message.content,
          ...(result.usage ? { usage: result.usage } : {}),
        },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (cause) {
      if (cause instanceof AppError) {
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

async function readMessageBody(request: Request): Promise<{ message: string; conversationId?: string }> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 24_000) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let input: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 24_000) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    input = JSON.parse(raw);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
  const body = input as Record<string, unknown>;
  if (
    typeof body.message !== "string" ||
    body.message.trim().length === 0 ||
    body.message.length > MAX_MESSAGE_LENGTH
  ) {
    throw new AppError("VALIDATION_ERROR", `Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters.`, 400);
  }
  if (
    body.conversationId !== undefined &&
    (typeof body.conversationId !== "string" || !/^conv_[a-f0-9]{32}$/.test(body.conversationId))
  ) {
    throw new AppError("VALIDATION_ERROR", "Conversation ID is invalid.", 400);
  }
  return {
    message: body.message,
    ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
  };
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}
