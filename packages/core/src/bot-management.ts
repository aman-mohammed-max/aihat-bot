import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { BotManagementRepository, BotRepository } from "./ports.js";
import type { SecretWriter } from "./ports.js";
import type { BotCredentialApprovalService } from "./bot-credential-approvals.js";
import type {
  BotCollaboratorRole,
  BotDefinition,
  BotId,
  BotVersionHistoryItem,
  ModelConfig,
  ModelRetryPolicySettings,
  UserId,
} from "./types.js";
import type { BotSettingsPatch } from "./ports.js";

const BOT_ID = "bot_[a-f0-9-]{36}";
const BOT_COLLECTION = "/v1/bots";
const BOT_ITEM_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})$`);
const BOT_COLLABORATORS_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/collaborators$`);
const BOT_COLLABORATOR_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/collaborators/([^/]+)$`);
const BOT_VERSIONS_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/versions$`);
const BOT_ACTION_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/(enable|disable)$`);
const BOT_CREDENTIAL_APPROVAL_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/credential-approval$`);
const BOT_CREDENTIAL_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/credential$`);
const BOT_MODEL_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/model$`);
const BOT_MODEL_RETRY_POLICY_ROUTE = new RegExp(`^/v1/bots/(${BOT_ID})/model/retry-policy$`);

