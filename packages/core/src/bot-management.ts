import { requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { BotManagementRepository, BotRepository } from "./ports.js";
import type { BotDefinition, BotId, ModelConfig } from "./types.js";
import type { BotSettingsPatch } from "./ports.js";

const BOT_ID = "bot_[a-f0-9-]{36}";
const BOT_COLLECTION = "/v1/bots";
const BOT_ITEM_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})$`);
const BOT_ACTION_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/(enable|disable)$`);

export function validateBotSettingsPatch(value: unknown): BotSettingsPatch {
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Bot settings must be a JSON object.", 400);
  const keys = Object.keys(value);
  const allowed = new Set(["name", "description", "systemPrompt", "model"]);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new AppError("VALIDATION_ERROR", "Bot settings contain no changes or unsupported fields.", 400);
  }
  const patch: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    model?: ModelConfig;
  } = {};
  if (value.name !== undefined) {
    if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 80) {
      throw new AppError("VALIDATION_ERROR", "Bot name must contain 1 to 80 characters.", 400);
    }
    patch.name = value.name.trim();
  }
  if (value.description !== undefined) {
    if (typeof value.description !== "string" || value.description.length > 2000) {
      throw new AppError("VALIDATION_ERROR", "Bot description must contain at most 2000 characters.", 400);
    }
    patch.description = value.description.trim();
  }
  if (value.systemPrompt !== undefined) {
    if (typeof value.systemPrompt !== "string" || !value.systemPrompt.trim() || value.systemPrompt.length > 12_000) {
      throw new AppError("VALIDATION_ERROR", "System prompt must contain 1 to 12000 characters.", 400);
    }
    patch.systemPrompt = value.systemPrompt.trim();
  }
  if (value.model !== undefined) patch.model = validateModelConfig(value.model);
  return patch;
}

export function createBotManagementApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  management: BotManagementRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const pathname = new URL(request.url).pathname;
    const isCollection = pathname === BOT_COLLECTION;
    const item = BOT_ITEM_ROUTE.exec(pathname);
    const action = BOT_ACTION_ROUTE.exec(pathname);
    if (!isCollection && !item && !action) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (isCollection) {
        requireApiScope(principal, "bots:read");
        if (request.method !== "GET") return methodNotAllowed("GET");
        const owned = await management.listOwned(principal.tenantId, principal.ownerId);
        return Response.json(owned.map(botSummary), { headers: { "cache-control": "no-store" } });
      }

      const botId = (item?.[1] ?? action?.[1]) as BotId | undefined;
      if (!botId) return undefined;
      if (action) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        requireApiScope(principal, "bots:write");
        await management.setDisabled({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          disabled: action[2] === "disable",
        });
        return Response.json(
          { botId, status: action[2] === "disable" ? "disabled" : "published" },
          {
            headers: { "cache-control": "no-store" },
          },
        );
      }

      if (request.method === "GET") {
        requireApiScope(principal, "bots:read");
        const bot = await bots.get(principal.tenantId, botId);
        if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        return Response.json(botSummary(bot), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "PATCH") {
        requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request);
        if (
          Object.keys(body).some(
            (key) => !["expectedVersion", "name", "description", "systemPrompt", "model"].includes(key),
          )
        ) {
          throw new AppError("VALIDATION_ERROR", "Bot update contains unsupported fields.", 400);
        }
        if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
          throw new AppError("VALIDATION_ERROR", "expectedVersion must be a positive integer.", 400);
        }
        const settings: Record<string, unknown> = {};
        for (const key of ["name", "description", "systemPrompt", "model"] as const) {
          if (body[key] !== undefined) settings[key] = body[key];
        }
        const bot = await management.updateOwned({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          expectedVersion: body.expectedVersion as number,
          patch: validateBotSettingsPatch(settings),
        });
        return Response.json(botSummary(bot), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "DELETE") {
        requireApiScope(principal, "bots:write");
        await management.deleteOwned({ tenantId: principal.tenantId, ownerId: principal.ownerId, botId });
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return methodNotAllowed("GET, PATCH, DELETE");
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

function validateModelConfig(value: unknown): ModelConfig {
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Model settings are invalid.", 400);
  const allowed = new Set(["providerId", "model", "endpoint", "credentialRef", "parameters"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new AppError("VALIDATION_ERROR", "Model settings contain unsupported fields.", 400);
  }
  if (
    typeof value.providerId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.providerId) ||
    typeof value.model !== "string" ||
    !value.model.trim() ||
    value.model.length > 128
  ) {
    throw new AppError("VALIDATION_ERROR", "Model provider and model identifiers are invalid.", 400);
  }
  let endpoint: string | undefined;
  if (value.endpoint !== undefined) {
    if (typeof value.endpoint !== "string") throw new AppError("VALIDATION_ERROR", "Model endpoint is invalid.", 400);
    let url: URL;
    try {
      url = new URL(value.endpoint);
    } catch (cause) {
      throw new AppError("VALIDATION_ERROR", "Model endpoint must be an absolute HTTPS URL.", 400, { cause });
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      throw new AppError("VALIDATION_ERROR", "Model endpoint must use HTTPS without credentials or fragments.", 400);
    }
    endpoint = url.toString();
  }
  if (
    value.credentialRef !== undefined &&
    (typeof value.credentialRef !== "string" || !/^secret_[a-f0-9]{32}$/.test(value.credentialRef))
  ) {
    throw new AppError("VALIDATION_ERROR", "Model credential must be an encrypted secret reference.", 400);
  }
  let parameters: Record<string, string | number | boolean> | undefined;
  if (value.parameters !== undefined) {
    if (!isRecord(value.parameters) || Object.keys(value.parameters).length > 32) {
      throw new AppError("VALIDATION_ERROR", "Model parameters are invalid.", 400);
    }
    parameters = {};
    for (const [key, parameter] of Object.entries(value.parameters)) {
      if (
        !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) ||
        !(
          typeof parameter === "string" ||
          typeof parameter === "boolean" ||
          (typeof parameter === "number" && Number.isFinite(parameter))
        ) ||
        (typeof parameter === "string" && parameter.length > 512)
      ) {
        throw new AppError("VALIDATION_ERROR", "Model parameters contain an invalid value.", 400);
      }
      parameters[key] = parameter;
    }
  }
  return {
    providerId: value.providerId,
    model: value.model.trim(),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef as string }),
    ...(parameters === undefined ? {} : { parameters }),
  };
}

function botSummary(bot: BotDefinition) {
  const { credentialRef, ...model } = bot.model;
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    systemPrompt: bot.systemPrompt,
    model: { ...model, hasCredential: credentialRef !== undefined },
    visibility: bot.visibility,
    status: bot.status,
    version: bot.version,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > 16_384)
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  let value: unknown;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 16_384)
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    value = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
