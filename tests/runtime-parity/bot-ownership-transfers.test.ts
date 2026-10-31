import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { AppError } from "../../packages/core/src/errors.js";
import type { BotId, TenantId, UserId } from "../../packages/core/src/types.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

const tenantId = "tenant-transfer-parity" as TenantId;
const fromOwnerId = "user-transfer-from" as UserId;
const toOwnerId = "user-transfer-to" as UserId;
const botId = "bot_123e4567-e89b-12d3-a456-426614174000" as BotId;
const taskRunningId = "task_running_transfer";
const taskQueuedId = "task_queued_transfer";
const tokenHash = "a".repeat(64);
const createdAt = "2026-10-31T00:00:00.000Z";
const expiresAt = "2026-11-01T00:00:00.000Z";

describe("bot ownership transfer runtime parity", () => {
  test("requires the named recipient, waits for running work, pauses schedules, and transfers atomically", async () => {
    const bunDb = openSqliteDatabase(":memory:");
    const d1Db = openSqliteDatabase(":memory:");
    const bun = new BunSqliteRepositories(bunDb);
    const d1 = new CloudflareD1Repositories(new SqliteD1(d1Db) as unknown as D1Database);
    try {
      seedTransferFixture(bunDb);
      seedTransferFixture(d1Db);
      const input = {
        tenantId,
        botId,
        fromOwnerId,
        toOwnerId,
        transferId: "transfer_123e4567-e89b-12d3-a456-426614174000",
        tokenHash,
        createdAt,
        expiresAt,
      };
      const [bunCreated, d1Created] = await Promise.all([bun.create(input), d1.create(input)]);
      expect(bunCreated).toEqual(d1Created);
      expect(JSON.stringify(bunCreated)).not.toContain(tokenHash);
      const [bunPending, d1Pending] = await Promise.all([
        bun.getPending({ tenantId, botId, ownerId: fromOwnerId, now: createdAt }),
        d1.getPending({ tenantId, botId, ownerId: fromOwnerId, now: createdAt }),
      ]);
      expect(bunPending).toEqual(d1Pending);

      await expect(bun.accept({ tenantId, tokenHash, recipientId: fromOwnerId, now: createdAt })).rejects.toMatchObject(
        { code: "NOT_FOUND" },
      );
      await expect(d1.accept({ tenantId, tokenHash, recipientId: fromOwnerId, now: createdAt })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(bun.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(d1.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(readTransferState(bunDb)).toEqual(readTransferState(d1Db));
      expect(readTransferState(bunDb).ownerId).toBe(fromOwnerId);

      for (const db of [bunDb, d1Db]) {
        db.query("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(
          createdAt,
          "job_running_transfer",
        );
      }
      const [bunAccepted, d1Accepted] = await Promise.all([
        bun.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt }),
        d1.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt }),
      ]);
      expect(bunAccepted).toEqual(d1Accepted);
      expect(bunAccepted).toMatchObject({ status: "accepted", fromOwnerId, toOwnerId, acceptedAt: createdAt });
      expect(readTransferState(bunDb)).toEqual(readTransferState(d1Db));
      expect(readTransferState(bunDb)).toMatchObject({
        ownerId: toOwnerId,
        tasks: [
          { id: taskQueuedId, ownerId: toOwnerId, status: "paused", nextRunAt: null },
          { id: taskRunningId, ownerId: toOwnerId, status: "paused", nextRunAt: null },
        ],
        queuedJobStatus: "cancelled",
        formerOwnerGrantStatus: "revoked",
        transferTokenHash: null,
        transferStatus: "accepted",
        factorySessionOwnerId: toOwnerId,
        pendingApprovals: 0,
        auditActions: ["bot.ownership_transfer.created", "bot.ownership_transfer.accepted"],
      });
      await expect(bun.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt })).rejects.toBeInstanceOf(
        AppError,
      );
      await expect(d1.accept({ tenantId, tokenHash, recipientId: toOwnerId, now: createdAt })).rejects.toBeInstanceOf(
        AppError,
      );
    } finally {
      bunDb.close();
      d1Db.close();
    }
  });

  test("expires previous offers before allowing a replacement", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTransferFixture(db);
      const first = await repositories.create({
        tenantId,
        botId,
        fromOwnerId,
        toOwnerId,
        transferId: "transfer_123e4567-e89b-12d3-a456-426614174001",
        tokenHash,
        createdAt,
        expiresAt,
      });
      expect(first.status).toBe("pending");
      const replacement = await repositories.create({
        tenantId,
        botId,
        fromOwnerId,
        toOwnerId,
        transferId: "transfer_123e4567-e89b-12d3-a456-426614174002",
        tokenHash: "b".repeat(64),
        createdAt: expiresAt,
        expiresAt: "2026-11-02T00:00:00.000Z",
      });
      expect(replacement.status).toBe("pending");
      expect(db.query("SELECT status FROM bot_ownership_transfers WHERE id = ?").get(first.id)).toEqual({
        status: "expired",
      });
    } finally {
      db.close();
    }
  });

  test("revokes one-time offers and requires the recipient to remain an active member", async () => {
    const bunDb = openSqliteDatabase(":memory:");
    const d1Db = openSqliteDatabase(":memory:");
    const bun = new BunSqliteRepositories(bunDb);
    const d1 = new CloudflareD1Repositories(new SqliteD1(d1Db) as unknown as D1Database);
    try {
      seedTransferFixture(bunDb);
      seedTransferFixture(d1Db);
      const createInput = {
        tenantId,
        botId,
        fromOwnerId,
        toOwnerId,
        transferId: "transfer_123e4567-e89b-12d3-a456-426614174003",
        tokenHash: "d".repeat(64),
        createdAt,
        expiresAt,
      };
      await Promise.all([bun.create(createInput), d1.create(createInput)]);
      const revokeInput = {
        tenantId,
        botId,
        ownerId: fromOwnerId,
        transferId: createInput.transferId,
        now: createdAt,
      };
      const [bunRevoked, d1Revoked] = await Promise.all([bun.revoke(revokeInput), d1.revoke(revokeInput)]);
      expect(bunRevoked).toEqual(d1Revoked);
      expect(bunRevoked.status).toBe("revoked");
      expect(readTransferState(bunDb)).toEqual(readTransferState(d1Db));
      await expect(
        bun.accept({ tenantId, tokenHash: createInput.tokenHash, recipientId: toOwnerId, now: createdAt }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        d1.accept({ tenantId, tokenHash: createInput.tokenHash, recipientId: toOwnerId, now: createdAt }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      for (const db of [bunDb, d1Db]) {
        db.query("UPDATE tenant_memberships SET status = 'inactive' WHERE tenant_id = ? AND user_id = ?").run(
          tenantId,
          toOwnerId,
        );
      }
      const inactiveCreate = {
        ...createInput,
        transferId: "transfer_123e4567-e89b-12d3-a456-426614174004",
        tokenHash: "e".repeat(64),
        createdAt: "2026-10-31T00:01:00.000Z",
      };
      await expect(bun.create(inactiveCreate)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(d1.create(inactiveCreate)).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      bunDb.close();
      d1Db.close();
    }
  });
});

function seedTransferFixture(db: Database): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Transfer parity', ?)").run(tenantId, createdAt);
  for (const userId of [fromOwnerId, toOwnerId]) {
    db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'transfer-test', ?, ?)").run(
      userId,
      userId,
      createdAt,
    );
  }
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    fromOwnerId,
    createdAt,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(
    tenantId,
    toOwnerId,
    createdAt,
  );
  db.query(`
    INSERT INTO bots (id, tenant_id, owner_id, name, description, status, visibility, current_version, created_at, updated_at)
    VALUES (?, ?, ?, 'Transfer bot', '', 'published', 'private', 1, ?, ?)
  `).run(botId, tenantId, fromOwnerId, createdAt, createdAt);
  db.query(`
    INSERT INTO factory_sessions (id, tenant_id, owner_id, status, bot_id, revision, created_at, updated_at)
    VALUES ('factory_transfer_session', ?, ?, 'published', ?, 1, ?, ?)
  `).run(tenantId, fromOwnerId, botId, createdAt, createdAt);
  db.query(`
    INSERT INTO creation_approvals (approval_hash, tenant_id, owner_id, session_id, action, created_at, expires_at)
    VALUES (?, ?, ?, 'factory_transfer_session', 'publish_bot', ?, ?)
  `).run("c".repeat(64), tenantId, fromOwnerId, createdAt, expiresAt);
  insertTask(db, taskRunningId, "job_running_transfer", "running");
  insertTask(db, taskQueuedId, "job_queued_transfer", "queued");
  db.query(`
    INSERT INTO bot_access_grants (id, tenant_id, bot_id, user_id, invitation_token_hash, access_level, status, created_at)
    VALUES (?, ?, ?, ?, NULL, 'use', 'active', ?)
  `).run("grant_former_owner", tenantId, botId, fromOwnerId, createdAt);
}