export function validateBotSettingsPatch(value: unknown): BotSettingsPatch {
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Bot settings must be a JSON object.", 400);
  const keys = Object.keys(value);
  const allowed = new Set(["name", "description", "systemPrompt", "model", "memoryEnabled"]);
  if (keys.length === 0 || keys.some((key) => !allowed.has(key))) {
    throw new AppError("VALIDATION_ERROR", "Bot settings contain no changes or unsupported fields.", 400);
  }
  const patch: {
    name?: string;
    description?: string;
    systemPrompt?: string;
    model?: ModelConfig;
    memoryEnabled?: boolean;
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
  if (value.memoryEnabled !== undefined) {
    if (typeof value.memoryEnabled !== "boolean")
      throw new AppError("VALIDATION_ERROR", "memoryEnabled must be a boolean.", 400);
    patch.memoryEnabled = value.memoryEnabled;
  }
  return patch;
}

export function createBotManagementApiHandler(
  authenticator: ApiTokenAuthenticator,
  bots: BotRepository,
  management: BotManagementRepository,
  credentialApprovals?: BotCredentialApprovalService,
  secrets?: SecretWriter,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    const isCollection = pathname === BOT_COLLECTION;
    const item = BOT_ITEM_ROUTE.exec(pathname);
    const collaborators = BOT_COLLABORATORS_ROUTE.exec(pathname);
    const collaborator = BOT_COLLABORATOR_ROUTE.exec(pathname);
    const versions = BOT_VERSIONS_ROUTE.exec(pathname);
    const action = BOT_ACTION_ROUTE.exec(pathname);
    const credentialApproval = BOT_CREDENTIAL_APPROVAL_ROUTE.exec(pathname);
    const credential = BOT_CREDENTIAL_ROUTE.exec(pathname);
    const modelConfiguration = BOT_MODEL_ROUTE.exec(pathname);
    const modelRetryPolicy = BOT_MODEL_RETRY_POLICY_ROUTE.exec(pathname);
    if (
      !isCollection &&
      !item &&
      !collaborators &&
      !collaborator &&
      !versions &&
      !action &&
      !credentialApproval &&
      !credential &&
      !modelConfiguration &&
      !modelRetryPolicy
    )
      return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      if (isCollection) {
        await requireApiScope(principal, "bots:read");
        if (request.method !== "GET") return methodNotAllowed("GET");
        const [owned, shared] = await Promise.all([
          management.listOwned(principal.tenantId, principal.ownerId),
          management.listCollaborated({ tenantId: principal.tenantId, userId: principal.ownerId }),
        ]);
        const summaries = [
          ...owned.map((bot) => botSummary(bot)),
          ...shared.map(({ bot, role }) => botSummary(bot, role)),
        ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
        return Response.json(summaries, { headers: { "cache-control": "no-store" } });
      }

      if (collaborators || collaborator) {
        const botId = (collaborators?.[1] ?? collaborator?.[1]) as BotId;
        if (collaborators && request.method === "GET") {
          await requireApiScope(principal, "bots:read");
          const items = await management.listBotCollaborators({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId,
          });
          return Response.json({ items }, { headers: { "cache-control": "no-store" } });
        }
        if (collaborators && request.method === "PUT") {
          await requireApiScope(principal, "bots:write");
          const body = await readJsonBody(request, 4096);
          if (Object.keys(body).some((key) => !["userId", "role"].includes(key))) {
            throw new AppError("VALIDATION_ERROR", "Collaborator update contains unsupported fields.", 400);
          }
          const userId = parseCollaboratorUserId(body.userId);
          const role = parseCollaboratorRole(body.role);
          const item = await management.setBotCollaborator({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId,
            userId,
            role,
            now: new Date().toISOString(),
          });
          return Response.json({ item }, { status: 200, headers: { "cache-control": "no-store" } });
        }
        if (collaborator && request.method === "DELETE") {
          await requireApiScope(principal, "bots:write");
          const userId = decodeCollaboratorUserId(collaborator[2] ?? "");
          await management.removeBotCollaborator({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId,
            userId,
            now: new Date().toISOString(),
          });
          return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
        }
        return methodNotAllowed(collaborators ? "GET, PUT" : "DELETE");
      }

      if (versions) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        await requireApiScope(principal, "bots:read");
        const rawLimit = url.searchParams.get("limit");
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
          throw new AppError("VALIDATION_ERROR", "Version page size must be between 1 and 100.", 400);
        }
        const items = await management.listVersions({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId: versions[1] as BotId,
          limit,
        });
        return Response.json({ items }, { headers: { "cache-control": "no-store" } });
      }

      if (modelRetryPolicy) {
        if (request.method !== "PATCH") return methodNotAllowed("PATCH");
        await requireApiScope(principal, "bots:write");
        const botId = modelRetryPolicy[1] as BotId;
        const bot = await bots.get(principal.tenantId, botId);
        if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        const body = await readJsonBody(request, 4096);
        if (
          Object.keys(body).some((key) => !["expectedVersion", "retryPolicy"].includes(key)) ||
          !Object.hasOwn(body, "retryPolicy")
        ) {
          throw new AppError("VALIDATION_ERROR", "Retry policy update contains unsupported or missing fields.", 400);
        }
        if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
          throw new AppError("VALIDATION_ERROR", "expectedVersion must be a positive integer.", 400);
        }
        const retryPolicy = body.retryPolicy === null ? undefined : parseModelRetryPolicySettings(body.retryPolicy);
        const { retryPolicy: _previousRetryPolicy, ...modelWithoutRetryPolicy } = bot.model;
        const model = retryPolicy ? { ...modelWithoutRetryPolicy, retryPolicy } : modelWithoutRetryPolicy;
        const updated = await management.updateOwned({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          expectedVersion: body.expectedVersion as number,
          patch: { model },
        });
        return Response.json(botSummary(updated), { headers: { "cache-control": "no-store" } });
      }

      if (credentialApproval || credential || modelConfiguration) {
        const credentialBotId = (credentialApproval?.[1] ?? credential?.[1] ?? modelConfiguration?.[1]) as BotId;
        await requireApiScope(principal, "bots:write");
        const bot = await bots.get(principal.tenantId, credentialBotId);
        if (!bot || bot.ownerId !== principal.ownerId) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        if (credentialApproval) {
          if (request.method !== "POST") return methodNotAllowed("POST");
          if (!credentialApprovals) {
            throw new AppError("UNSUPPORTED_CAPABILITY", "Credential update approvals are unavailable.", 501);
          }
          const issued = await credentialApprovals.issue({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId: credentialBotId,
          });
          return Response.json(issued, { status: 201, headers: { "cache-control": "no-store" } });
        }
        if (request.method !== "PUT") return methodNotAllowed("PUT");
        if (!credentialApprovals || !secrets) {
          throw new AppError("UNSUPPORTED_CAPABILITY", "Model configuration updates are unavailable.", 501);
        }
        const body = await readJsonBody(request, 70_000);
        const allowedBodyKeys = modelConfiguration
          ? new Set(["expectedVersion", "approvalId", "credential", "model"])
          : new Set(["expectedVersion", "approvalId", "credential"]);
        if (Object.keys(body).some((key) => !allowedBodyKeys.has(key))) {
          throw new AppError("VALIDATION_ERROR", "Model update contains unsupported fields.", 400);
        }
        if (
          typeof body.credential !== "string" ||
          body.credential.length === 0 ||
          new TextEncoder().encode(body.credential).byteLength > 65_536 ||
          typeof body.approvalId !== "string" ||
          !Number.isSafeInteger(body.expectedVersion) ||
          (body.expectedVersion as number) < 1
        ) {
          throw new AppError("VALIDATION_ERROR", "Credential, approval ID, and expectedVersion are required.", 400);
        }
        let modelPatch: ModelConfig;
        if (modelConfiguration) {
          const parsedModel = validateModelConfig(body.model);
          if (parsedModel.credentialRef !== undefined) {
            throw new AppError("VALIDATION_ERROR", "Use the encrypted credential field for model configuration.", 400);
          }
          modelPatch = parsedModel;
        } else {
          modelPatch = bot.model;
        }
        if (body.expectedVersion !== bot.version) {
          throw new AppError("CONFLICT", "Bot version changed; reload before updating its model configuration.", 409);
        }
        const approved = await credentialApprovals.consume({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId: credentialBotId,
          approvalId: body.approvalId,
        });
        if (!approved) throw new AppError("FORBIDDEN", "Credential update approval is invalid or expired.", 403);
        const credentialRef = await secrets.put(principal.tenantId, body.credential);
        try {
          const updated = await management.updateOwned({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            botId: credentialBotId,
            expectedVersion: bot.version,
            patch: { model: { ...modelPatch, credentialRef } },
          });
          return Response.json(botSummary(updated), { headers: { "cache-control": "no-store" } });
        } catch (cause) {
          await secrets.delete(principal.tenantId, credentialRef).catch(() => undefined);
          throw cause;
        }
      }

      const botId = (item?.[1] ?? action?.[1]) as BotId | undefined;
      if (!botId) return undefined;
      if (action) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        await requireApiScope(principal, "bots:write");
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
        await requireApiScope(principal, "bots:read");
        const bot = await bots.get(principal.tenantId, botId);
        if (bot?.ownerId === principal.ownerId) {
          return Response.json(botSummary(bot), { headers: { "cache-control": "no-store" } });
        }
        const shared = await management.getCollaborated({
          tenantId: principal.tenantId,
          botId,
          userId: principal.ownerId,
        });
        if (!shared) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        return Response.json(botSummary(shared.bot, shared.role), { headers: { "cache-control": "no-store" } });
      }
      if (request.method === "PATCH") {
        await requireApiScope(principal, "bots:write");
        const body = await readJsonBody(request);
        const currentBot = await bots.get(principal.tenantId, botId);
        if (!currentBot) throw new AppError("NOT_FOUND", "Bot was not found.", 404);
        if (currentBot.ownerId !== principal.ownerId) {
          if (
            Object.keys(body).some((key) => !["expectedVersion", "name", "description", "systemPrompt"].includes(key))
          ) {
            throw new AppError("VALIDATION_ERROR", "Collaborators can update only bot identity settings.", 400);
          }
          if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
            throw new AppError("VALIDATION_ERROR", "expectedVersion must be a positive integer.", 400);
          }
          const settings: Record<string, unknown> = {};
          for (const key of ["name", "description", "systemPrompt"] as const) {
            if (body[key] !== undefined) settings[key] = body[key];
          }
          const updated = await management.updateCollaborated({
            tenantId: principal.tenantId,
            userId: principal.ownerId,
            botId,
            expectedVersion: body.expectedVersion as number,
            patch: validateBotSettingsPatch(settings),
          });
          return Response.json(botSummary(updated, "editor"), { headers: { "cache-control": "no-store" } });
        }
        if (
          Object.keys(body).some(
            (key) =>
              !["expectedVersion", "name", "description", "systemPrompt", "model", "memoryEnabled"].includes(key),
          )
        ) {
          throw new AppError("VALIDATION_ERROR", "Bot update contains unsupported fields.", 400);
        }
        if (body.model !== undefined) {
          throw new AppError(
            "VALIDATION_ERROR",
            "Provider, endpoint, and model changes require the approved model configuration flow.",
            400,
          );
        }
        if (!Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 1) {
          throw new AppError("VALIDATION_ERROR", "expectedVersion must be a positive integer.", 400);
        }
        const settings: Record<string, unknown> = {};
        for (const key of ["name", "description", "systemPrompt", "model", "memoryEnabled"] as const) {
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
        await requireApiScope(principal, "bots:write");
        await management.deleteOwned({ tenantId: principal.tenantId, ownerId: principal.ownerId, botId });
        return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
      }
      return methodNotAllowed("GET, PATCH, DELETE");
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

