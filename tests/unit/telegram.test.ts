import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createTelegramManagementApiHandler,
  createTelegramWebhookHandler,
  TelegramManager,
} from "../../packages/core/src/index.js";
import type { AgentEngine } from "../../packages/core/src/ports.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import type { CreationAnswers, TelegramDeploymentId, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-telegram" as TenantId;
const ownerId = "user-telegram" as UserId;

describe("Telegram webhook integration", () => {
  test("stores credentials encrypted, verifies webhook secrets, and deduplicates successful updates", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    const secrets = new Map<string, string>();
    const resolvedReferences: string[] = [];
    const secretStore = {
      put: async (_tenant: TenantId, plaintext: string) => {
        const reference = `secret_${crypto.randomUUID().replaceAll("-", "").slice(0, 32)}`;
        secrets.set(reference, plaintext);
        await repositories.secretRecords.create({
          tenantId,
          reference,
          keyId: "test-key",
          nonce: "nonce",
          ciphertext: "encrypted-test-value",
          version: 1,
          createdAt: new Date().toISOString(),
        });
        return reference;
      },
      resolve: async (_tenant: TenantId, reference: string) => {
        resolvedReferences.push(reference);
        const secret = secrets.get(reference);
        if (!secret) throw new Error("missing secret");
        return secret;
      },
      delete: async (_tenant: TenantId, reference: string) => {
        secrets.delete(reference);
        await repositories.secretRecords.delete(tenantId, reference);
      },
    };
    const calls: string[] = [];
    const sentMessages: Record<string, unknown>[] = [];
    let webhookRegistration: Record<string, unknown> | undefined;
    const fetchMock = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const request = input instanceof Request ? input : new Request(input, init);
      const method = new URL(request.url).pathname.split("/").at(-1);
      calls.push(method ?? "");
      if (method === "getMe") return Response.json({ ok: true, result: { id: 7654321, is_bot: true } });
      if (method === "setWebhook") {
        webhookRegistration = (await request.json()) as Record<string, unknown>;
        return Response.json({ ok: true, result: true });
      }
      if (method === "sendMessage") {
        sentMessages.push((await request.json()) as Record<string, unknown>);
        return Response.json({ ok: true, result: true });
      }
      if (method === "deleteWebhook") return Response.json({ ok: true, result: true });
      return Response.json({ ok: false, description: "unexpected method" }, { status: 404 });
    };

    try {
      seedTenant(db);
      const botId = await repositories.createDraft({
        tenantId,
        ownerId,
        idempotencyKey: "telegram-integration-bot",
        answers: creationAnswers(),
      });
      await repositories.publish({ tenantId, ownerId, botId, idempotencyKey: "telegram-integration-publish" });
      const tokenMaterial = await createApiTokenMaterial();
      await repositories.apiTokens.create({
        tokenId: "telegram-api-token",
        tenantId,
        ownerId,
        tokenHash: tokenMaterial.tokenHash,
        tokenPrefix: tokenMaterial.tokenPrefix,
        scopes: ["bots:read", "bots:write"],
        createdAt: new Date().toISOString(),
      });
      const engineCalls: string[] = [];
      const engine: AgentEngine = {
        respond: async (request) => {
          engineCalls.push(request.conversationId);
          expect(request.actorId).toMatch(/^telegram_[a-f0-9]{64}$/);
          expect(request.messages).toEqual([{ role: "user", content: "Hello from Telegram" }]);
          return { message: { role: "assistant", content: "Welcome." } };
        },
      };
      const telegram = new TelegramManager({
        repository: repositories,
        bots: repositories,
        secrets: secretStore,
        engine,
        webhookBaseUrl: "https://public.example.test",
        fetch: fetchMock,
      });
      const management = createTelegramManagementApiHandler(
        new ApiTokenAuthenticator(repositories.apiTokens),
        repositories,
        repositories,
        telegram,
      );
      const apiUrl = `https://local.test/v1/bots/${botId}/telegram`;
      const connectResponse = await management(
        new Request(apiUrl, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${tokenMaterial.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ token: "7654321:telegram-secret-value" }),
        }),
      );
      expect(connectResponse?.status).toBe(201);
      if (!connectResponse) throw new Error("Telegram route did not handle the request");
      const connectBody = await connectResponse.text();
      expect(connectBody).not.toContain("telegram-secret-value");
      expect(connectBody).toContain("7654321");

      const deployment = await repositories.getOwnedTelegramDeployment({ tenantId, ownerId, botId });
      expect(deployment).toMatchObject({ status: "active", externalId: "7654321" });
      if (!deployment) throw new Error("Telegram deployment was not saved");
      expect(secrets.get(deployment.credentialRef)).toBe("7654321:telegram-secret-value");
      expect(webhookRegistration).toMatchObject({
        url: `https://public.example.test/webhooks/telegram/${deployment.id}`,
        allowed_updates: ["message"],
        max_connections: 20,
      });
      const webhookSecret = webhookRegistration?.secret_token;
      expect(webhookSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const webhooks = createTelegramWebhookHandler(telegram);
      const endpoint = `https://public.example.test/webhooks/telegram/${deployment.id}`;
      const update = {
        update_id: 9042,
        message: { text: "Hello from Telegram", chat: { id: -10012345 }, from: { id: 54321, is_bot: false } },
      };
      resolvedReferences.length = 0;
      const rejected = await webhooks(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "wrong-secret" },
          body: JSON.stringify(update),
        }),
      );
      expect(rejected?.status).toBe(401);
      expect(resolvedReferences).toEqual([deployment.webhookSecretRef]);
      expect(engineCalls).toHaveLength(0);

      const pendingResponse = await webhooks(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": String(webhookSecret),
          },
          body: JSON.stringify({ ...update, update_id: 9041 }),
        }),
      );
      expect(pendingResponse?.status).toBe(200);
      expect(engineCalls).toHaveLength(0);
      expect(sentMessages).toHaveLength(0);

      const statusResponse = await management(
        new Request(apiUrl, { headers: { authorization: `Bearer ${tokenMaterial.token}` } }),
      );
      expect(await statusResponse?.json()).toMatchObject({ allowedUserIds: [], pendingUserIds: [54321] });
      const allowResponse = await management(
        new Request(apiUrl, {
          method: "PATCH",
          headers: {
            authorization: `Bearer ${tokenMaterial.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ allowedUserIds: [54321] }),
        }),
      );
      expect(await allowResponse?.json()).toMatchObject({ allowedUserIds: [54321], pendingUserIds: [] });

      const accepted = await webhooks(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": String(webhookSecret),
          },
          body: JSON.stringify(update),
        }),
      );
      expect(accepted?.status).toBe(200);
      expect(engineCalls).toHaveLength(1);
      expect(sentMessages).toEqual([{ chat_id: -10012345, text: "Welcome." }]);
      expect(
        db
          .query<{ state: string }, [string, number]>(
            "SELECT state FROM telegram_updates WHERE deployment_id = ? AND update_id = ?",
          )
          .get(deployment.id, update.update_id)?.state,
      ).toBe("completed");

      const duplicate = await webhooks(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": String(webhookSecret),
          },
          body: JSON.stringify(update),
        }),
      );
      expect(duplicate?.status).toBe(200);
      expect(engineCalls).toHaveLength(1);
      expect(sentMessages).toHaveLength(1);

      const removeResponse = await management(
        new Request(apiUrl, {
          method: "DELETE",
          headers: { authorization: `Bearer ${tokenMaterial.token}` },
        }),
      );
      expect(removeResponse?.status).toBe(204);
      expect(await repositories.getTelegramDeployment(deployment.id as TelegramDeploymentId)).toBeUndefined();
      expect(secrets.has(deployment.credentialRef)).toBe(false);
      expect(secrets.has(deployment.webhookSecretRef)).toBe(false);
    } finally {
      db.close();
    }
  });
});

function seedTenant(db: ReturnType<typeof openSqliteDatabase>): void {
  const now = new Date().toISOString();
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Telegram test tenant', ?)").run(tenantId, now);
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
    name: "Telegram test bot",
    description: "A test bot.",
    purpose: "Test Telegram delivery.",
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
