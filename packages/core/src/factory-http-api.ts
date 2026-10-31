import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { CREATION_STEPS } from "./bot-factory.js";
import type { BotFactory } from "./bot-factory.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import type { CreationApprovalAction, SecretStore, SecretWriter } from "./ports.js";
import type { CreationApprovalService } from "./creation-approvals.js";
import type { CreationSession, CreationStep } from "./types.js";
import { fetchModelCatalog, type ModelCatalogRole } from "./model-catalog.js";
import type { FactoryAssistant } from "./factory-assistant.js";

const SESSION_ROUTE =
  /^\/v1\/factory-sessions\/(factory_[a-f0-9-]{36})(?:\/(pause|resume|answer|credentials|models|draft|publish|approvals))?$/;

/** Authenticated HTTP surface for the resumable bot-creation state machine. */
export function createFactoryApiHandler(
  authenticator: ApiTokenAuthenticator,
  factory: BotFactory,
  approvals: CreationApprovalService,
  secrets?: SecretWriter & SecretStore,
  options: {
    readonly modelDiscoveryOrigins?: ReadonlySet<string>;
    readonly assistant?: FactoryAssistant;
    readonly fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  } = {},
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const isCollection = url.pathname === "/v1/factory-sessions";
    const isAssist = url.pathname === "/v1/factory-assist/generate";
    const match = SESSION_ROUTE.exec(url.pathname);
    if (!isCollection && !isAssist && !match) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      const isRead = request.method === "GET" && Boolean(match?.[2] === undefined);
      await requireApiScope(principal, isRead ? "factory:read" : "factory:write");

      if (isAssist) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        if (!options.assistant) {
          throw new AppError("UNSUPPORTED_CAPABILITY", "AI bot drafting is not configured for this runtime.", 501);
        }
        const body = await readJsonObject(request, 24_000);
        if (typeof body.idea !== "string") {
          throw new AppError("VALIDATION_ERROR", "Describe the bot idea before generating a draft.", 400);
        }
        const draft = await options.assistant.generate(body.idea);
        return Response.json({ draft }, { headers: { "cache-control": "no-store" } });
      }

      if (isCollection) {
        if (request.method !== "POST") return methodNotAllowed("POST");
        return Response.json(await factory.start(principal.tenantId, principal.ownerId), {
          status: 201,
          headers: { "cache-control": "no-store" },
        });
      }

      const sessionId = match?.[1];
      const action = match?.[2];
      if (!sessionId) return new Response(null, { status: 404 });
      if (!action) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        return Response.json(await factory.get(principal.tenantId, principal.ownerId, sessionId), {
          headers: { "cache-control": "no-store" },
        });
      }
      if (request.method !== "POST") return methodNotAllowed("POST");

      if (action === "models") {
        if (!secrets?.resolve || !options.modelDiscoveryOrigins) {
          throw new AppError("UNSUPPORTED_CAPABILITY", "Model discovery is not configured for this runtime.", 501);
        }
        const body = await readJsonObject(request, 70_000);
        if (body.role !== "chat" && body.role !== "image" && body.role !== "search" && body.role !== "audio") {
          throw new AppError("VALIDATION_ERROR", "Model discovery role is invalid.", 400);
        }
        if (body.credential !== undefined && typeof body.credential !== "string") {
          throw new AppError("VALIDATION_ERROR", "Temporary model credential must be a string.", 400);
        }
        const current = await factory.get(principal.tenantId, principal.ownerId, sessionId);
        const expectedStep =
          body.role === "chat"
            ? "model"
            : body.role === "image"
              ? "imageModel"
              : body.role === "audio"
                ? "audioModel"
                : "searchModel";
        if (current.currentStep !== expectedStep || current.status !== "in_progress") {
          throw new AppError("CONFLICT", "Model discovery is available only at its active setup step.", 409);
        }
        const endpoint = current.answers.endpoint;
        if (typeof endpoint !== "string") {
          throw new AppError("CONFLICT", "Set the provider endpoint before listing models.", 409);
        }
        const credentialRef = current.answers.credentialRef;
        const apiKey =
          typeof body.credential === "string"
            ? body.credential
            : typeof credentialRef === "string"
              ? await secrets.resolve(principal.tenantId, credentialRef)
              : "";
        const models = await fetchModelCatalog({
          endpoint,
          apiKey,
          role: body.role as ModelCatalogRole,
          allowedOrigins: options.modelDiscoveryOrigins,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        return Response.json({ models }, { headers: { "cache-control": "no-store" } });
      }

      let session: CreationSession | undefined;
      switch (action) {
        case "pause":
          session = await factory.pause(principal.tenantId, principal.ownerId, sessionId);
          break;
        case "resume":
          session = await factory.resume(principal.tenantId, principal.ownerId, sessionId);
          break;
        case "answer": {
          const body = await readJsonObject(request);
          if (typeof body.step !== "string" || !CREATION_STEPS.includes(body.step as CreationStep)) {
            throw new AppError("VALIDATION_ERROR", "A valid creation step is required.", 400);
          }
          if ("approvalId" in body && typeof body.approvalId !== "string") {
            throw new AppError("VALIDATION_ERROR", "Approval ID must be a string.", 400);
          }
          session = await factory.answer(
            principal.tenantId,
            principal.ownerId,
            sessionId,
            body.step as CreationStep,
            body.value,
            body.approvalId as string | undefined,
          );
          break;
        }
        case "credentials": {
          if (!secrets) throw new AppError("UNSUPPORTED_CAPABILITY", "Credential storage is unavailable.", 501);
          const body = await readJsonObject(request, 70_000);
          if (
            typeof body.credential !== "string" ||
            body.credential.length === 0 ||
            new TextEncoder().encode(body.credential).byteLength > 65_536 ||
            typeof body.approvalId !== "string"
          ) {
            throw new AppError("VALIDATION_ERROR", "Credential and approval ID are required.", 400);
          }
          session = await factory.connectCredential(
            principal.tenantId,
            principal.ownerId,
            sessionId,
            body.credential,
            body.approvalId,
            secrets,
          );
          break;
        }
        case "draft":
          session = await factory.createDraft(principal.tenantId, principal.ownerId, sessionId);
          break;
        case "publish": {
          const body = await readOptionalJsonObject(request);
          if (body.approvalId !== undefined && typeof body.approvalId !== "string") {
            throw new AppError("VALIDATION_ERROR", "Approval ID must be a string.", 400);
          }
          session = await factory.publish(
            principal.tenantId,
            principal.ownerId,
            sessionId,
            body.approvalId as string | undefined,
          );
          break;
        }
        case "approvals": {
          const current = await factory.get(principal.tenantId, principal.ownerId, sessionId);
          const approvalAction = requiredApproval(current.status, current.currentStep);
          if (!approvalAction) {
            throw new AppError("CONFLICT", "This creation session has no pending approval action.", 409);
          }
          const issued = await approvals.issue({
            tenantId: principal.tenantId,
            ownerId: principal.ownerId,
            sessionId,
            action: approvalAction,
          });
          return Response.json(
            { ...issued, action: approvalAction },
            {
              status: 201,
              headers: { "cache-control": "no-store" },
            },
          );
        }
      }
      if (!session) return undefined;
      return Response.json(session, { headers: { "cache-control": "no-store" } });
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

async function readJsonObject(request: Request, maxBytes = 16_384): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
  }
  let body: unknown;
  try {
    const text = await readBoundedRequestText(request, maxBytes);
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    body = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
  return body as Record<string, unknown>;
}

async function readOptionalJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.has("content-type") && !request.headers.has("content-length")) return {};
  return readJsonObject(request);
}

function requiredApproval(
  status: "in_progress" | "paused" | "ready" | "draft" | "published",
  step: CreationStep | null,
): CreationApprovalAction | undefined {
  if (status === "draft") return "publish_bot";
  if (status !== "in_progress") return undefined;
  if (step === "credentialRef") return "connect_credentials";
  if (step === "visibility") return "public_access";
  return undefined;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { allow, "cache-control": "no-store" } },
  );
}
