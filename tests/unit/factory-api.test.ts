import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  BotFactory,
  CreationApprovalService,
  EncryptedSecretStore,
  FactoryAssistant,
  createApiTokenMaterial,
  createFactoryApiHandler,
} from "../../packages/core/src/index.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import type { BotId, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-factory-api" as TenantId;
const ownerId = "user-factory-api" as UserId;

describe("authenticated bot factory API", () => {
  test("persists sessions and requires session-bound approvals for sensitive actions", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Factory API test', ?)").run(
        tenantId,
        "2026-10-30T00:00:00.000Z",
      );
      db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
        ownerId,
        ownerId,
        "2026-10-30T00:00:00.000Z",
      );
      db.query(`
        INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
      `).run(tenantId, ownerId, "2026-10-30T00:00:00.000Z");

      const material = await createApiTokenMaterial();
      await repositories.apiTokens.create({
        tokenId: "token-factory-api",
        tenantId,
        ownerId,
        tokenHash: material.tokenHash,
        tokenPrefix: material.tokenPrefix,
        scopes: ["factory:read", "factory:write"],
        createdAt: "2026-10-30T00:00:00.000Z",
      });
      const approvals = new CreationApprovalService(repositories.creationApprovals);
      const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
      const secrets = new EncryptedSecretStore(repositories.secretRecords, {
        activeKey: async () => ({ id: "test-key", material: encryptionKey }),
        getKey: async (id) => (id === "test-key" ? encryptionKey : undefined),
      });
      const modelCalls: Array<{ url: string; authorization: string | null; redirect: RequestRedirect | undefined }> =
        [];
      const handler = createFactoryApiHandler(
        new ApiTokenAuthenticator(repositories.apiTokens),
        new BotFactory({ sessions: repositories.sessions, approvals, drafts: repositories }),
        approvals,
        secrets,
        {
          modelDiscoveryOrigins: new Set(["https://api.example.test"]),
          fetch: async (input, init) => {
            modelCalls.push({
              url: String(input),
              authorization: new Headers(init?.headers).get("authorization"),
              redirect: init?.redirect,
            });
            return Response.json({
              data: [
                { id: "model-one", name: "Chat model", type: "chat" },
                { id: "gpt-image-1", name: "Image model", type: "image" },
              ],
            });
          },
          assistant: new FactoryAssistant({
            endpoint: "https://factory-llm.example.test/v1",
            token: "factory-draft-secret",
            model: "small-model",
            fetch: async () =>
              Response.json({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        name: "Draft assistant",
                        description: "A draft bot.",
                        purpose: "Help with a task.",
                        audience: "The team.",
                        personality: "Be clear and kind.",
                      }),
                    },
                  },
                ],
              }),
          }),
        },
      );
      const headers = { authorization: `Bearer ${material.token}` };

      const assisted = await handler(
        new Request("https://local.test/v1/factory-assist/generate", {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ idea: "A helpful team assistant." }),
        }),
      );
      expect(assisted?.status).toBe(200);
      const assistedBody = await assisted?.text();
      expect(assistedBody).toContain("Draft assistant");
      expect(assistedBody).not.toContain("factory-draft-secret");

      const start = await handler(new Request("https://local.test/v1/factory-sessions", { method: "POST", headers }));
      expect(start?.status).toBe(201);
      const session = (await start?.json()) as { id: string; currentStep: string; status: string };
      expect(session).toMatchObject({ currentStep: "name", status: "in_progress" });

      const read = await handler(new Request(`https://local.test/v1/factory-sessions/${session.id}`, { headers }));
      expect(read?.status).toBe(200);

      const paused = await handler(
        new Request(`https://local.test/v1/factory-sessions/${session.id}/pause`, { method: "POST", headers }),
      );
      if (!paused) throw new Error("pause route did not handle the request");
      expect(((await paused.json()) as { status: string }).status).toBe("paused");
      const resumed = await handler(
        new Request(`https://local.test/v1/factory-sessions/${session.id}/resume`, { method: "POST", headers }),
      );
      if (!resumed) throw new Error("resume route did not handle the request");
      expect(((await resumed.json()) as { status: string }).status).toBe("in_progress");

      const answers: ReadonlyArray<readonly [string, unknown]> = [
        ["name", "My assistant"],
        ["description", "A useful assistant."],
        ["purpose", "Help the team plan meals."],
        ["audience", "Team members"],
        ["personality", "Friendly and concise."],
        ["providerId", "openai-compatible"],
        ["endpoint", "https://api.example.test/v1"],
        ["model", "model-one"],
        ["credentialRef", `secret_${"a".repeat(32)}`],
        ["imageModel", "gpt-image-1"],
        ["searchModel", "provider-search-v2"],
        ["skills", []],
        ["mcpConnections", []],
        ["integrations", []],
        ["memoryEnabled", false],
        ["scheduledTasks", []],
        ["privacySettings", []],
        ["visibility", "private"],
        ["interfaces", ["api"]],
      ];
      const discoverModels = async (role: "chat" | "image" | "search", credential?: string) => {
        const response = await handler(
          new Request(`https://local.test/v1/factory-sessions/${session.id}/models`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ role, ...(credential ? { credential } : {}) }),
          }),
        );
        if (!response) throw new Error("model discovery route did not handle the request");
        return { response, body: (await response.json()) as { models: Array<{ id: string }> } };
      };
      let connectedCredentialRef: string | undefined;
      for (const [step, value] of answers) {
        if (step === "model") {
          const result = await discoverModels("chat", "temporary-model-secret");
          expect(result.response.status).toBe(200);
          expect(result.body.models.map((model) => model.id)).toEqual(["model-one"]);
          expect(modelCalls.at(-1)?.authorization).toBe("Bearer temporary-model-secret");
          expect(modelCalls.at(-1)?.url).toBe("https://api.example.test/v1/models");
          expect(modelCalls.at(-1)?.redirect).toBe("error");
          expect(JSON.stringify(result.body)).not.toContain("temporary-model-secret");
        }
        if (step === "imageModel" || step === "searchModel") {
          const result = await discoverModels(step === "imageModel" ? "image" : "search");
          expect(result.response.status).toBe(200);
          expect(modelCalls.at(-1)?.authorization).toBe("Bearer test-model-api-key");
          expect(result.body.models.length).toBe(step === "imageModel" ? 1 : 2);
        }
        if (step === "credentialRef") {
          const issue = await handler(
            new Request(`https://local.test/v1/factory-sessions/${session.id}/approvals`, { method: "POST", headers }),
          );
          if (!issue) throw new Error("approval route did not handle the request");
          expect(issue.status).toBe(201);
          const approvalId = ((await issue.json()) as { approvalId: string }).approvalId;
          const rejected = await handler(
            new Request(`https://local.test/v1/factory-sessions/${session.id}/credentials`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ credential: "test-model-api-key", approvalId: `approval_${"a".repeat(43)}` }),
            }),
          );
          expect(rejected?.status).toBe(403);
          expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM encrypted_secrets").get()?.count).toBe(
            0,
          );

          const connected = await handler(
            new Request(`https://local.test/v1/factory-sessions/${session.id}/credentials`, {
              method: "POST",
              headers: { ...headers, "content-type": "application/json" },
              body: JSON.stringify({ credential: "test-model-api-key", approvalId }),
            }),
          );
          if (!connected) throw new Error("credential route did not handle the request");
          expect(connected.status).toBe(200);
          const connectedSession = (await connected.json()) as { answers: { credentialRef: string } };
          connectedCredentialRef = connectedSession.answers.credentialRef;
          expect(JSON.stringify(connectedSession)).not.toContain("test-model-api-key");
          continue;
        }
        const response = await handler(
          new Request(`https://local.test/v1/factory-sessions/${session.id}/answer`, {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ step, value }),
          }),
        );
        expect(response?.status).toBe(200);
      }

      const draft = await handler(
        new Request(`https://local.test/v1/factory-sessions/${session.id}/draft`, { method: "POST", headers }),
      );
      const draftSession = (await draft?.json()) as { status: string; botId: string };
      expect(draft?.status).toBe(200);
      expect(draftSession.status).toBe("draft");
      expect(draftSession.botId.startsWith("bot_")).toBe(true);

      const issuePublish = await handler(
        new Request(`https://local.test/v1/factory-sessions/${session.id}/approvals`, { method: "POST", headers }),
      );
      expect(issuePublish?.status).toBe(201);
      const publishApproval = (await issuePublish?.json()) as { approvalId: string; action: string };
      expect(publishApproval.action).toBe("publish_bot");

      const published = await handler(
        new Request(`https://local.test/v1/factory-sessions/${session.id}/publish`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ approvalId: publishApproval.approvalId }),
        }),
      );
      if (!published) throw new Error("publish route did not handle the request");
      expect(((await published.json()) as { status: string }).status).toBe("published");

      const bot = await repositories.get(tenantId, draftSession.botId as BotId);
      expect(bot?.status).toBe("published");
      expect(bot?.model.credentialRef).toBe(connectedCredentialRef);
      expect(bot?.model.imageModel).toBe("gpt-image-1");
      expect(bot?.model.searchModel).toBe("provider-search-v2");
      const encryptedRecord = connectedCredentialRef
        ? await repositories.secretRecords.get(tenantId, connectedCredentialRef)
        : undefined;
      expect(encryptedRecord).toBeDefined();
      expect(JSON.stringify(encryptedRecord)).not.toContain("test-model-api-key");
      expect(connectedCredentialRef ? await secrets.resolve(tenantId, connectedCredentialRef) : undefined).toBe(
        "test-model-api-key",
      );
    } finally {
      db.close();
    }
  });

  test("does not allow an approval to cross tenants or be consumed twice", async () => {
    const db = openSqliteDatabase(":memory:");
    const repositories = new BunSqliteRepositories(db);
    try {
      db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Factory API test', ?)").run(
        tenantId,
        "2026-10-30T00:00:00.000Z",
      );
      db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
        ownerId,
        ownerId,
        "2026-10-30T00:00:00.000Z",
      );
      db.query(`
        INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
      `).run(tenantId, ownerId, "2026-10-30T00:00:00.000Z");
      await repositories.sessions.create({
        id: "factory_test_session",
        tenantId,
        ownerId,
        status: "in_progress",
        currentStep: "credentialRef",
        answers: {},
        revision: 1,
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      });
      const approvals = new CreationApprovalService(repositories.creationApprovals);
      const issued = await approvals.issue({
        tenantId,
        ownerId,
        sessionId: "factory_test_session",
        action: "connect_credentials",
      });
      expect(
        await approvals.consume({
          tenantId,
          ownerId,
          sessionId: "factory_another_session",
          action: "connect_credentials",
          approvalId: issued.approvalId,
        }),
      ).toBe(false);
      expect(
        await approvals.consume({
          tenantId,
          ownerId,
          sessionId: "factory_test_session",
          action: "connect_credentials",
          approvalId: "malformed-approval",
        }),
      ).toBe(false);

      expect(
        await approvals.consume({
          tenantId,
          ownerId,
          sessionId: "factory_test_session",
          action: "connect_credentials",
          approvalId: issued.approvalId,
        }),
      ).toBe(true);
      expect(
        await approvals.consume({
          tenantId,
          ownerId,
          sessionId: "factory_test_session",
          action: "connect_credentials",
          approvalId: issued.approvalId,
        }),
      ).toBe(false);

      const auditEvents = await repositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 });
      expect(auditEvents.map((event) => event.action).sort()).toEqual(
        [
          "creation.approval_issued",
          "creation.approval_rejected",
          "creation.approval_consumed",
          "creation.approval_rejected",
          "creation.approval_rejected",
        ].sort(),
      );
      expect(new Set(auditEvents.map((event) => event.resourceId))).toEqual(
        new Set(["factory_test_session", "factory_another_session"]),
      );
      expect(JSON.stringify(auditEvents)).not.toContain(issued.approvalId);
      expect(JSON.stringify(auditEvents)).not.toContain("approvalHash");
    } finally {
      db.close();
    }
  });
});
