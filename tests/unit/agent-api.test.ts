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
      const calls: {
        readonly conversationId: string;
        readonly executionId?: string;
        readonly responseSchema?: unknown;
      }[] = [];
      const engine: AgentEngine = {
        respond: async (request, options) => {
          calls.push({
            conversationId: request.conversationId,
            ...(request.executionId === undefined ? {} : { executionId: request.executionId }),
            ...(request.responseSchema === undefined ? {} : { responseSchema: request.responseSchema }),
          });
          options?.onTextDelta?.("The ");
          options?.onTextDelta?.("bot reply.");
          return {
            message: {
              role: "assistant",
              content: request.responseSchema ? '{"answer":"structured"}' : "The bot reply.",
            },
            ...(request.messages[0]?.content === "Generate image" || request.messages[0]?.content === "Stream image"
              ? {
                  attachments: [
                    { kind: "image" as const, url: "https://images.example.test/generated.png", alt: "A kite" },
                  ],
                }
              : {}),
            ...(request.responseSchema ? { structuredOutput: { answer: "structured" } } : {}),
          };
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
      expect(calls[0]?.conversationId).toBe(calls[1]?.conversationId);
      expect(calls[0]?.executionId).not.toBe(calls[1]?.executionId);

      const streamed = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: "Stream a reply",
            conversationId: firstResponse.conversationId,
            stream: true,
          }),
        }),
      );
      expect(streamed?.headers.get("content-type")).toContain("text/event-stream");
      const eventText = await streamed?.text();
      expect(eventText).toContain('event: delta\ndata: {"delta":"The "}');
      expect(eventText).toContain('event: delta\ndata: {"delta":"bot reply."}');
      expect(eventText).toContain('event: done\ndata: {"conversationId":"');
      expect(calls).toHaveLength(3);
      expect(calls[2]?.conversationId).toBe(calls[0]?.conversationId);
      expect(calls[2]?.executionId).not.toBe(calls[0]?.executionId);

      const idempotentRequest = () =>
        handler(
          new Request(endpoint, {
            method: "POST",
            headers: {
              authorization: `Bearer ${ownerToken}`,
              "content-type": "application/json",
              "idempotency-key": "agent-retry-0001",
            },
            body: JSON.stringify({ message: "Retry this request", conversationId: firstResponse.conversationId }),
          }),
        );
      expect((await idempotentRequest())?.status).toBe(200);
      expect((await idempotentRequest())?.status).toBe(200);
      expect(calls[3]?.executionId).toBe(calls[4]?.executionId);

      const unauthorizedOwner = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${otherToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Try another owner's bot." }),
        }),
      );
      expect(unauthorizedOwner?.status).toBe(404);
      expect(calls).toHaveLength(5);

      const missingScope = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${readOnlyToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "No run scope." }),
        }),
      );
      expect(missingScope?.status).toBe(403);
      expect(calls).toHaveLength(5);

      const responseSchema = {
        type: "object",
        properties: { answer: { type: "string" } },
        required: ["answer"],
        additionalProperties: false,
      };
      const structured = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Return JSON", responseSchema }),
        }),
      );
      expect(structured?.status).toBe(200);
      expect(await structured?.json()).toMatchObject({
        message: '{"answer":"structured"}',
        structuredOutput: { answer: "structured" },
      });
      expect(calls[5]?.responseSchema).toEqual(responseSchema);

      const invalidStructured = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            message: "Return JSON",
            responseSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          }),
        }),
      );
      expect(invalidStructured?.status).toBe(400);
      expect(calls).toHaveLength(6);

      const generatedImage = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Generate image" }),
        }),
      );
      expect(await generatedImage?.json()).toMatchObject({
        attachments: [{ kind: "image", url: "https://images.example.test/generated.png", alt: "A kite" }],
      });

      const streamedImage = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
          body: JSON.stringify({ message: "Stream image", stream: true }),
        }),
      );
      expect(await streamedImage?.text()).toContain(
        '"attachments":[{"kind":"image","url":"https://images.example.test/generated.png","alt":"A kite"}]',
      );
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
