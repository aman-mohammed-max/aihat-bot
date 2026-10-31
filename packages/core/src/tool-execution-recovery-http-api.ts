import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ToolExecutionRepository } from "./ports.js";
import type { BotId } from "./types.js";

const BOT = "(bot_[a-f0-9-]{36})";
const EXECUTION_KEY = "([a-f0-9]{64})";
const COLLECTION_ROUTE = new RegExp(`^/v1/bots/${BOT}/tool-executions$`);
const RESOLVE_ROUTE = new RegExp(`^/v1/bots/${BOT}/tool-executions/${EXECUTION_KEY}/resolve$`);

export function createToolExecutionRecoveryApiHandler(
  authenticator: ApiTokenAuthenticator,
  executions: ToolExecutionRepository,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const collection = COLLECTION_ROUTE.exec(url.pathname);
    const resolve = RESOLVE_ROUTE.exec(url.pathname);
    if (!collection && !resolve) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      const botId = (collection?.[1] ?? resolve?.[1]) as BotId;
      if (collection && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const recoveries = await executions.listOwnedRecoveries({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          now: new Date().toISOString(),
          limit: 100,
        });
        return Response.json({ recoveries }, noStore);
      }
      if (resolve && request.method === "POST") {
        await requireApiScope(principal, "bots:write");
        const resolution = await readResolution(request);
        const status = await executions.resolveOwnedRecovery({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          executionKey: resolve[2] ?? "",
          resolution,
          now: new Date().toISOString(),
        });
        if (!status) throw new AppError("NOT_FOUND", "Ambiguous tool execution was not found.", 404);
        return Response.json({ status }, noStore);
      }
      return methodNotAllowed(collection ? "GET" : "POST");
    } catch (cause) {
      if (cause instanceof AppError) {
        await recordApiAuthorizationDenial(request, cause);
        return Response.json(
          { error: cause.code, message: cause.message },
          {
            status: cause.status,
            headers: { ...noStore.headers, ...(cause.status === 401 ? { "www-authenticate": "Bearer" } : {}) },
          },
        );
      }
      return Response.json(
        { error: "INTERNAL_ERROR", message: "The request could not be completed." },
        { status: 500, headers: noStore.headers },
      );
    }
  };
}

async function readResolution(request: Request): Promise<"retry" | "close"> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  let value: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 1024) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(raw);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    ((value as Record<string, unknown>).resolution !== "retry" &&
      (value as Record<string, unknown>).resolution !== "close")
  ) {
    throw new AppError("VALIDATION_ERROR", "Set resolution to retry or close.", 400);
  }
  return (value as { resolution: "retry" | "close" }).resolution;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { ...noStore.headers, allow } },
  );
}

const noStore = { headers: { "cache-control": "no-store" } } as const;
