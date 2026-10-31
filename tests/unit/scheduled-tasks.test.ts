import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  ScheduledTaskRunner,
  ScheduledTaskService,
  createApiTokenMaterial,
  createScheduledTasksApiHandler,
  nextTaskRunAt,
  parseTaskSchedule,
} from "../../packages/core/src/index.js";
import type { AgentEngine, ScheduledTaskScheduler } from "../../packages/core/src/ports.js";
import type { CreationAnswers, JobId, ScheduledTaskId, TenantId, UserId } from "../../packages/core/src/types.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";

const tenantId = "tenant-scheduled" as TenantId;
const ownerId = "user-scheduled" as UserId;

describe("timezone-aware task schedules", () => {
  test("parses one-time and daily schedule rules", () => {
    expect(parseTaskSchedule("once:2026-10-31T16:00:00Z")).toEqual({
      type: "once",
      at: "2026-10-31T16:00:00.000Z",
    });
    expect(parseTaskSchedule("daily:09:30")).toEqual({ type: "daily", time: "09:30" });
    expect(() => parseTaskSchedule("daily:25:00")).toThrow();
  });

  test("selects the next local daily time, crossing midnight in the configured zone", () => {
    expect(nextTaskRunAt("daily:09:30", "America/New_York", "2026-10-30T12:00:00.000Z")).toBe(
      "2026-10-30T13:30:00.000Z",
    );
    expect(nextTaskRunAt("daily:09:30", "America/New_York", "2026-10-30T14:00:00.000Z")).toBe(
      "2026-10-31T13:30:00.000Z",
    );
  });

  test("moves through a daylight-saving gap and picks the remaining repeated-time occurrence", () => {
    expect(nextTaskRunAt("daily:02:30", "America/New_York", "2026-03-08T00:00:00.000Z")).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    expect(nextTaskRunAt("daily:01:30", "America/New_York", "2026-11-01T05:45:00.000Z")).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  test("does not repeat a finished one-time schedule", () => {
    expect(nextTaskRunAt("once:2026-10-31T16:00:00Z", "UTC", "2026-11-01T00:00:00.000Z")).toBeUndefined();
  });
});

describe("persistent scheduled task execution", () => {
  test("creates owner-scoped schedules and retries Telegram delivery from the saved result", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "scheduled-test-bot",
        answers: creationAnswers(),
      });
      await repositories.publish({ tenantId, ownerId, botId, idempotencyKey: "scheduled-test-publish" });
      const material = await createApiTokenMaterial();
      await repositories.apiTokens.create({
        tokenId: "scheduled-test-token",
        tenantId,
        ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: ["bots:read", "bots:write", "agent:run"],
        createdAt: "2026-10-30T12:00:00.000Z",
      });
      let failedDelivery = true;
      const deliveries: string[] = [];
      const scheduled: { taskId: string; payloadRef: string; runAt: string }[] = [];
      const notifier = {
        assertScheduledRecipient: async () => undefined,
        sendScheduledMessage: async (input: { text: string }) => {
          deliveries.push(input.text);
          if (failedDelivery) {
            failedDelivery = false;
            throw new Error("Telegram temporarily unavailable");
          }
        },
      };
      const scheduler: ScheduledTaskScheduler = {
        schedule: async (input) => {
          scheduled.push({ taskId: input.taskId, payloadRef: input.payloadRef, runAt: input.runAt });
        },
        cancel: async () => undefined,
      };
      const service = new ScheduledTaskService(repositories, repositories, notifier, scheduler);
      const api = createScheduledTasksApiHandler(new ApiTokenAuthenticator(repositories.apiTokens), service);
      const endpoint = `https://local.test/v1/bots/${botId}/scheduled-tasks`;
      const scheduleAt = new Date(Date.now() + 300_000).toISOString();
      const createdResponse = await api(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${material.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            schedule: `once:${scheduleAt}`,
            timezone: "UTC",
            prompt: "Summarize the daily report",
            notifyTelegramUserId: 12345,
          }),
        }),
      );
      expect(createdResponse?.status).toBe(201);
      const created = (await createdResponse?.json()) as {
        task: { id: string; nextRunAt: string; status: string; prompt: string };
      };
      expect(created.task).toMatchObject({
        nextRunAt: scheduleAt,
        status: "active",
        prompt: "Summarize the daily report",
      });
      expect(scheduled).toHaveLength(1);

      const listed = await api(new Request(endpoint, { headers: { authorization: `Bearer ${material.token}` } }));
      expect(await listed?.json()).toMatchObject({ tasks: [{ id: created.task.id }] });

      let engineCalls = 0;
      const engine: AgentEngine = {
        respond: async () => {
          engineCalls += 1;
          return { message: { role: "assistant", content: "Daily report is ready." } };
        },
      };
      const clock = () => new Date(Date.parse(created.task.nextRunAt) + 1_000).toISOString();
      const runner = new ScheduledTaskRunner(
        repositories,
        repositories,
        repositories,
        engine,
        notifier,
        scheduler,
        clock,
      );
      const job = db.query<{ id: string }, []>("SELECT id FROM jobs WHERE kind = 'scheduled_task'").get();
      if (!job) throw new Error("Initial scheduled job is missing.");
      expect(await runner.process(job.id as JobId, created.task.nextRunAt)).toBe("retrying");
      expect(engineCalls).toBe(1);
      const retryAt = db
        .query<{ available_at: string }, [string]>("SELECT available_at FROM jobs WHERE id = ?")
        .get(job.id)?.available_at;
      if (!retryAt) throw new Error("Retry time was not stored.");
      expect(await runner.process(job.id as JobId, retryAt)).toBe("completed");
      expect(engineCalls).toBe(1);
      expect(deliveries).toEqual(["Daily report is ready.", "Daily report is ready."]);
      expect(
        await repositories.getScheduledTask({ tenantId, taskId: created.task.id as ScheduledTaskId }),
      ).toMatchObject({
        status: "completed",
      });
      expect(db.query<{ status: string }, [string]>("SELECT status FROM jobs WHERE id = ?").get(job.id)?.status).toBe(
        "succeeded",
      );

      const daily = await service.create({
        tenantId,
        ownerId,
        botId,
        schedule: "daily:09:00",
        timezone: "UTC",
        prompt: "Send the morning update",
        notifyTelegramUserId: 12345,
        now: "2026-10-30T08:00:00.000Z",
      });
      expect(daily.nextRunAt).toBe("2026-10-30T09:00:00.000Z");
      expect(
        await service.setPaused({
          tenantId,
          ownerId,
          taskId: daily.id,
          paused: true,
          now: "2026-10-30T08:10:00.000Z",
        }),
      ).toMatchObject({ status: "paused" });
      expect(
        await service.setPaused({
          tenantId,
          ownerId,
          taskId: daily.id,
          paused: false,
          now: "2026-10-30T08:30:00.000Z",
        }),
      ).toMatchObject({ status: "active", nextRunAt: "2026-10-30T09:00:00.000Z" });
      expect(await repositories.getScheduledTask({ tenantId, taskId: daily.id })).toMatchObject({
        status: "active",
        nextRunAt: "2026-10-30T09:00:00.000Z",
      });

      const failedJob = db
        .query<{ id: string }, [string]>(
          "SELECT id FROM jobs WHERE kind = 'scheduled_task' AND status = 'queued' AND json_extract(payload_json, '$.taskId') = ?",
        )
        .get(daily.id);
      if (!failedJob) throw new Error("Resumed scheduled job is missing.");
      const claimedFailedJob = await repositories.claimScheduledJob({
        jobId: failedJob.id as JobId,
        now: "2026-10-30T09:00:00.000Z",
        leaseUntil: "2026-10-30T09:10:00.000Z",
      });
      expect(claimedFailedJob?.status).toBe("running");
      await repositories.failScheduledJob({ jobId: failedJob.id as JobId, now: "2026-10-30T09:01:00.000Z" });
      await repositories.setScheduledTaskStatus({
        tenantId,
        ownerId,
        taskId: daily.id,
        status: "failed",
        now: "2026-10-30T09:01:00.000Z",
      });
      const retryResponse = await api(
        new Request(`${endpoint}/${daily.id}/retry`, {
          method: "POST",
          headers: { authorization: `Bearer ${material.token}` },
        }),
      );
      expect(retryResponse?.status).toBe(200);
      const retried = (await retryResponse?.json()) as { task: { status: string; nextRunAt: string } };
      expect(retried.task.status).toBe("active");
      expect(await repositories.getScheduledTask({ tenantId, taskId: daily.id })).toMatchObject({ status: "active" });
      expect(await repositories.getScheduledJob({ jobId: failedJob.id as JobId })).toMatchObject({
        status: "queued",
        attempts: 0,
        availableAt: retried.task.nextRunAt,
      });
      expect(scheduled.at(-1)).toMatchObject({ taskId: daily.id, payloadRef: failedJob.id });
      const secondRetry = await api(
        new Request(`${endpoint}/${daily.id}/retry`, {
          method: "POST",
          headers: { authorization: `Bearer ${material.token}` },
        }),
      );
      expect(secondRetry?.status).toBe(409);
    } finally {
      db.close();
    }
  });
});

function seedTenant(db: ReturnType<typeof openSqliteDatabase>): void {
  const now = "2026-10-30T12:00:00.000Z";
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Scheduled test tenant', ?)").run(tenantId, now);
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    ownerId,
    ownerId,
    now,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    now,
  );
}

function creationAnswers(): CreationAnswers {
  return {
    name: "Scheduled bot",
    description: "A scheduled task test bot.",
    purpose: "Scheduled report delivery.",
    audience: "Test suite",
    personality: "Helpful and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
    model: "test-model",
    credentialRef: `secret_${"a".repeat(32)}`,
    skills: [],
    mcpConnections: [],
    integrations: [],
    memoryEnabled: false,
    scheduledTasks: [],
    privacySettings: [],
    visibility: "private",
    interfaces: ["telegram"],
  };
}