export function mapBotVersionHistoryItem(input: {
  readonly botId: BotId;
  readonly version: number;
  readonly configurationJson: string;
  readonly createdAt: string;
  readonly current: boolean;
}): BotVersionHistoryItem {
  let config: unknown;
  try {
    config = JSON.parse(input.configurationJson);
  } catch (cause) {
    throw new AppError("INTERNAL_ERROR", "Stored bot version configuration is invalid.", 500, { cause });
  }
  if (
    !isRecord(config) ||
    typeof config.systemPrompt !== "string" ||
    !isRecord(config.model) ||
    typeof config.model.providerId !== "string" ||
    typeof config.model.model !== "string"
  ) {
    throw new AppError("INTERNAL_ERROR", "Stored bot version configuration is invalid.", 500);
  }
  const rawModel = config.model;
  const model: BotVersionHistoryItem["model"] = {
    providerId: rawModel.providerId as string,
    model: rawModel.model as string,
    ...(typeof rawModel.endpoint === "string" ? { endpoint: rawModel.endpoint } : {}),
    ...(isModelParameters(rawModel.parameters) ? { parameters: rawModel.parameters } : {}),
    hasCredential: typeof rawModel.credentialRef === "string",
  };
  return {
    botId: input.botId,
    version: input.version,
    ...(typeof config.name === "string" ? { name: config.name } : {}),
    ...(typeof config.description === "string" ? { description: config.description } : {}),
    systemPrompt: config.systemPrompt,
    model,
    memoryEnabled: config.memoryEnabled === true,
    createdAt: input.createdAt,
    current: input.current,
  };
}

