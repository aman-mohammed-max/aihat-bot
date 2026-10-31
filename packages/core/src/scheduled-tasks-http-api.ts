import { recordApiAuthorizationDenial, requireApiScope } from "./api-auth.js";
import type { ApiTokenAuthenticator } from "./api-auth.js";
import { AppError } from "./errors.js";
import type { ScheduledTaskService } from "./scheduled-tasks.js";
import type { BotId, ScheduledTaskId } from "./types.js";

const COLLECTION_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/scheduled-tasks$/;
const TASK_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/scheduled-tasks\/(task_[a-f0-9]{32})$/;
const RETRY_ROUTE = /^\/v1\/bots\/(bot_[a-f0-9-]{36})\/scheduled-tasks\/(task_[a-f0-9]{32})\/retry$/;

export function createScheduledTasksApiHandler(
  authenticator: ApiTokenAuthenticator,
  service: ScheduledTaskService,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const collection = COLLECTION_ROUTE.exec(url.pathname);
    const taskMatch = TASK_ROUTE.exec(url.pathname);
    const retryMatch = RETRY_ROUTE.exec(url.pathname);
    if (!collection && !taskMatch && !retryMatch) return undefined;
    try {
      const principal = await authenticator.authenticate(request);
      const botId = (collection?.[1] ?? taskMatch?.[1] ?? retryMatch?.[1]) as BotId;
      if (collection && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const tasks = await service.list({ tenantId: principal.tenantId, ownerId: principal.ownerId, botId });
        return Response.json({ tasks: tasks.map(serializeTask) }, noStore);
      }
      if (collection && request.method === "POST") {
        await requireApiScope(principal, "bots:write");
        await requireApiScope(principal, "agent:run");
        const body = await readJsonBody(request);
        if (
          Object.keys(body).length !== 4 ||
          typeof body.schedule !== "string" ||
          typeof body.timezone !== "string" ||
          typeof body.prompt !== "string" ||
          typeof body.notifyTelegramUserId !== "number"
        ) {
          throw new AppError("VALIDATION_ERROR", "Provide schedule, timezone, prompt, and notifyTelegramUserId.", 400);
        }
        const task = await service.create({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          botId,
          schedule: body.schedule,
          timezone: body.timezone,
          prompt: body.prompt,
          notifyTelegramUserId: body.notifyTelegramUserId,
        });
        return Response.json({ task: serializeTask(task) }, { ...noStore, status: 201 });
      }
      if (taskMatch && request.method === "GET") {
        await requireApiScope(principal, "bots:read");
        const task = await service.get({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: taskMatch[2] as ScheduledTaskId,
        });
        if (task.botId !== botId) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
        return Response.json({ task: serializeTask(task) }, noStore);
      }
      if (retryMatch && request.method === "POST") {
        await requireApiScope(principal, "bots:write");
        const existing = await service.get({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: retryMatch[2] as ScheduledTaskId,
        });
        if (existing.botId !== botId) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
        const task = await service.retryFailed({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: retryMatch[2] as ScheduledTaskId,
        });
        return Response.json({ task: serializeTask(task) }, noStore);
      }
      if (taskMatch && request.method === "PATCH") {
        await requireApiScope(principal, "bots:write");
        const existing = await service.get({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: taskMatch[2] as ScheduledTaskId,
        });
        if (existing.botId !== botId) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
        const body = await readJsonBody(request);
        if (Object.keys(body).length !== 1 || (body.status !== "active" && body.status !== "paused")) {
          throw new AppError("VALIDATION_ERROR", "Set status to active or paused.", 400);
        }
        const task = await service.setPaused({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: taskMatch[2] as ScheduledTaskId,
          paused: body.status === "paused",
        });
        return Response.json({ task: serializeTask(task) }, noStore);
      }
      if (taskMatch && request.method === "DELETE") {
        await requireApiScope(principal, "bots:write");
        const existing = await service.get({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: taskMatch[2] as ScheduledTaskId,
        });
        if (existing.botId !== botId) throw new AppError("NOT_FOUND", "Scheduled task was not found.", 404);
        await service.setPaused({
          tenantId: principal.tenantId,
          ownerId: principal.ownerId,
          taskId: taskMatch[2] as ScheduledTaskId,
          paused: true,
        });
        return new Response(null, { status: 204, headers: noStore.headers });
      }
      return methodNotAllowed(collection ? "GET, POST" : retryMatch ? "POST" : "GET, PATCH, DELETE");
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

function serializeTask(task: Awaited<ReturnType<ScheduledTaskService["get"]>>) {
  return {
    id: task.id,
    botId: task.botId,
    schedule: task.schedule,
    timezone: task.timezone,
    prompt: task.prompt,
    notifyTelegramUserId: task.notifyTelegramUserId,
    status: task.status,
    ...(task.nextRunAt ? { nextRunAt: task.nextRunAt } : {}),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new AppError("VALIDATION_ERROR", "Request body must use application/json.", 415);
  }
  let value: unknown;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 24_000) {
      throw new AppError("VALIDATION_ERROR", "Request body is too large.", 413);
    }
    value = JSON.parse(raw);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw new AppError("VALIDATION_ERROR", "Request body must be valid JSON.", 400, { cause });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AppError("VALIDATION_ERROR", "Request body must be a JSON object.", 400);
  }
  return value as Record<string, unknown>;
}

function methodNotAllowed(allow: string): Response {
  return Response.json(
    { error: "METHOD_NOT_ALLOWED", message: `Use ${allow} for this endpoint.` },
    { status: 405, headers: { ...noStore.headers, allow } },
  );
}

const noStore = { headers: { "cache-control": "no-store" } } as const;
