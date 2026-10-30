import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { BotRepository, TelegramRepository } from "./ports.js";
import type { BotId, TelegramDeploymentId } from "./types.js";
import type { TelegramManager } from "./telegram.js";

const TELEGRAM_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/telegram$/;
const TELEGRAM_TOOL_GRANTS_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/telegram\/users\/(\d+)\/tool-grants$/;
const WEBHOOK_ROUTE = /^\/webhooks\/telegram\/(dep_[a-f0-9-]{36})$/;

export function createTelegramManagementApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  deployments: TelegramRepository,
  telegram: TelegramManager,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const match = TELEGRAM_ROUTE.exec(pathname);
    const toolGrantMatch = TELEGRAM_TOOL_GRANTS_ROUTE.exec(pathname);
    if (!match && !toolGrantMatch) return undefined;
    const botId = (match?.[1] ?? toolGrantMatch?.[1]) as BotId;
    try {
      const principal = await authenticator.authenticate(request);
      const bot = await bots.get(principal.tenantId, botId);
      if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);

      if (toolGrantMatch) {
        if (request.method === "GET") await requireApiScope(principal, "bots:read");
        else if (request.method === "PUT") await requireApiScope(principal, "bots:write");
        else return methodNotAllowed("GET, PUT");
        const telegramUserId = Number(toolGrantMatch[2]);
        if (!Number.isSafeInteger(telegramUserId) || telegramUserId < 1) {
          throw new AppError("VALIDATION_ERROR", "Telegram user ID is invalid.", 400);
        }
        const deployment = await deployments.getOwnedTelegramDeployment({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        if (!deployment) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
        if (!(await deployments.isTelegramSenderAllowed({ deploymentId: deployment.id, telegramUserId }))) {
          throw new AppError("FORBIDDEN", "Telegram tool grants require an approved sender.", 403);
        }
        if (request.method === "GET") {
          const toolRefs = await deployments.listTelegramToolGrants({ deploymentId: deployment.id, telegramUserId });
          return Response.json({ botId, telegramUserId, toolRefs }, { headers: { "cache-control": "no-store" } });
        }
        if (request.method === "PUT") {
          const body = await readJsonBody(request, 65_536);
          if (
            Object.keys(body).length !== 1 ||
            !Array.isArray(body.toolRefs) ||
            body.toolRefs.some((value) => typeof value !== "string")
          ) {
            throw new AppError(
              "VALIDATION_ERROR",
              "Provide only a toolRefs array of skill or MCP tool references.",
              400,
            );
          }
          await deployments.replaceTelegramToolGrants({
            deploymentId: deployment.id,
            telegramUserId,
            toolRefs: body.toolRefs as string[],
            now: new Date().toISOString(),
          });
          const toolRefs = await deployments.listTelegramToolGrants({ deploymentId: deployment.id, telegramUserId });
          return Response.json({ botId, telegramUserId, toolRefs }, { headers: { "cache-control": "no-store" } });
        }
        return methodNotAllowed("GET, PUT");
      }

      if (request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const deployment = await deployments.getOwnedTelegramDeployment({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        const policy = deployment
          ? await deployments.getTelegramAccessPolicy(deployment.id)
          : { allowedUserIds: [], pendingUserIds: [] };
        return Response.json(
          deployment
            ? { botId, status: deployment.status, telegramBotId: deployment.externalId, ...policy }
            : { botId, status: "not_connected", ...policy },
          { headers: { "cache-control": "no-store" } },
        );
      }

      await requireApiScope(principal, "bots:write");
      if (request.method === "PATCH") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 1 || !Array.isArray(body.allowedUserIds)) {
          throw new AppError("VALIDATION_ERROR", "Provide only an allowedUserIds array.", 400);
        }
        if (
          body.allowedUserIds.length > 100 ||
          body.allowedUserIds.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) ||
          new Set(body.allowedUserIds).size !== body.allowedUserIds.length
        ) {
          throw new AppError(
            "VALIDATION_ERROR",
            "Telegram allowlist must contain up to 100 unique positive user IDs.",
            400,
          );
        }
        const deployment = await deployments.getOwnedTelegramDeployment({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        if (!deployment) throw new AppError("NOT_FOUND", "Telegram deployment was not found.", 404);
        await deployments.replaceTelegramAllowedUsers({
          deploymentId: deployment.id,
          telegramUserIds: body.allowedUserIds as number[],
          now: new Date().toISOString(),
        });
        return Response.json(
          { botId, status: deployment.status, ...(await deployments.getTelegramAccessPolicy(deployment.id)) },
          { headers: { "cache-control": "no-store" } },
        );
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 1 || typeof body.token !== "string") {
          throw new AppError("VALIDATION_ERROR", "Provide only the Telegram bot token.", 400);
        }
        const deployment = await telegram.connect({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          token: body.token,
        });
        return Response.json(
          { botId, status: deployment.status, telegramBotId: deployment.externalId },
          { status: 201, headers: { "cache-control": "no-store" } },
        );
      }
      if (request.method === "DELETE") {
        await telegram.disconnect({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
        });
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return methodNotAllowed("GET, PUT, PATCH, DELETE");
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

export function createTelegramWebhookHandler(
  telegram: TelegramManager,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const match = WEBHOOK_ROUTE.exec(new URL(request.url).pathname);
    if (!match) return undefined;
    try {
      return await telegram.handleWebhook(request, match[1] as TelegramDeploymentId);
    } catch {
      return new Response(null, { status: 503 });
    }
  };
}

async function readJsonBody(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  let value: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > maxBytes)
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    value = JSON.parse(raw);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
