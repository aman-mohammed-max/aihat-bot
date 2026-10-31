import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import { validateStructuredOutputSchema } from "./structured-output.js";
import type { AgentEngine, ApiConversationRepository, BotAccessRepository, BotRepository } from "./ports.js";
import type { BotAccessGrant, BotDefinition, BotId, JsonSchema, UserId } from "./types.js";

const PUBLIC_COLLECTION = "/v1/public/bots";
const PUBLIC_DETAIL = /^\/v1\/public\/bots\/([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const PUBLIC_WEB_CHAT = /^\/v1\/public\/bots\/([a-z0-9]+(?:-[a-z0-9]+)*)\/web-chat$/;
const PUBLIC_MESSAGE = /^\/v1\/public\/bots\/([a-z0-9]+(?:-[a-z0-9]+)*)\/messages$/;
const PUBLIC_WEB_CHAT_MESSAGE = /^\/v1\/public\/bots\/([a-z0-9]+(?:-[a-z0-9]+)*)\/web-chat\/messages$/;
const SHARED_MESSAGE = /^\/v1\/shared\/bots\/(bot_[a-f0-9-]{36})\/messages$/;
const BOT_ACCESS = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/access$/;
const BOT_GRANTS = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/access\/grants$/;
const BOT_GRANT = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/access\/grants\/(grant_[a-f0-9]{32})$/;
const ACCEPT_INVITATION = "/v1/access/invitations/accept";
const MAX_MESSAGE_LENGTH = 10_000;

/** Public discovery, explicitly shared bot use, invitations, and owner access controls. */
export function createBotAccessApiHandler(input: {
  readonly authenticator: ApiTokenAuthenticator;
  readonly access: BotAccessRepository;
  readonly bots: BotRepository;
  readonly conversations: ApiConversationRepository;
  readonly engine: AgentEngine;
  readonly now?: () => Date;
}): (request: Request) => Promise<Response | undefined> {
  const now = input.now ?? (() => new Date());
  return async (request) => {
    const url = new URL(request.url);
    const publicMessage = PUBLIC_MESSAGE.exec(url.pathname);
    const publicWebChatMessage = PUBLIC_WEB_CHAT_MESSAGE.exec(url.pathname);
    const publicWebChat = PUBLIC_WEB_CHAT.exec(url.pathname);
    const sharedMessage = SHARED_MESSAGE.exec(url.pathname);
    const publicDetail = PUBLIC_DETAIL.exec(url.pathname);
    const botAccess = BOT_ACCESS.exec(url.pathname);
    const botGrants = BOT_GRANTS.exec(url.pathname);
    const botGrant = BOT_GRANT.exec(url.pathname);
    const isPublicCollection = url.pathname === PUBLIC_COLLECTION;
    const isAcceptInvitation = url.pathname === ACCEPT_INVITATION;
    if (
      !publicMessage &&
      !publicWebChatMessage &&
      !publicWebChat &&
      !sharedMessage &&
      !publicDetail &&
      !botAccess &&
      !botGrants &&
      !botGrant &&
      !isPublicCollection &&
      !isAcceptInvitation
    ) {
      return undefined;
    }

    try {
      if (isPublicCollection) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const query = url.searchParams.get("query") ?? undefined;
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 20 : Number(rawLimit);
        if (query !== undefined && (query.length > 80 || containsControlCharacter(query))) {
          throw new AppError("VALIDATION_ERROR", "Public bot search is invalid or too long.", 400);
        }
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          throw new AppError("VALIDATION_ERROR", "Public bot page size must be between 1 and 50.", 400);
        }
        const items = await input.access.listPublicBots({ ...(query === undefined ? {} : { query }), limit });
        return json({ items });
      }

      if (publicDetail || publicWebChat) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const slug = (publicDetail ?? publicWebChat)?.[1];
        if (!slug) throw new AppError("NOT_FOUND", "Public bot was not found.", 404);
        const bot = await input.access.getPublicBotBySlug(slug);
        if (!bot) throw new AppError("NOT_FOUND", "Public bot was not found.", 404);
        if (publicWebChat && !bot.interfaces?.includes("web_chat")) {
          throw new AppError("NOT_FOUND", "Public bot was not found.", 404);
        }
        return json({
          bot: {
            id: bot.id,
            slug,
            name: bot.name,
            description: bot.description,
            visibility: "public",
          },
        });
      }

      if (publicMessage || publicWebChatMessage || sharedMessage) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const principal = await input.authenticator.authenticate(request);
        await requireApiScope(principal, "agent:run");
        const body = await readMessageBody(request);
        const accessMode = publicMessage || publicWebChatMessage ? "public" : "shared";
        const requestedAt = now().toISOString();
        let bot: BotDefinition | undefined;
        if (publicMessage || publicWebChatMessage) {
          const slug = (publicMessage ?? publicWebChatMessage)?.[1];
          if (!slug) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
          bot = await input.access.getPublicBotBySlug(slug);
        } else {
          const sharedBotId = sharedMessage?.[1];
          if (!sharedBotId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
          bot = await input.access.getSharedBot({
            botId: sharedBotId as BotId,
            userId: principal.ownerId,
            now: requestedAt,
          });
        }
        if (bot?.status !== "published") throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        const requestedInterface = publicWebChatMessage ? "web_chat" : publicMessage ? "api" : undefined;
        if (requestedInterface && bot.interfaces !== undefined && !bot.interfaces.includes(requestedInterface)) {
          throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        }
        const decision = await input.access.consumeBotUse({
          botId: bot.id,
          userId: principal.ownerId,
          accessMode,
          now: requestedAt,
        });
        if (decision === "forbidden") throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        if (decision === "rate_limited") {
          throw new AppError("RATE_LIMITED", "This bot is receiving requests too quickly. Try again shortly.", 429);
        }
        if (decision === "quota_exceeded") {
          throw new AppError("RATE_LIMITED", "The daily usage limit for this bot has been reached.", 429);
        }

        const conversationHandle = body.conversationId ?? `conv_${crypto.randomUUID().replaceAll("-", "")}`;
        const conversationId = await input.conversations.getOrCreateApiConversation({
          tenantId: bot.tenantId,
          botId: bot.id,
          actorId: principal.ownerId,
          conversationKey: `${principal.ownerId}:${conversationHandle}`,
          ...(publicWebChatMessage ? { platform: "web_chat" as const } : {}),
        });
        const result = await input.engine.respond({
          bot,
          conversationId,
          actorId: principal.ownerId,
          actorContext: { platform: publicWebChatMessage ? "web_chat" : "api", includeOwnerMemory: false },
          messages: [{ role: "user", content: body.message }],
          ...(body.responseSchema ? { responseSchema: body.responseSchema } : {}),
        });
        return json({
          conversationId: conversationHandle,
          message: result.message.content,
          ...(result.attachments?.length ? { attachments: result.attachments } : {}),
          ...(result.structuredOutput === undefined ? {} : { structuredOutput: result.structuredOutput }),
          ...(result.usage ? { usage: result.usage } : {}),
        });
      }

      if (isAcceptInvitation) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        const principal = await input.authenticator.authenticate(request);
        const body = await readJsonBody(request, 8192);
        if (typeof body.token !== "string" || !/^ahf_inv_[A-Za-z0-9_-]{43}$/.test(body.token)) {
          throw new AppError("VALIDATION_ERROR", "Invitation token is invalid.", 400);
        }
        const grant = await input.access.acceptBotInvitation({
          invitationTokenHash: await hashInvitationToken(body.token),
          userId: principal.ownerId,
          now: now().toISOString(),
        });
        if (!grant) throw new AppError("NOT_FOUND", "Invitation is invalid, expired, or already used.", 404);
        return json({ grant }, 201);
      }

      const principal = await input.authenticator.authenticate(request);
      const botId = (botAccess?.[1] ?? botGrants?.[1] ?? botGrant?.[1]) as BotId;
      if (botAccess) {
        if (request.method === "GET") {
          await requireApiScope(principal, "bots:read");
          const bot = await input.bots.get(principal.tenantId, botId);
          if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
          const [listing, grants] = await Promise.all([
            input.access.getOwnedPublicBotAccessPolicy({
              tenantId: principal.tenantId,
              ownerId: principal.ownerId,
              botId,
            }),
            input.access.listOwnedAccessGrants({
              tenantId: principal.tenantId,
              ownerId: principal.ownerId,
              botId,
            }),
          ]);
          return json({
            botId,
            visibility: bot.visibility,
            publicListing: listing ?? null,
            grants,
          });
        }
        if (request.method === "PUT") {
          await requireApiScope(principal, "bots:write");
          const body = await readJsonBody(request, 8192);
          assertOnlyKeys(body, ["dailyUsageLimit", "rateLimitPerMinute"]);
          const listing = await input.access.setPublicBotAccessPolicy({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId,
            dailyUsageLimit: positiveInteger(body.dailyUsageLimit, "dailyUsageLimit"),
            rateLimitPerMinute: positiveInteger(body.rateLimitPerMinute, "rateLimitPerMinute"),
            now: now().toISOString(),
          });
          return json({ publicListing: listing });
        }
        return methodNotAllowed("GET, PUT");
      }

      if (botGrants) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        await requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request, 8192);
        assertOnlyKeys(body, ["userId", "dailyUsageLimit", "rateLimitPerMinute", "expiresAt"]);
        const hasUser = typeof body.userId === "string";
        if (!hasUser && body.userId !== undefined) {
          throw new AppError("VALIDATION_ERROR", "userId must be a valid user identifier.", 400);
        }
        if (hasUser && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(body.userId as string)) {
          throw new AppError("VALIDATION_ERROR", "userId must be a valid user identifier.", 400);
        }
        if (body.expiresAt !== undefined && typeof body.expiresAt !== "string") {
          throw new AppError("VALIDATION_ERROR", "expiresAt must be an ISO timestamp.", 400);
        }
        const ownedBot = await input.bots.get(principal.tenantId, botId);
        if (!ownedBot || ownedBot.ownerId !== principal.ownerId) {
          throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        }
        if (!hasUser && ownedBot.visibility !== "shared" && ownedBot.visibility !== "invitation") {
          throw new AppError("CONFLICT", "Invitation links are available for shared or invitation-only bots.", 409);
        }
        const invitationToken = hasUser ? undefined : createInvitationToken();
        const grantInput = {
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          ...(body.dailyUsageLimit === undefined
            ? {}
            : { dailyUsageLimit: positiveInteger(body.dailyUsageLimit, "dailyUsageLimit") }),
          ...(body.rateLimitPerMinute === undefined
            ? {}
            : { rateLimitPerMinute: positiveInteger(body.rateLimitPerMinute, "rateLimitPerMinute") }),
          ...(typeof body.expiresAt === "string" ? { expiresAt: body.expiresAt } : {}),
          now: now().toISOString(),
        };
        let grant: BotAccessGrant;
        if (hasUser) {
          grant = await input.access.createOwnedAccessGrant({ ...grantInput, userId: body.userId as UserId });
        } else if (invitationToken) {
          grant = await input.access.createOwnedAccessGrant({
            ...grantInput,
            invitationTokenHash: await hashInvitationToken(invitationToken),
          });
        } else {
          throw new AppError("INTERNAL_ERROR", "Invitation could not be created.", 500);
        }
        return json({ grant, ...(invitationToken ? { invitationToken } : {}) }, 201);
      }

      if (botGrant) {
        if (request.method !== "DELETE") return methodNotAllowed("DELETE");
        await requireApiScope(principal, "bots:write");
        const grantId = botGrant[2];
        if (!grantId) throw new AppError("NOT_FOUND", "Access grant was not found.", 404);
        const revoked = await input.access.revokeOwnedAccessGrant({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          grantId,
        });
        if (!revoked) throw new AppError("NOT_FOUND", "Access grant was not found.", 404);
        return new Response(null, { status: 204, headers: noStoreHeaders() });
      }

      return undefined;
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: {
              ...noStoreHeaders(),
              ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}),
            },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: noStoreHeaders() },
      );
    }
  };
}

function createInvitationToken(): string {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const encoded = btoa(String.fromCharCode(...random))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `ahf_inv_${encoded}`;
}

async function hashInvitationToken(token: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readMessageBody(
  request: Request,
): Promise<{ message: string; conversationId?: string; responseSchema?: JsonSchema }> {
  const body = await readJsonBody(request, 24_000);
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
  assertOnlyKeys(body, ["message", "conversationId", "responseSchema"]);
  return {
    message: body.message,
    ...(typeof body.conversationId === "string" ? { conversationId: body.conversationId } : {}),
    ...(body.responseSchema === undefined
      ? {}
      : { responseSchema: validateStructuredOutputSchema(body.responseSchema) }),
  };
}

async function readJsonBody(request: Request, maximumBytes: number): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let value: unknown;
  try {
    const text = await readBoundedRequestText(request, maximumBytes);
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a positive integer.`, 400);
  }
  return value as number;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new AppError("VALIDATION_ERROR", "Request body contains unsupported fields.", 400);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return { "cache-control": "no-store", pragma: "no-cache" };
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { ...noStoreHeaders(), allow } },
  );
}
