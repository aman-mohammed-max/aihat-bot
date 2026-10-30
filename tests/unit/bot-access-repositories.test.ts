import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import type { CreationAnswers, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-bot-access" as TenantId;
const ownerId = "user-bot-access-owner" as UserId;
const inviteeId = `usr_${"d".repeat(32)}` as UserId;
const inviteeTenantId = `ten_${"d".repeat(32)}` as TenantId;
const createdAt = "2026-10-30T12:00:00.000Z";

describe("Bun bot access repository", () => {
  test("applies public per-user limits and invitation grants transactionally", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedOwner(db);
      await repositories.telegramAuth.getOrCreateOwner({
        telegramUserId: 712345680,
        ownerId: inviteeId,
        tenantId: inviteeTenantId,
        workspaceName: "Invitee workspace",
        now: createdAt,
      });

      const sharedBotId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "shared-bot-access-test",
        answers: { ...answers(), visibility: "shared" },
      });
      await repositories.publish({
        tenantId,
        ownerId,
        botId: sharedBotId,
        idempotencyKey: "shared-bot-access-publish",
      });
      const grant = await repositories.createOwnedAccessGrant({
        tenantId,
        ownerId,
        botId: sharedBotId,
        invitationTokenHash: "e".repeat(64),
        now: createdAt,
      });
      expect(
        await repositories.acceptBotInvitation({
          invitationTokenHash: "e".repeat(64),
          userId: inviteeId,
          now: "2026-10-30T12:00:01.000Z",
        }),
      ).toMatchObject({ id: grant.id, userId: inviteeId, invitationAvailable: false });
      expect(
        await repositories.getSharedBot({ botId: sharedBotId, userId: inviteeId, now: "2026-10-30T12:00:02.000Z" }),
      ).toMatchObject({ id: sharedBotId, visibility: "shared" });
      expect(
        await repositories.consumeBotUse({
          botId: sharedBotId,
          userId: inviteeId,
          accessMode: "shared",
          now: "2026-10-30T12:00:03.000Z",
        }),
      ).toBe("allowed");
      expect(
        await repositories.revokeOwnedAccessGrant({ tenantId, ownerId, botId: sharedBotId, grantId: grant.id }),
      ).toBe(true);
      expect(
        await repositories.consumeBotUse({
          botId: sharedBotId,
          userId: inviteeId,
          accessMode: "shared",
          now: "2026-10-30T12:00:04.000Z",
        }),
      ).toBe("forbidden");

      const publicBotId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "public-bot-access-test",
        answers: answers(),
      });
      await repositories.publish({
        tenantId,
        ownerId,
        botId: publicBotId,
        idempotencyKey: "public-bot-access-publish",
      });
      expect(
        await repositories.setPublicBotAccessPolicy({
          tenantId,
          ownerId,
          botId: publicBotId,
          dailyUsageLimit: 2,
          rateLimitPerMinute: 1,
          now: createdAt,
        }),
      ).toMatchObject({ dailyUsageLimit: 2, rateLimitPerMinute: 1 });
      expect(
        await repositories.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: createdAt,
        }),
      ).toBe("allowed");
      expect(
        await repositories.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:00:30.000Z",
        }),
      ).toBe("rate_limited");
      expect(
        await repositories.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:01:00.000Z",
        }),
      ).toBe("allowed");
      expect(
        await repositories.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:02:00.000Z",
        }),
      ).toBe("quota_exceeded");

      const audit = await repositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 100 });
      const accessDecisions = audit.filter((event) => event.action === "bot.access.decision");
      expect(accessDecisions).toHaveLength(6);
      expect(accessDecisions.map((event) => event.metadata.outcome)).toEqual([
        "quota_exceeded",
        "allowed",
        "rate_limited",
        "forbidden",
        "allowed",
        "allowed",
      ]);
    } finally {
      db.close();
    }
  });
});

function seedOwner(db: ReturnType<typeof openSqliteDatabase>): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Bot access test', ?)").run(tenantId, createdAt);
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    ownerId,
    ownerId,
    createdAt,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    createdAt,
  );
}

function answers(): CreationAnswers {
  return {
    name: "Bot access test",
    description: "Bot access repository test",
    purpose: "Exercise access limits and invitation grants.",
    audience: "Test users",
    personality: "Clear and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    model: "test-model",
    credentialRef: `secret_${"a".repeat(32)}`,
    skills: [],
    mcpConnections: [],
    integrations: [],
    memoryEnabled: false,
    scheduledTasks: [],
    privacySettings: [],
    visibility: "public",
    interfaces: ["api"],
  };
}