function isModelParameters(value: unknown): value is Readonly<Record<string, string | number | boolean>> {
  return (
    isRecord(value) &&
    Object.values(value).every(
      (item) =>
        typeof item === "string" || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item)),
    )
  );
}

function validateModelConfig(value: unknown): ModelConfig {
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Model settings are invalid.", 400);
  const allowed = new Set([
    "providerId",
    "model",
    "imageModel",
    "searchModel",
    "endpoint",
    "credentialRef",
    "parameters",
    "retryPolicy",
  ]);
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
  const imageModel = optionalModelIdentifier(value.imageModel, "imageModel");
  const searchModel = optionalModelIdentifier(value.searchModel, "searchModel");
  const retryPolicy = value.retryPolicy === undefined ? undefined : parseModelRetryPolicySettings(value.retryPolicy);
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
    ...(imageModel ? { imageModel } : {}),
    ...(searchModel ? { searchModel } : {}),
    ...(endpoint === undefined ? {} : { endpoint }),
    ...(value.credentialRef === undefined ? {} : { credentialRef: value.credentialRef as string }),
    ...(parameters === undefined ? {} : { parameters }),
    ...(retryPolicy === undefined ? {} : { retryPolicy }),
  };
}

function parseModelRetryPolicySettings(value: unknown): ModelRetryPolicySettings {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== "maxAttempts" && key !== "backoffMs") ||
    !Number.isSafeInteger(value.maxAttempts) ||
    (value.maxAttempts as number) < 1 ||
    (value.maxAttempts as number) > 3 ||
    !Number.isSafeInteger(value.backoffMs) ||
    (value.backoffMs as number) < 0 ||
    (value.backoffMs as number) > 3_000
  ) {
    throw new AppError("VALIDATION_ERROR", "Model retry settings must use 1–3 attempts and 0–3000 ms backoff.", 400);
  }
  return { maxAttempts: value.maxAttempts as number, backoffMs: value.backoffMs as number };
}

function optionalModelIdentifier(value: unknown, field: string): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 128) {
    throw new AppError("VALIDATION_ERROR", `Model setting '${field}' is invalid.`, 400);
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
  ) {
    throw new AppError("VALIDATION_ERROR", `Model setting '${field}' is invalid.`, 400);
  }
  return value.trim();
}

function botSummary(bot: BotDefinition, collaboratorRole?: BotCollaboratorRole) {
  const { credentialRef, ...model } = bot.model;
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    systemPrompt: bot.systemPrompt,
    memoryEnabled: bot.memoryEnabled ?? false,
    model: collaboratorRole
      ? { providerId: model.providerId, model: model.model, hasCredential: credentialRef !== undefined }
      : { ...model, hasCredential: credentialRef !== undefined },
    visibility: bot.visibility,
    status: bot.status,
    ...(bot.interfaces !== undefined ? { interfaces: bot.interfaces } : {}),
    version: bot.version,
    createdAt: bot.createdAt,
    updatedAt: bot.updatedAt,
    ...(collaboratorRole ? { collaboratorRole } : {}),
  };
}

function parseCollaboratorUserId(value: unknown): UserId {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", "Collaborator user ID is invalid.", 400);
  }
  return value as UserId;
}

function decodeCollaboratorUserId(value: string): UserId {
  try {
    return parseCollaboratorUserId(decodeURIComponent(value));
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Collaborator user ID is invalid.", 400);
  }
}

function parseCollaboratorRole(value: unknown): BotCollaboratorRole {
  if (value !== "viewer" && value !== "editor") {
    throw new AppError("VALIDATION_ERROR", "Collaborator role must be viewer or editor.", 400);
  }
  return value;
}

async function readJsonBody(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes)
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  let value: unknown;
  try {
    const text = await readBoundedRequestText(request, maxBytes);
    if (new TextEncoder().encode(text).byteLength > maxBytes)
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
