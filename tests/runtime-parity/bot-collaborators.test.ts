import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import type { CreationAnswers, TenantId, UserId } from "../../packages/core/src/types.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

const tenantId = "tenant-collaborators" as TenantId;
const otherTenantId = "tenant-collaborators-other" as TenantId;
const ownerId = "user-collaborators-owner" as UserId;
const editorId = "user-collaborators-editor" as UserId;
const viewerId = "user-collaborators-viewer" as UserId;
const foreignUserId = "user-collaborators-foreign" as UserId;
const now = "2026-10-31T12:00:00.000Z";

describe("bot collaborator runtime parity", () => {
  test("grants only active workspace members, limits editor changes, and revokes immediately", async () => {
    const bunDb = openSqliteDatabase(":memory:");
    const d1Db = openSqliteDatabase(":memory:");
    const bun = new BunSqliteRepositories(bunDb);
    const d1 = new CloudflareD1Repositories(new SqliteD1(d1Db) as unknown as D1Database);
    try {
      seedFixture(bunDb);
      seedFixture(d1Db);
      await Promise.all([exerciseCollaborators(bun, bunDb), exerciseCollaborators(d1, d1Db)]);
    } finally {
      bunDb.close();
      d1Db.close();
    }
  });
});

async function exerciseCollaborators(
  repositories: BunSqliteRepositories | CloudflareD1Repositories,
  db: Database,
): Promise<void> {
  const botId = await repositories.createDraft({
    tenantId,
    ownerId,
    idempotencyKey: "collaborator-parity-bot",
    answers: creationAnswers(),
  });
  await repositories.publish({ tenantId, ownerId, botId, idempotencyKey: "collaborator-parity-publish" });

  const editor = await repositories.setBotCollaborator({
    tenantId,
    ownerId,
    botId,
    userId: editorId,
    role: "editor",
    now,
  });
  await repositories.setBotCollaborator({ tenantId, ownerId, botId, userId: viewerId, role: "viewer", now });
  expect(editor).toMatchObject({ userId: editorId, role: "editor", memberStatus: "active" });
  expect(await repositories.listCollaborated({ tenantId, userId: editorId })).toMatchObject([
    { bot: { id: botId, ownerId, status: "published" }, role: "editor" },
  ]);
  expect(await repositories.getCollaborated({ tenantId, botId, userId: viewerId })).toMatchObject({
    bot: { id: botId },
    role: "viewer",
  });
  expect(await repositories.listBotCollaborators({ tenantId, ownerId, botId })).toMatchObject([
    { userId: editorId, role: "editor", memberStatus: "active" },
    { userId: viewerId, role: "viewer", memberStatus: "active" },
  ]);

  await expect(
    repositories.setBotCollaborator({ tenantId, ownerId, botId, userId: foreignUserId, role: "viewer", now }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  await expect(
    repositories.setBotCollaborator({ tenantId, ownerId, botId, userId: ownerId, role: "editor", now }),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });

  const edited = await repositories.updateCollaborated({
    tenantId,
    userId: editorId,
    botId,
    expectedVersion: 1,
    patch: { name: "Shared assistant", description: "Updated by a collaborator." },
  });
  expect(edited).toMatchObject({
    id: botId,
    ownerId,
    version: 2,
    name: "Shared assistant",
    description: "Updated by a collaborator.",
  });
  await expect(
    repositories.updateCollaborated({ tenantId, userId: viewerId, botId, expectedVersion: 2, patch: { name: "No" } }),
  ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
  await expect(
    repositories.updateCollaborated({
      tenantId,
      userId: editorId,
      botId,
      expectedVersion: 2,
      patch: { memoryEnabled: false } as never,
    }),
  ).rejects.toMatchObject({ code: "VALIDATION_ERROR", status: 400 });
  await expect(
    repositories.updateCollaborated({
      tenantId,
      userId: editorId,
      botId,
      expectedVersion: 1,
      patch: { name: "Stale" },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

  db.query("UPDATE tenant_memberships SET status = 'inactive' WHERE tenant_id = ? AND user_id = ?").run(
    tenantId,
    editorId,
  );
  expect(await repositories.getCollaborated({ tenantId, botId, userId: editorId })).toBeUndefined();
  await expect(
    repositories.updateCollaborated({ tenantId, userId: editorId, botId, expectedVersion: 2, patch: { name: "No" } }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  await expect(
    repositories.setBotCollaborator({ tenantId, ownerId, botId, userId: editorId, role: "editor", now }),
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  db.query("UPDATE tenant_memberships SET status = 'active' WHERE tenant_id = ? AND user_id = ?").run(
    tenantId,
    editorId,
  );

  await repositories.removeBotCollaborator({ tenantId, ownerId, botId, userId: editorId, now });
  expect(await repositories.getCollaborated({ tenantId, botId, userId: editorId })).toBeUndefined();
  expect(await repositories.listCollaborated({ tenantId, userId: editorId })).toEqual([]);
  expect(
    db
      .query<{ action: string; actor_id: string | null; metadata_json: string }, [string]>(`
        SELECT action, actor_id, metadata_json FROM audit_logs WHERE resource_id = ? ORDER BY rowid
      `)
      .all(botId),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ action: "bot.collaborator.set", actor_id: ownerId }),
      expect.objectContaining({ action: "bot.collaborator.settings_updated", actor_id: editorId }),
      expect.objectContaining({ action: "bot.collaborator.removed", actor_id: ownerId }),
    ]),
  );
  const auditMetadata = db
    .query<{ metadata_json: string }, [string]>("SELECT metadata_json FROM audit_logs WHERE resource_id = ?")
    .all(botId)
    .map(({ metadata_json }) => metadata_json)
    .join(" ");
  expect(auditMetadata).not.toContain("Updated by a collaborator.");
}

function seedFixture(db: Database): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Collaborator fixture', ?)").run(tenantId, now);
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Other fixture', ?)").run(otherTenantId, now);
  for (const userId of [ownerId, editorId, viewerId, foreignUserId]) {
    db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'collaborator-test', ?, ?)").run(
      userId,
      userId,
      now,
    );
  }
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    now,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(
    tenantId,
    editorId,
    now,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)").run(
    tenantId,
    viewerId,
    now,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    otherTenantId,
    foreignUserId,
    now,
  );
}

function creationAnswers(): CreationAnswers {
  return {
    name: "Collaborator bot",
    description: "A bot managed by its owner and named collaborators.",
    purpose: "Test shared management permissions.",
    audience: "Workspace members",
    personality: "Helpful and direct.",
    providerId: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    credentialRef: `secret_${"c".repeat(32)}`,
    model: "gpt-test",
    skills: [],
    mcpConnections: [],
    integrations: [],
    memoryEnabled: false,
    scheduledTasks: [],
    privacySettings: [],
    visibility: "private",
    interfaces: ["api"],
  };
}
