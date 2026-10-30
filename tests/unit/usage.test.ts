import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createUsageApiHandler,
  createUsageTrackingAgentEngine,
} from "../../packages/core/src/index.js";
import type {
  AgentRequest,
  CreationAnswers,
  ConversationId,
  TenantId,
  UsageRecord,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant-usage-test" as TenantId;
const ownerId = "user-usage-owner" as UserId;
const otherOwnerId = "user-usage-other" as UserId;

describe("owner-scoped usage analytics", () => {
  test("aggregates successful calls and reported tokens without exposing per-user records", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "usage-owner-bot",
        answers: creationAnswers(),
      });
      const privateBotId = await repositories.createDraft({
        tenantId,
        ownerId: otherOwnerId,
        idempotencyKey: "usage-other-bot",
        answers: creationAnswers(),
      });
      const now = new Date().toISOString();
      await repositories.recordUsage({
        id: "usage-recorded",
        tenantId,
        botId,
        actorId: ownerId,
        providerId: "openai-compatible",
        model: "model-test",
        inputTokens: 120,
        outputTokens: 30,
        usageReported: true,
        createdAt: now,
      });
      await repositories.recordUsage({
        id: "usage-unreported",
        tenantId,
        botId,
        actorId: ownerId,
        providerId: "openai-compatible",
        model: "model-test",
        inputTokens: 0,
        outputTokens: 0,
        usageReported: false,
        createdAt: now,
      });
      await repositories.recordUsage({
        id: "usage-other-owner",
        tenantId,
        botId: privateBotId,
        actorId: otherOwnerId,
        providerId: "openai-compatible",
        model: "model-test",
        inputTokens: 999,
        outputTokens: 999,
        usageReported: true,
        createdAt: now,
      });
      const token = await issueToken(repositories, ownerId, ["bots:read"]);
      const handler = createUsageApiHandler(new ApiTokenAuthenticator(repositories.apiTokens), repositories);
      const response = await handler(
        new Request("https://local.test/v1/usage?days=30", { headers: { authorization: `Bearer ${token}` } }),
      );

      expect(response?.status).toBe(200);
      const body = (await response?.json()) as {
        total: { requests: number; reportedRequests: number; inputTokens: number; outputTokens: number };
        byBot: Array<{
          botId: string;
          botName: string;
          requests: number;
          reportedRequests: number;
          inputTokens: number;
          outputTokens: number;
        }>;
      };
      expect(body.total).toEqual({ requests: 2, reportedRequests: 1, inputTokens: 120, outputTokens: 30 });
      expect(body.byBot).toEqual([
        { botId, botName: "Usage test bot", requests: 2, reportedRequests: 1, inputTokens: 120, outputTokens: 30 },
      ]);
      expect(JSON.stringify(body)).not.toContain(ownerId);
      expect(JSON.stringify(body)).not.toContain("usage-other-owner");
    } finally {
      db.close();
    }
  });

  test("validates the date range and requires bots:read", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const ownerToken = await issueToken(repositories, ownerId, ["bots:read"]);
      const narrowToken = await issueToken(repositories, ownerId, ["bots:write"]);
      const handler = createUsageApiHandler(new ApiTokenAuthenticator(repositories.apiTokens), repositories);
      const invalid = await handler(
        new Request("https://local.test/v1/usage?days=365", {
          headers: { authorization: `Bearer ${ownerToken}` },
        }),
      );
      const forbidden = await handler(
        new Request("https://local.test/v1/usage", { headers: { authorization: `Bearer ${narrowToken}` } }),
      );
      expect(invalid?.status).toBe(400);
      expect(forbidden?.status).toBe(403);
    } finally {
      db.close();
    }
  });

  test("records provider usage without persisting pseudonymous Telegram actor IDs", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "usage-tracker-bot",
        answers: creationAnswers(),
      });
      const bot = await repositories.get(tenantId, botId);
      if (!bot) throw new Error("Bot fixture was not created.");
      const records: UsageRecord[] = [];
      const tracked = createUsageTrackingAgentEngine(
        { respond: async () => ({ message: { role: "assistant", content: "Hello" } }) },
        {
          recordUsage: async (record) => void records.push(record),
          getOwnedUsageSummary: async () => ({
            from: "",
            through: "",
            total: { requests: 0, reportedRequests: 0, inputTokens: 0, outputTokens: 0 },
            byDay: [],
            byBot: [],
          }),
        },
        { info: () => {}, warn: () => {}, error: () => {} },
      );
      const request: AgentRequest = {
        bot,
        conversationId: "conversation_usage_test" as ConversationId,
        actorId: "telegram_private_actor" as UserId,
        actorContext: { platform: "telegram", telegramUserId: 1234 },
        messages: [{ role: "user", content: "Hello" }],
      };

      await tracked.respond(request);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        tenantId,
        botId,
        providerId: "openai-compatible",
        model: "model-test",
        usageReported: false,
        inputTokens: 0,
        outputTokens: 0,
      });
      expect(records[0]?.actorId).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

function seedTenant(db: ReturnType<typeof openSqliteDatabase>): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Usage test', ?)").run(
    tenantId,
    "2026-10-30T00:00:00.000Z",
  );
  for (const userId of [ownerId, otherOwnerId]) {
    db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
      userId,
      userId,
      "2026-10-30T00:00:00.000Z",
    );
    db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
      tenantId,
      userId,
      "2026-10-30T00:00:00.000Z",
    );
  }
}

async function issueToken(repositories: BunSqliteRepositories, userId: UserId, scopes: readonly string[]) {
  const material = await createApiTokenMaterial();
  await repositories.apiTokens.create({
    tokenId: `token_${crypto.randomUUID()}`,
    tenantId,
    ownerId: userId,
    tokenHash: material.tokenHash,
    tokenPrefix: material.tokenPrefix,
    scopes,
    createdAt: new Date().toISOString(),
  });
  return material.token;
}

function creationAnswers(): CreationAnswers {
  return {
    name: "Usage test bot",
    description: "A bot for usage tests.",
    purpose: "Answer test prompts.",
    audience: "Test suite",
    personality: "Clear and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    model: "model-test",
    credentialRef: `secret_${"a".repeat(32)}`,
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
