import { describe, expect, test } from "bun:test";
import { ApiTokenAuthenticator, createAgentApiHandler, createApiTokenMaterial } from "../../packages/core/src/index.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import type { AgentEngine } from "../../packages/core/src/ports.js";
import type { CreationAnswers, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-agent-api" as TenantId;
const ownerId = "user-agent-api" as UserId;
const otherOwnerId = "user-agent-api-other" as UserId;

describe("authenticated agent API", () => {
  test("runs only an owned bot and reuses its actor-scoped API conversation", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "agent-api-bot",
        answers: creationAnswers(),
      });
      const ownerToken = await issueToken(repositories, ownerId, ["agent:run"], "token-agent-owner");
      const otherToken = await issueToken(repositories, otherOwnerId, ["agent:run"], "token-agent-other");
      const readOnlyToken = await issueToken(repositories, ownerId, ["factory:read"], "token-agent-readonly");
      const calls: string[] = [];
      const engine: AgentEngine = {
        respond: async (request) => {
          calls.push(request.conversationId);
          return { message: { role: "assistant", content: "The bot reply." } };
        },
      };
      const handler = createAgentApiHandler(
        new ApiTokenAuthenticator(repositories.apiTokens),
        repositories,
        repositories,
        engine,
      );
      const endpoint = `https://local.test/v1/bots/${botId}/messages`;
      const first = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Hello" }),
        }),
      );
      if (!first) throw new Error("agent route did not handle the request");
      expect(first.status).toBe(200);
      const firstResponse = (await first.json()) as { conversationId: string; message: string };
      expect(firstResponse.message).toBe("The bot reply.");
      expect(firstResponse.conversationId).toMatch(/^conv_[a-f0-9]{32}$/);

      const second = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Follow up", conversationId: firstResponse.conversationId }),
        }),
      );
      expect(second?.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toBe(calls[1]);

      const unauthorizedOwner = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Try another owner's bot." }),
        }),
      );
      expect(unauthorizedOwner?.status).toBe(404);
      expect(calls).toHaveLength(2);

      const missingScope = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${readOnlyToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "No run scope." }),
        }),
      );
      expect(missingScope?.status).toBe(403);
      expect(calls).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});

function seedTenant(db: ReturnType<typeof openSqliteDatabase>): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Agent API test', ?)").run(
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

async function issueToken(
  repositories: BunSqliteRepositories,
  ownerId: UserId,
  scopes: readonly string[],
  tokenId: string,
): Promise<string> {
  const material = await createApiTokenMaterial();
  await repositories.apiTokens.create({
    tokenId,
    tenantId,
    ownerId,
    tokenHash: material.tokenHash,
    tokenPrefix: material.tokenPrefix,
    scopes,
    createdAt: "2026-10-30T00:00:00.000Z",
  });
  return material.token;
}

function creationAnswers(): CreationAnswers {
  return {
    name: "API test bot",
    description: "A bot for exercising the message API.",
    purpose: "Answer test prompts.",
    audience: "Test suite",
    personality: "Helpful and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.openai.com/v1",
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
