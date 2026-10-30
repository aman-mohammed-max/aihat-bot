import { AppError } from "@aihat/core";
import type { ScheduledTaskScheduler } from "@aihat/core";
import type { BotCoordinator } from "./coordinator.js";

/** Routes each bot's durable schedules to one stable SQLite-backed Durable Object. */
export class CloudflareAlarmScheduler implements ScheduledTaskScheduler {
  constructor(private readonly namespace: DurableObjectNamespace<BotCoordinator>) {}

  async schedule(input: Parameters<ScheduledTaskScheduler["schedule"]>[0]): Promise<void> {
    validateOwner(input.tenantId, input.botId);
    if (!isTaskReference(input.taskId, /^task_[a-f0-9]{32}$/)) {
      throw new AppError("VALIDATION_ERROR", "Scheduled task identifier is invalid.", 400);
    }
    if (!isTaskReference(input.payloadRef, /^job_[a-f0-9]{32}$/)) {
      throw new AppError("VALIDATION_ERROR", "Scheduled task payload reference is invalid.", 400);
    }
    if (!Number.isFinite(Date.parse(input.runAt)) || !isTimeZone(input.timezone)) {
      throw new AppError("VALIDATION_ERROR", "Scheduled time or timezone is invalid.", 400);
    }
    const stub = this.#stub(input.tenantId, input.botId);
    try {
      const response = await stub.fetch("https://coordinator/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", "Durable task scheduling failed.", 503);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Durable task scheduling failed.", 503, { cause });
    }
  }

  async cancel(input: Parameters<ScheduledTaskScheduler["cancel"]>[0]): Promise<void> {
    validateOwner(input.tenantId, input.botId);
    if (!isTaskReference(input.taskId, /^task_[a-f0-9]{32}$/)) {
      throw new AppError("VALIDATION_ERROR", "Scheduled task identifier is invalid.", 400);
    }
    const stub = this.#stub(input.tenantId, input.botId);
    try {
      const response = await stub.fetch(
        `https://coordinator/tasks/${encodeURIComponent(input.taskId)}?tenantId=${encodeURIComponent(input.tenantId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new AppError("DEPENDENCY_UNAVAILABLE", "Durable task cancellation failed.", 503);
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      throw new AppError("DEPENDENCY_UNAVAILABLE", "Durable task cancellation failed.", 503, { cause });
    }
  }

  #stub(tenantId: string, botId: string) {
    const id = this.namespace.idFromName(`bot:${tenantId}:${botId}`);
    return this.namespace.get(id);
  }
}

function isTaskReference(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

function validateOwner(tenantId: string, botId: string): void {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(tenantId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(botId)) {
    throw new AppError("VALIDATION_ERROR", "Scheduled task owner reference is invalid.", 400);
  }
}

function isTimeZone(value: string): boolean {
  if (value.length < 1 || value.length > 128) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
