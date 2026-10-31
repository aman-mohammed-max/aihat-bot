import { DurableObject } from "cloudflare:workers";
import { AppError, readBoundedRequestText } from "@aihat/core";

interface ScheduledTaskInput {
  tenantId: string;
  taskId: string;
  botId: string;
  runAt: string;
  timezone: string;
  payloadRef: string;
}

interface ScheduledTaskRow {
  [key: string]: SqlStorageValue;
  tenant_id: string;
  task_id: string;
  bot_id: string;
  run_at: number;
  timezone: string;
  payload_ref: string;
  status: "scheduled" | "dispatched";
}

/** Per-bot persistent alarm coordinator. The DO only emits durable queue jobs. */
export class BotCoordinator extends DurableObject<Env> {
  readonly #state: DurableObjectState;
  readonly #env: Env;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.#state = state;
    this.#env = env;
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_entries (
        tenant_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        bot_id TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        timezone TEXT NOT NULL,
        payload_ref TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('scheduled', 'dispatched')),
        created_at INTEGER NOT NULL,
        PRIMARY KEY (tenant_id, task_id)
      )
    `);
    state.storage.sql.exec("CREATE INDEX IF NOT EXISTS idx_scheduled_entries_due ON scheduled_entries(status, run_at)");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok", storage: "durable-object-sqlite" });
    }
    if (request.method === "POST" && url.pathname === "/tasks") {
      const parsed = await readScheduledTask(request);
      if (parsed instanceof Response) return parsed;
      this.#state.storage.sql.exec(
        `INSERT INTO scheduled_entries (
          tenant_id, task_id, bot_id, run_at, timezone, payload_ref, status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?)
        ON CONFLICT(tenant_id, task_id) DO UPDATE SET
          bot_id = excluded.bot_id, run_at = excluded.run_at,
          timezone = excluded.timezone, payload_ref = excluded.payload_ref,
          status = 'scheduled'
        `,
        parsed.tenantId,
        parsed.taskId,
        parsed.botId,
        Date.parse(parsed.runAt),
        parsed.timezone,
        parsed.payloadRef,
        Date.now(),
      );
      await this.#setNextAlarm();
      return Response.json({ status: "scheduled", taskId: parsed.taskId }, { status: 202 });
    }
    if (request.method === "DELETE" && url.pathname.startsWith("/tasks/")) {
      const tenantId = url.searchParams.get("tenantId");
      let taskId: string;
      try {
        taskId = decodeURIComponent(url.pathname.slice("/tasks/".length));
      } catch {
        return new Response("Invalid task reference.", { status: 400 });
      }
      if (!tenantId || !isIdentifier(tenantId) || !/^task_[a-f0-9]{32}$/.test(taskId)) {
        return new Response("Invalid task reference.", { status: 400 });
      }
      this.#state.storage.sql.exec(
        "DELETE FROM scheduled_entries WHERE tenant_id = ? AND task_id = ? AND status = 'scheduled'",
        tenantId,
        taskId,
      );
      await this.#setNextAlarm();
      return new Response(null, { status: 204 });
    }
    return new Response("Not found.", { status: 404 });
  }

  async alarm(): Promise<void> {
    const due = this.#state.storage.sql
      .exec<ScheduledTaskRow>(
        `
        SELECT tenant_id, task_id, bot_id, run_at, timezone, payload_ref, status
        FROM scheduled_entries WHERE status = 'scheduled' AND run_at <= ? ORDER BY run_at LIMIT 100
      `,
        Date.now(),
      )
      .toArray();
    for (const task of due) {
      const idempotencyKey = `${task.tenant_id}:${task.task_id}:${task.run_at}`;
      await this.#env.JOBS.send({
        type: "scheduled_task",
        idempotencyKey,
        tenantId: task.tenant_id,
        botId: task.bot_id,
        taskId: task.task_id,
        runAt: new Date(task.run_at).toISOString(),
        timezone: task.timezone,
        payloadRef: task.payload_ref,
      });
      this.#state.storage.sql.exec(
        `UPDATE scheduled_entries SET status = 'dispatched'
         WHERE tenant_id = ? AND task_id = ? AND run_at = ? AND status = 'scheduled'`,
        task.tenant_id,
        task.task_id,
        task.run_at,
      );
    }
    await this.#setNextAlarm();
  }

  async #setNextAlarm(): Promise<void> {
    const next = this.#state.storage.sql
      .exec<{ run_at: number }>("SELECT MIN(run_at) AS run_at FROM scheduled_entries WHERE status = 'scheduled'")
      .one();
    if (typeof next.run_at !== "number") {
      await this.#state.storage.deleteAlarm();
      return;
    }
    await this.#state.storage.setAlarm(Math.max(Date.now() + 1, next.run_at));
  }
}

async function readScheduledTask(request: Request): Promise<ScheduledTaskInput | Response> {
  let body: unknown;
  try {
    body = JSON.parse(await readBoundedRequestText(request, 512));
  } catch (cause) {
    return new Response("Request body must be valid bounded JSON.", {
      status: cause instanceof AppError ? cause.status : 400,
    });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response("Invalid scheduled task.", { status: 400 });
  }
  const input = body as Record<string, unknown>;
  if (
    typeof input.tenantId !== "string" ||
    !isIdentifier(input.tenantId) ||
    !isIdentifier(input.taskId) ||
    !isIdentifier(input.botId) ||
    typeof input.runAt !== "string" ||
    !Number.isFinite(Date.parse(input.runAt)) ||
    typeof input.timezone !== "string" ||
    !isTimeZone(input.timezone) ||
    typeof input.payloadRef !== "string" ||
    !/^job_[a-f0-9]{32}$/.test(input.payloadRef)
  ) {
    return new Response("Invalid scheduled task.", { status: 400 });
  }
  return {
    tenantId: input.tenantId,
    taskId: input.taskId,
    botId: input.botId,
    runAt: input.runAt,
    timezone: input.timezone,
    payloadRef: input.payloadRef,
  };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
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
