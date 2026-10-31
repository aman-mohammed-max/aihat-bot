import { EncryptedSecretStore } from "./encrypted-secrets.js";
import { AppError } from "./errors.js";
import { readBoundedRequestText } from "./http-body.js";
import { isOperatorRequestAuthorized, isOperatorTokenConfigured } from "./operator-auth.js";
import type { SecretKeyring, SecretRecordRepository } from "./ports.js";
import type { SecretRotationCursor } from "./encrypted-secrets.js";

export const SECRET_ROTATION_ROUTE = "/_operator/secrets/rotation";
const MAX_BODY_BYTES = 4096;

/** Operator-only, one-page secret rotation endpoint. Preview mode is the default. */
export function createSecretRotationApiHandler(input: {
  readonly records: SecretRecordRepository;
  readonly keyring: SecretKeyring;
  readonly authorizationToken: string;
}): (request: Request) => Promise<Response | undefined> {
  const store = new EncryptedSecretStore(input.records, input.keyring);
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== SECRET_ROTATION_ROUTE) return undefined;
    if (request.method !== "POST") return methodNotAllowed();
    if (!isOperatorTokenConfigured(input.authorizationToken)) {
      return errorResponse(503, "UNSUPPORTED_CAPABILITY", "Operator secret rotation is not configured.");
    }
    if (!isOperatorRequestAuthorized(request, input.authorizationToken)) {
      return errorResponse(401, "UNAUTHENTICATED", "Operator authorization is invalid.", {
        "www-authenticate": "Bearer",
      });
    }

    try {
      const body = await readBody(request);
      const keys = Object.keys(body);
      if (keys.some((key) => !["mode", "after", "limit"].includes(key))) {
        throw new AppError("VALIDATION_ERROR", "Rotation request contains unsupported fields.", 400);
      }
      const mode = body.mode ?? "dry_run";
      if (mode !== "dry_run" && mode !== "apply") {
        throw new AppError("VALIDATION_ERROR", "Rotation mode must be dry_run or apply.", 400);
      }
      const limit = body.limit ?? 100;
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 250) {
        throw new AppError("VALIDATION_ERROR", "Rotation page size must be between 1 and 250.", 400);
      }
      const after = parseCursor(body.after);
      const result = await store.rotatePage({ after, limit: limit as number, dryRun: mode === "dry_run" });
      return Response.json({ mode, ...result }, { headers: { "cache-control": "no-store", pragma: "no-cache" } });
    } catch (cause) {
      if (cause instanceof AppError) {
        return errorResponse(cause.status, cause.code, cause.message);
      }
      return errorResponse(500, "INTERNAL_ERROR", "Secret rotation could not be completed.");
    }
  };
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION_ERROR", "Rotation request is too large.", 413);
  }
  let value: unknown;
  try {
    const text = await readBoundedRequestText(request, MAX_BODY_BYTES, "Rotation request is too large.");
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
      throw new AppError("VALIDATION_ERROR", "Rotation request is too large.", 413);
    }
    value = JSON.parse(text);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Rotation request must be valid JSON.", 400, { cause });
  }
  if (!isRecord(value)) throw new AppError("VALIDATION_ERROR", "Rotation request must be a JSON object.", 400);
  return value;
}

function parseCursor(value: unknown): SecretRotationCursor | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "tenantId" && key !== "reference")) {
    throw new AppError("VALIDATION_ERROR", "Rotation cursor is invalid.", 400);
  }
  if (
    typeof value.tenantId !== "string" ||
    value.tenantId.length === 0 ||
    value.tenantId.length > 128 ||
    hasControlCharacters(value.tenantId) ||
    typeof value.reference !== "string" ||
    !/^secret_[a-f0-9]{32}$/.test(value.reference)
  ) {
    throw new AppError("VALIDATION_ERROR", "Rotation cursor is invalid.", 400);
  }
  return { tenantId: value.tenantId as SecretRotationCursor["tenantId"], reference: value.reference };
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorResponse(
  status: number,
  error: string,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  return Response.json(
    { error, message },
    { status, headers: { "cache-control": "no-store", pragma: "no-cache", ...extraHeaders } },
  );
}

function methodNotAllowed(): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: "Use POST for this endpoint." },
    { status: 405, headers: { allow: "POST", "cache-control": "no-store", pragma: "no-cache" } },
  );
}
