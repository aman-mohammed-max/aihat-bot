import { describe, expect, test } from "bun:test";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createConversationHistoryApiHandler,
} from "../../packages/core/src/index.js";
import type { CreationAnswers, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-conversation-history" as TenantId;
const ownerId = "user-conversation-history" as UserId;
const otherOwnerId = "user-conversation-history-other" as UserId;

describe("owner-scoped conversation history API", () => {
  test("lists private conversation summaries and pages messages without exposing platform identifiers", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "conversation-history-bot",
        answers: creationAnswers(),
      });
      const conversationId = await repositories.getOrCreateApiConversation({
        tenantId,
        botId,
        actorId: ownerId,
        conversationKey: "private-platform-key",
      });
      await repositories.append(tenantId, conversationId, [
        { role: "user", content: "First question" },
        { role: "assistant", content: "First answer" },
        { role: "user", content: "Second question" },
      ]);
      const token = await issueToken(repositories, ownerId, ["bots:read"]);
      const writeToken = await issueToken(repositories, ownerId, ["bots:read", "bots:write"]);
      const handler = createConversationHistoryApiHandler(
        new ApiTokenAuthenticator(repositories.apiTokens),
        repositories,
      );
      const base = `https://local.test/v1/bots/${botId}/conversations`;

      const listed = await handler(new Request(base, { headers: { authorization: `Bearer ${token}` } }));
      expect(listed?.status).toBe(200);
      const listBody = (await listed?.json()) as { items: Array<Record<string, unknown>> };
      expect(listBody.items).toHaveLength(1);
      expect(listBody.items[0]).toMatchObject({
        id: conversationId,
        platform: "api",
        messageCount: 3,
        preview: "Second question",
      });
      expect(JSON.stringify(listBody)).not.toContain("private-platform-key");

      const firstPage = await handler(
        new Request(`${base}/${conversationId}/messages?limit=2`, { headers: { authorization: `Bearer ${token}` } }),
      );
      expect(firstPage?.status).toBe(200);
      const pageBody = (await firstPage?.json()) as {
        items: Array<{ sequence: number; content: string }>;
        hasMore: boolean;
      };
      expect(pageBody.items.map(({ sequence, content }) => [sequence, content])).toEqual([
        [2, "First answer"],
        [3, "Second question"],
      ]);
      expect(pageBody.hasMore).toBe(true);

      const older = await handler(
        new Request(`${base}/${conversationId}/messages?limit=2&beforeSequence=2`, {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(await older?.json()).toMatchObject({
        items: [{ sequence: 1, content: "First question" }],
        hasMore: false,
      });

      const webChatConversationId = await repositories.getOrCreateApiConversation({
        tenantId,
        botId,
        actorId: ownerId,
        conversationKey: "private-platform-key",
        platform: "web_chat",
      });
      expect(webChatConversationId).not.toBe(conversationId);
      const afterWebChat = await handler(new Request(base, { headers: { authorization: `Bearer ${token}` } }));
      const afterWebChatBody = (await afterWebChat?.json()) as {
        items: Array<{ id: string; platform: string }>;
      };
      expect(afterWebChatBody.items.some((item) => item.id === conversationId && item.platform === "api")).toBe(true);
      expect(
        afterWebChatBody.items.some((item) => item.id === webChatConversationId && item.platform === "web_chat"),
      ).toBe(true);

      const readDenied = await handler(
        new Request(`${base}/${conversationId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(readDenied?.status).toBe(403);
      const deleted = await handler(
        new Request(`${base}/${conversationId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${writeToken}` },
        }),
      );
      expect(deleted?.status).toBe(204);
      const messageCount = db
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM messages WHERE conversation_id = ?")
        .get(conversationId)?.count;
      expect(messageCount).toBe(0);
      const deletedHistory = await handler(
        new Request(`${base}/${conversationId}/messages`, { headers: { authorization: `Bearer ${token}` } }),
      );
      expect(deletedHistory?.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test("hides bots and conversations owned by someone else and requires bots:read", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId: otherOwnerId,
        idempotencyKey: "conversation-history-other-bot",
        answers: creationAnswers(),
      });
      const conversationId = await repositories.getOrCreateApiConversation({
        tenantId,
        botId,
        actorId: otherOwnerId,
        conversationKey: "private-other-owner-key",
      });
      await repositories.append(tenantId, conversationId, [{ role: "user", content: "Private owner message" }]);
      const ownerToken = await issueToken(repositories, ownerId, ["bots:read"]);
      const writeOnlyToken = await issueToken(repositories, ownerId, ["bots:write"]);
      const handler = createConversationHistoryApiHandler(
        new ApiTokenAuthenticator(repositories.apiTokens),
        repositories,
      );
      const endpoint = `https://local.test/v1/bots/${botId}/conversations`;

      const hidden = await handler(new Request(endpoint, { headers: { authorization: `Bearer ${ownerToken}` } }));
      expect(hidden?.status).toBe(404);
      const forbidden = await handler(
        new Request(endpoint, { headers: { authorization: `Bearer ${writeOnlyToken}` } }),
      );
      expect(forbidden?.status).toBe(403);
      const hiddenDelete = await handler(
        new Request(`${endpoint}/${conversationId}`, {
          method: "DELETE",
          headers: { authorization: `Bearer ${writeOnlyToken}` },
        }),
      );
      expect(hiddenDelete?.status).toBe(404);
      const privateMessageCount = db
        .query<{ count: number }, [string]>("SELECT count(*) AS count FROM messages WHERE conversation_id = ?")
        .get(conversationId)?.count;
      expect(privateMessageCount).toBe(1);
    } finally {
      db.close();
    }
  });
});

function seedTenant(db: ReturnType<typeof openSqliteDatabase>): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Conversation history test', ?)").run(
    tenantId,
    "2026-10-30T00:00:00.000Z",
  );
  for (const memberId of [ownerId, otherOwnerId]) {
    db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
      memberId,
      memberId,
      "2026-10-30T00:00:00.000Z",
    );
    db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
      tenantId,
      memberId,
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
    createdAt: "2026-10-30T00:00:00.000Z",
  });
  return material.token;
}

function creationAnswers(): CreationAnswers {
  return {
    name: "History bot",
    description: "A bot for history API tests.",
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
