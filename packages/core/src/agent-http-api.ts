import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { validateStructuredOutputSchema } from "./structured-output.js";
import type { AgentEngine, ApiConversationRepository, BotRepository } from "./ports.js";
import type { BotId, JsonSchema } from "./types.js";

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
      await requireApiScope(principal, "agent:run");
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
      const idempotencyKey = request.headers.get("idempotency-key");
      if (idempotencyKey !== null && !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) {
        throw new AppError("VALIDATION_ERROR", "Idempotency-Key header is invalid.", 400);
      }
      const conversationId = await conversations.getOrCreateApiConversation({
        tenantId: principal.tenantId,
        botId,
        actorId: principal.ownerId,
        conversationKey: `${principal.ownerId}:${conversationHandle}`,
      });
      const agentRequest = {
        bot,
        conversationId,
        executionId: idempotencyKey ?? crypto.randomUUID(),
        actorId: principal.ownerId,
        actorContext: { platform: "api" },
        messages: [{ role: "user", content: body.message }],
        ...(body.responseSchema ? { responseSchema: body.responseSchema } : {}),
        signal: request.signal,
      } as const;
      if (body.stream) return streamingAgentResponse(engine, agentRequest, conversationHandle);
      const result = await engine.respond(agentRequest);
      return Response.json(
        {
          conversationId: conversationHandle,
          message: result.message.content,
          ...(result.attachments?.length ? { attachments: result.attachments } : {}),
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          ...(result.usage ? { usage: result.usage } : {}),
        },
        { headers: { "cache-control": "no-store" } },
      );
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

function streamingAgentResponse(
  engine: AgentEngine,
  request: Parameters<AgentEngine["respond"]>[0],
  conversationId: string,
): Response {
  const encoder = new TextEncoder();
  const controller = new AbortController();
  const abortFromRequest = () => controller.abort(request.signal?.reason);
  request.signal?.addEventListener("abort", abortFromRequest, { once: true });
  if (request.signal?.aborted) abortFromRequest();
  let disconnected = false;

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      const send = (event: string, payload: unknown): void => {
        if (disconnected) return;
        try {
          streamController.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
        } catch {
          disconnected = true;
          controller.abort(new Error("Client disconnected."));
        }
      };
      void (async () => {
        try {
          const result = await engine.respond(
            { ...request, signal: controller.signal },
            { onTextDelta: (delta) => send("delta", { delta }) },
          );
          send("done", {
            conversationId,
            message: result.message.content,
            ...(result.attachments?.length ? { attachments: result.attachments } : {}),
            ...(result.usage ? { usage: result.usage } : {}),
          });
        } catch (cause) {
          const error =
            cause instanceof AppError ? cause : new AppError("INTERNAL_ERROR", "Agent request failed.", 500);
          send("error", { error: error.code, message: error.message });
        } finally {
          request.signal?.removeEventListener("abort", abortFromRequest);
          if (!disconnected) streamController.close();
        }
      })();
    },
    cancel() {
      disconnected = true;
      controller.abort(new Error("Client cancelled the stream."));
      request.signal?.removeEventListener("abort", abortFromRequest);
    },
  });
  return new Response(stream, {
    headers: {
      "cache-control": "no-store, no-transform",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    },
  });
}

async function readMessageBody(
  request: Request,
): Promise<{ message: string; conversationId?: string; stream: boolean; responseSchema?: JsonSchema }> {
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
    Object.keys(body).some((key) => !["message", "conversationId", "stream", "responseSchema"].includes(key)) ||
    (body.stream !== undefined && typeof body.stream !== "boolean")
  ) {
    throw new AppError("VALIDATION_ERROR", "Request contains unsupported message options.", 400);
  }
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
  if (body.responseSchema !== undefined && body.stream === true) {
    throw new AppError("VALIDATION_ERROR", "Structured output is not supported for streaming requests.", 400);
  }
  return {
    message: body.message,
    ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
    stream: body.stream === true,
    ...(body.responseSchema === undefined
      ? {}
      : { responseSchema: validateStructuredOutputSchema(body.responseSchema) }),
  };
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
  );
}
