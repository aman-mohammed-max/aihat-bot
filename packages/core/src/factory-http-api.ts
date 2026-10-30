import { requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { CREATION_STEPS } from "./bot-factory.js";
import type { BotFactory } from "./bot-factory.js";
import { AppError } from "./errors.js";
import type { CreationApprovalAction, SecretWriter } from "./ports.js";
import type { CreationApprovalService } from "./creation-approvals.js";
import type { CreationSession, CreationStep } from "./types.js";

const SESSION_ROUTE =
  /^\/v1\/factory-sessions\/(factory_[a-f0-9-]{36})(?:\/(pause|resume|answer|credentials|draft|publish|approvals))?$/;

/** Authenticated HTTP surface for the resumable bot-creation state machine. */
export function createFactoryApiHandler(
  authenticator: ApiTokenAuthenticator,
  factory: BotFactory,
  approvals: CreationApprovalService,
  secrets?: SecretWriter,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const isCollection = url.pathname === "/v1/factory-sessions";
    const match = SESSION_ROUTE.exec(url.pathname);
    if (!isCollection && !match) return undefined;

    try {
      const principal = await authenticator.authenticate(request);
      const isRead = request.method === "GET" && Boolean(match?.[2] === undefined);
      requireApiScope(principal, isRead ? "factory:read" : "factory:write");

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
    const text = await request.text();
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