function insertTask(db: Database, taskId: string, jobId: string, jobStatus: string): void {
  db.query(`
    INSERT INTO scheduled_tasks (
      id, tenant_id, bot_id, owner_id, schedule, timezone, payload_json, status, next_run_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'once', 'UTC', ?, 'active', ?, ?, ?)
  `).run(taskId, tenantId, botId, fromOwnerId, JSON.stringify({ taskId }), expiresAt, createdAt, createdAt);
  db.query(`
    INSERT INTO jobs (
      id, tenant_id, kind, status, idempotency_key, payload_json, attempts, available_at, created_at, updated_at
    ) VALUES (?, ?, 'scheduled_task', ?, ?, ?, 0, ?, ?, ?)
  `).run(jobId, tenantId, jobStatus, `${taskId}:run`, JSON.stringify({ taskId }), createdAt, createdAt, createdAt);
}

function readTransferState(db: Database): Record<string, unknown> {
  const bot = db
    .query<{ owner_id: string }, [string, string]>("SELECT owner_id FROM bots WHERE tenant_id = ? AND id = ?")
    .get(tenantId, botId);
  const tasks = db
    .query<{ id: string; owner_id: string; status: string; next_run_at: string | null }, [string, string]>(`
      SELECT id, owner_id, status, next_run_at FROM scheduled_tasks WHERE tenant_id = ? AND bot_id = ? ORDER BY id
    `)
    .all(tenantId, botId)
    .map((task) => ({ id: task.id, ownerId: task.owner_id, status: task.status, nextRunAt: task.next_run_at }));
  const queuedJob = db.query<{ status: string }, []>("SELECT status FROM jobs WHERE id = 'job_queued_transfer'").get();
  const formerOwnerGrant = db
    .query<{ status: string }, []>("SELECT status FROM bot_access_grants WHERE id = 'grant_former_owner'")
    .get();
  const transfer = db
    .query<{ token_hash: string | null; status: string }, [string, string]>(`
      SELECT token_hash, status FROM bot_ownership_transfers WHERE tenant_id = ? AND bot_id = ? ORDER BY created_at DESC LIMIT 1
    `)
    .get(tenantId, botId);
  const factorySession = db
    .query<{ owner_id: string }, []>("SELECT owner_id FROM factory_sessions WHERE id = 'factory_transfer_session'")
    .get();
  const pendingApprovals = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM creation_approvals WHERE session_id = 'factory_transfer_session'",
    )
    .get();
  const auditActions = db
    .query<{ action: string }, [string, string]>(`
      SELECT action FROM audit_logs WHERE tenant_id = ? AND resource_type = 'bot' AND resource_id = ?
      ORDER BY action DESC
    `)
    .all(tenantId, botId)
    .map((event) => event.action);
  return {
    ownerId: bot?.owner_id,
    tasks,
    queuedJobStatus: queuedJob?.status,
    formerOwnerGrantStatus: formerOwnerGrant?.status,
    transferTokenHash: transfer?.token_hash,
    transferStatus: transfer?.status,
    factorySessionOwnerId: factorySession?.owner_id,
    pendingApprovals: pendingApprovals?.count,
    auditActions,
  };
}
