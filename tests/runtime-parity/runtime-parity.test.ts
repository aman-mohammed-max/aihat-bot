import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { BunSqliteRepositories } from "../../apps/bun-runtime/src/sqlite-store.js";
import { openSqliteDatabase } from "../../apps/bun-runtime/src/migrations.js";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { AgentOrchestrator } from "../../packages/core/src/agent.js";
import { AppError } from "../../packages/core/src/errors.js";
import { McpManager, MCP_INVOKE_PERMISSION } from "../../packages/core/src/mcp-manager.js";
import { ModelProviderRegistry, OpenAICompatibleProvider } from "../../packages/core/src/model.js";
import { SkillEngine } from "../../packages/core/src/skill-engine.js";
import { createDefaultNativeSkillRegistry } from "../../packages/core/src/native-skills.js";
import { EncryptedSecretStore } from "../../packages/core/src/encrypted-secrets.js";
import { telegramAccountIds } from "../../packages/core/src/telegram-auth.js";
import { BotCredentialApprovalService } from "../../packages/core/src/bot-credential-approvals.js";
import { createEncryptedMemoryService, createMemoryAwareAgentEngine } from "../../packages/core/src/memory.js";
import { DurableToolRegistry } from "../../packages/core/src/durable-tools.js";
import { getToolAttachments, withToolAttachments, type ToolContext } from "../../packages/core/src/tools.js";
import type {
  CreationAnswers,
  CreationSession,
  JobId,
  SkillCatalogPublication,
  ScheduledTaskId,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";
import { SqliteD1 } from "../helpers/sqlite-d1.js";

const tenantId = "tenant-parity" as TenantId;
const ownerId = "user-parity" as UserId;
const memberId = "user-parity-member" as UserId;
const createdAt = "2026-10-30T00:00:00.000Z";
const modelSecret = `secret_${"a".repeat(32)}`;
const weatherEndpoint = "https://weather.example.test/lookup";
const mcpEndpoint = "https://mcp.example.test/mcp";

describe("Bun and Cloudflare runtime repository parity", () => {
  test("Telegram master-bot request limits are per-user and windowed identically", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      const { ownerId: actorId } = await telegramAccountIds(456789123);
      const repositories = [bunRepositories.masterBot, cloudflareRepositories.masterBot];
      const results = await Promise.all(
        repositories.map(async (repository) => {
          const request = { actorId, now: "2026-10-30T12:00:00.000Z", limitPerMinute: 2 };
          const first = await repository.consumeUserRequest(request);
          const second = await repository.consumeUserRequest(request);
          const third = await repository.consumeUserRequest(request);
          const anotherUser = await repository.consumeUserRequest({
            ...request,
            actorId: (await telegramAccountIds(456789124)).ownerId,
          });
          const nextMinute = await repository.consumeUserRequest({
            ...request,
            now: "2026-10-30T12:01:00.000Z",
          });
          return [first, second, third, anotherUser, nextMinute];
        }),
      );
      expect(results[0]).toEqual(results[1]);
      expect(results[0]).toEqual([true, true, false, true, true]);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("MCP reconnect leases, retry times, and attempt counts persist consistently", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const repositories = [bunRepositories, cloudflareRepositories];
      const botIds = await Promise.all(
        repositories.map((repository) =>
          repository.createDraft({
            tenantId,
            ownerId,
            idempotencyKey: "mcp-reconnect-parity",
            answers: creationAnswers(),
          }),
        ),
      );
      const snapshots = await Promise.all(
        repositories.map(async (repository, index) => {
          const botId = botIds[index];
          if (!botId) throw new Error("MCP parity bot was not created.");
          const serverId = "mcp_reconnect_parity";
          await repository.mcp.createServer({
            id: serverId,
            tenantId,
            botId,
            name: "Reconnect parity server",
            endpoint: mcpEndpoint,
            installedBy: ownerId,
          });
          const now = "2026-01-01T00:00:00.000Z";
          const retryAfter = "2026-01-01T00:00:15.000Z";
          await repository.mcp.setServerStatus({
            tenantId,
            botId,
            serverId,
            status: "unhealthy",
            reconnectAfter: retryAfter,
          });
          const lease = {
            tenantId,
            botId,
            serverId,
            now: retryAfter,
            leaseUntil: "2026-01-01T00:00:20.000Z",
            leaseToken: "lease-first",
            maxAttempts: 5,
          };
          const firstClaim = await repository.mcp.claimServerReconnect(lease);
          const competingClaim = await repository.mcp.claimServerReconnect({ ...lease, leaseToken: "lease-competing" });
          const wrongLeaseRelease = await repository.mcp.failServerReconnect({
            tenantId,
            botId,
            serverId,
            attempt: 1,
            leaseToken: "lease-competing",
            now,
          });
          const retryAt = "2026-01-01T00:00:45.000Z";
          const failedAttemptRelease = await repository.mcp.failServerReconnect({
            tenantId,
            botId,
            serverId,
            attempt: 1,
            leaseToken: "lease-first",
            retryAfter: retryAt,
            now,
          });
          const earlyClaim = await repository.mcp.claimServerReconnect({
            ...lease,
            now: "2026-01-01T00:00:44.999Z",
            leaseToken: "lease-early",
          });
          const retryClaim = await repository.mcp.claimServerReconnect({
            ...lease,
            now: retryAt,
            leaseUntil: "2026-01-01T00:00:50.000Z",
            leaseToken: "lease-second",
          });
          await repository.mcp.setServerStatus({ tenantId, botId, serverId, status: "connected" });
          const server = await repository.mcp.getServer(tenantId, botId, serverId);
          return {
            firstClaim,
            competingClaim,
            wrongLeaseRelease,
            failedAttemptRelease,
            earlyClaim,
            retryClaim,
            finalServer: {
              status: server?.status,
              reconnectAttempts: server?.reconnectAttempts,
              reconnectAfter: server?.reconnectAfter,
            },
          };
        }),
      );
      expect(snapshots[0]).toEqual(snapshots[1]);
      expect(snapshots[0]).toEqual({
        firstClaim: 1,
        competingClaim: undefined,
        wrongLeaseRelease: false,
        failedAttemptRelease: true,
        earlyClaim: undefined,
        retryClaim: 2,
        finalServer: { status: "connected", reconnectAttempts: 0, reconnectAfter: undefined },
      });
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("keeps a privately listed bot unlisted while allowing explicitly granted users to run it", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const inviteeTenantId = `ten_${"p".repeat(32)}` as TenantId;
    const inviteeId = `usr_${"p".repeat(32)}` as UserId;
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      await Promise.all([
        bunRepositories.telegramAuth.getOrCreateOwner({
          telegramUserId: 712345681,
          ownerId: inviteeId,
          tenantId: inviteeTenantId,
          workspaceName: "Private access invitee",
          now: createdAt,
        }),
        cloudflareRepositories.telegramAuth.getOrCreateOwner({
          telegramUserId: 712345681,
          ownerId: inviteeId,
          tenantId: inviteeTenantId,
          workspaceName: "Private access invitee",
          now: createdAt,
        }),
      ]);
      const input = {
        tenantId,
        ownerId,
        idempotencyKey: "private-direct-share",
        answers: { ...creationAnswers(), visibility: "private" as const },
      };
      const [bunBotId, cloudflareBotId] = await Promise.all([
        bunRepositories.createDraft(input),
        cloudflareRepositories.createDraft(input),
      ]);
      await Promise.all([
        bunRepositories.publish({ tenantId, ownerId, botId: bunBotId, idempotencyKey: "private-share-publish" }),
        cloudflareRepositories.publish({
          tenantId,
          ownerId,
          botId: cloudflareBotId,
          idempotencyKey: "private-share-publish",
        }),
      ]);
      expect(
        await Promise.all([
          bunRepositories.getSharedBot({ botId: bunBotId, userId: inviteeId, now: createdAt }),
          cloudflareRepositories.getSharedBot({ botId: cloudflareBotId, userId: inviteeId, now: createdAt }),
        ]),
      ).toEqual([undefined, undefined]);
      const [bunGrant, cloudflareGrant] = await Promise.all([
        bunRepositories.createOwnedAccessGrant({
          tenantId,
          ownerId,
          botId: bunBotId,
          userId: inviteeId,
          now: createdAt,
        }),
        cloudflareRepositories.createOwnedAccessGrant({
          tenantId,
          ownerId,
          botId: cloudflareBotId,
          userId: inviteeId,
          now: createdAt,
        }),
      ]);
      expect(cloudflareGrant).toMatchObject({
        botId: cloudflareBotId,
        userId: inviteeId,
        accessLevel: bunGrant.accessLevel,
      });
      const [bunSharedBot, cloudflareSharedBot] = await Promise.all([
        bunRepositories.getSharedBot({ botId: bunBotId, userId: inviteeId, now: createdAt }),
        cloudflareRepositories.getSharedBot({ botId: cloudflareBotId, userId: inviteeId, now: createdAt }),
      ]);
      expect(bunSharedBot).toMatchObject({ id: bunBotId, visibility: "private" });
      expect(cloudflareSharedBot).toMatchObject({ id: cloudflareBotId, visibility: "private" });
      const [bunDecision, cloudflareDecision] = await Promise.all([
        bunRepositories.consumeBotUse({ botId: bunBotId, userId: inviteeId, accessMode: "shared", now: createdAt }),
        cloudflareRepositories.consumeBotUse({
          botId: cloudflareBotId,
          userId: inviteeId,
          accessMode: "shared",
          now: createdAt,
        }),
      ]);
      expect(bunDecision).toBe("allowed");
      expect(cloudflareDecision).toBe(bunDecision);
      expect(await bunRepositories.listPublicBots({ limit: 10 })).toEqual([]);
      expect(await cloudflareRepositories.listPublicBots({ limit: 10 })).toEqual([]);
      await Promise.all([
        bunRepositories.revokeOwnedAccessGrant({ tenantId, ownerId, botId: bunBotId, grantId: bunGrant.id }),
        cloudflareRepositories.revokeOwnedAccessGrant({
          tenantId,
          ownerId,
          botId: cloudflareBotId,
          grantId: cloudflareGrant.id,
        }),
      ]);
      expect(
        await Promise.all([
          bunRepositories.getSharedBot({ botId: bunBotId, userId: inviteeId, now: createdAt }),
          cloudflareRepositories.getSharedBot({ botId: cloudflareBotId, userId: inviteeId, now: createdAt }),
        ]),
      ).toEqual([undefined, undefined]);
      expect(
        await Promise.all([
          bunRepositories.consumeBotUse({ botId: bunBotId, userId: inviteeId, accessMode: "shared", now: createdAt }),
          cloudflareRepositories.consumeBotUse({
            botId: cloudflareBotId,
            userId: inviteeId,
            accessMode: "shared",
            now: createdAt,
          }),
        ]),
      ).toEqual(["forbidden", "forbidden"]);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("stores tenant skills and curates a globally shared catalog consistently", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const definition: SkillCatalogPublication = {
      id: "workspace.instructions.v1",
      name: "Workspace instructions",
      version: "1.0.0",
      author: "Workspace team",
      category: "productivity",
      description: "Adds workspace instructions to a bot.",
      executionType: "prompt",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredPermissions: [],
      configuration: { instructions: "Keep answers concise." },
      timeoutMs: 30_000,
      rateLimit: { maxRequests: 30, windowSeconds: 60 },
      retryPolicy: {
        maxAttempts: 1,
        backoffMs: 250,
        idempotent: false,
        retryableStatusCodes: [429, 500, 502, 503, 504],
      },
    };
    const globalDefinition: SkillCatalogPublication = {
      ...definition,
      id: "global.instructions.v1",
      name: "Global instructions",
      author: "Platform team",
      description: "Adds reviewed shared instructions to a bot.",
      configuration: { instructions: "Follow the approved platform guidance." },
    };
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      await Promise.all([
        bunRepositories.skills.publishCatalogSkill({ tenantId, definition }),
        cloudflareRepositories.skills.publishCatalogSkill({ tenantId, definition }),
        bunRepositories.skills.publishGlobalCatalogSkill({ definition: globalDefinition }),
        cloudflareRepositories.skills.publishGlobalCatalogSkill({ definition: globalDefinition }),
      ]);
      const [bunCatalog, d1Catalog, bunGlobal, d1Global] = await Promise.all([
        bunRepositories.skills.listCatalog(tenantId),
        cloudflareRepositories.skills.listCatalog(tenantId),
        bunRepositories.skills.listGlobalCatalog(),
        cloudflareRepositories.skills.listGlobalCatalog(),
      ]);
      expect(bunCatalog).toEqual(d1Catalog);
      expect(bunGlobal).toEqual(d1Global);
      expect(bunCatalog).toMatchObject([
        { id: globalDefinition.id, tenantId: null, enabled: true },
        { id: definition.id, tenantId, enabled: true, configuration: definition.configuration },
        { id: "aihat.text.statistics.v1", tenantId: null, enabled: true, executionType: "native" },
      ]);
      expect(await bunRepositories.skills.listCatalog("tenant-other" as TenantId)).toMatchObject([
        { id: globalDefinition.id, tenantId: null, enabled: true },
        { id: "aihat.text.statistics.v1", tenantId: null, enabled: true },
      ]);
      expect(await cloudflareRepositories.skills.listCatalog("tenant-other" as TenantId)).toMatchObject([
        { id: globalDefinition.id, tenantId: null, enabled: true },
        { id: "aihat.text.statistics.v1", tenantId: null, enabled: true },
      ]);
      await Promise.all([
        bunRepositories.skills.setGlobalCatalogSkillEnabled(globalDefinition.id, false),
        cloudflareRepositories.skills.setGlobalCatalogSkillEnabled(globalDefinition.id, false),
      ]);
      expect(await bunRepositories.skills.listCatalog("tenant-other" as TenantId)).toMatchObject([
        { id: "aihat.text.statistics.v1", tenantId: null, enabled: true },
      ]);
      expect(await cloudflareRepositories.skills.listCatalog("tenant-other" as TenantId)).toMatchObject([
        { id: "aihat.text.statistics.v1", tenantId: null, enabled: true },
      ]);
      expect(await bunRepositories.skills.listGlobalCatalog()).toMatchObject([
        { id: globalDefinition.id, enabled: false },
        { id: "aihat.text.statistics.v1", enabled: true },
      ]);
      expect(await cloudflareRepositories.skills.listGlobalCatalog()).toMatchObject([
        { id: globalDefinition.id, enabled: false },
        { id: "aihat.text.statistics.v1", enabled: true },
      ]);
      await expect(bunRepositories.skills.publishCatalogSkill({ tenantId, definition })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(cloudflareRepositories.skills.publishCatalogSkill({ tenantId, definition })).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("executes a reviewed native TypeScript skill identically through Bun and D1 repositories", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const registry = createDefaultNativeSkillRegistry();
    const [nativeDefinition] = registry.listDefinitions();
    if (!nativeDefinition) throw new Error("Expected a registered native skill.");
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const [bunBotId, cloudflareBotId] = await Promise.all([
        bunRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "native-skill-parity",
          answers: creationAnswers(),
        }),
        cloudflareRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "native-skill-parity",
          answers: creationAnswers(),
        }),
      ]);
      await Promise.all([
        bunRepositories.skills.install({
          tenantId,
          botId: bunBotId,
          skillId: nativeDefinition.id,
          installedBy: ownerId,
          configuration: {},
          grantedPermissions: ["text:analyze"],
        }),
        cloudflareRepositories.skills.install({
          tenantId,
          botId: cloudflareBotId,
          skillId: nativeDefinition.id,
          installedBy: ownerId,
          configuration: {},
          grantedPermissions: ["text:analyze"],
        }),
      ]);
      const createEngine = (repositories: BunSqliteRepositories | CloudflareD1Repositories) =>
        new SkillEngine({
          skills: repositories.skills,
          rateLimiter: repositories.skillRateLimiter,
          secrets: { resolve: async () => "unused" },
          allowedHttpOrigins: new Set(),
          nativeHandlers: registry.handlers,
        });
      const run = async (engine: SkillEngine, botId: Awaited<ReturnType<BunSqliteRepositories["createDraft"]>>) => {
        const context = { tenantId, botId, actorId: ownerId };
        const [tool] = await engine.available(context);
        if (!tool) throw new Error("Expected the granted native skill to be available.");
        return {
          tools: await engine.available(context),
          result: await engine.execute(context, tool.name, { text: "AI Hat\nworks" }),
        };
      };
      const [bunResult, cloudflareResult] = await Promise.all([
        run(createEngine(bunRepositories), bunBotId),
        run(createEngine(cloudflareRepositories), cloudflareBotId),
      ]);

      expect(bunResult).toEqual(cloudflareResult);
      expect(bunResult.result).toEqual({ characterCount: 12, lineCount: 2, wordCount: 3 });
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("existing-bot credential approvals are tenant-scoped and one-use in both adapters", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const [bunBotId, d1BotId] = await Promise.all([
        bunRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "credential-approval-bun",
          answers: creationAnswers(),
        }),
        cloudflareRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "credential-approval-d1",
          answers: creationAnswers(),
        }),
      ]);
      const bunApprovals = new BotCredentialApprovalService(bunRepositories.botCredentialApprovals);
      const d1Approvals = new BotCredentialApprovalService(cloudflareRepositories.botCredentialApprovals);
      const [bunIssued, d1Issued] = await Promise.all([
        bunApprovals.issue({ tenantId, ownerId, botId: bunBotId, now: new Date(createdAt) }),
        d1Approvals.issue({ tenantId, ownerId, botId: d1BotId, now: new Date(createdAt) }),
      ]);
      const [bunResults, d1Results] = await Promise.all([
        Promise.all([
          bunApprovals.consume({
            tenantId,
            ownerId,
            botId: "bot_other" as typeof bunBotId,
            approvalId: bunIssued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
          bunApprovals.consume({
            tenantId,
            ownerId,
            botId: bunBotId,
            approvalId: bunIssued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
          bunApprovals.consume({
            tenantId,
            ownerId,
            botId: bunBotId,
            approvalId: bunIssued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
        ]),
        Promise.all([
          d1Approvals.consume({
            tenantId,
            ownerId,
            botId: "bot_other" as typeof d1BotId,
            approvalId: d1Issued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
          d1Approvals.consume({
            tenantId,
            ownerId,
            botId: d1BotId,
            approvalId: d1Issued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
          d1Approvals.consume({
            tenantId,
            ownerId,
            botId: d1BotId,
            approvalId: d1Issued.approvalId,
            now: new Date("2026-10-30T00:01:00.000Z"),
          }),
        ]),
      ]);
      expect(d1Results).toEqual(bunResults);
      expect(bunResults).toEqual([false, true, false]);
      const [bunAudit, d1Audit] = await Promise.all([
        bunRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 20 }),
        cloudflareRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 20 }),
      ]);
      const expectedActions = [
        "bot.credential_approval_issued",
        "bot.credential_approval_consumed",
        "bot.credential_approval_rejected",
        "bot.credential_approval_rejected",
      ].sort();
      expect(bunAudit.map((event) => event.action).sort()).toEqual(expectedActions);
      expect(d1Audit.map((event) => event.action).sort()).toEqual(expectedActions);
      expect(JSON.stringify(bunAudit)).not.toContain(bunIssued.approvalId);
      expect(JSON.stringify(d1Audit)).not.toContain(d1Issued.approvalId);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("secret envelope rotation uses the same paged compare-and-swap behavior", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const oldKey = new Uint8Array(32).fill(17);
    const newKey = new Uint8Array(32).fill(31);
    const oldKeyring = {
      activeKey: async () => ({ id: "previous-key", material: oldKey }),
      getKey: async (id: string) => (id === "previous-key" ? oldKey : undefined),
    };
    const newKeyring = {
      activeKey: async () => ({ id: "current-key", material: newKey }),
      getKey: async (id: string) => (id === "previous-key" ? oldKey : id === "current-key" ? newKey : undefined),
    };
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const [bunOld, d1Old] = [
        new EncryptedSecretStore(bunRepositories.secretRecords, oldKeyring),
        new EncryptedSecretStore(cloudflareRepositories.secretRecords, oldKeyring),
      ];
      const [bunReference, d1Reference] = await Promise.all([
        bunOld.put(tenantId, "same-secret-value"),
        d1Old.put(tenantId, "same-secret-value"),
      ]);
      const [bunNew, d1New] = [
        new EncryptedSecretStore(bunRepositories.secretRecords, newKeyring),
        new EncryptedSecretStore(cloudflareRepositories.secretRecords, newKeyring),
      ];
      const [bunRotation, d1Rotation] = await Promise.all([
        bunNew.rotatePage({ limit: 10 }),
        d1New.rotatePage({ limit: 10 }),
      ]);
      expect(d1Rotation).toEqual(bunRotation);
      expect(await Promise.all([bunNew.resolve(tenantId, bunReference), d1New.resolve(tenantId, d1Reference)])).toEqual(
        ["same-secret-value", "same-secret-value"],
      );
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("Telegram Mini App owner provisioning and initData replay protection agree", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const input = {
      telegramUserId: 712345678,
      ownerId: "usr_telegram-parity" as UserId,
      tenantId: "ten_telegram-parity" as TenantId,
      workspaceName: "Telegram parity workspace",
      now: createdAt,
    };
    try {
      const [bunAccount, cloudflareAccount] = await Promise.all([
        bunRepositories.telegramAuth.getOrCreateOwner(input),
        cloudflareRepositories.telegramAuth.getOrCreateOwner(input),
      ]);
      expect(cloudflareAccount).toEqual(bunAccount);
      const nonce = { dataHash: "d".repeat(64), expiresAt: "2026-10-30T00:05:00.000Z", now: createdAt };
      const [bunFirst, cloudflareFirst] = await Promise.all([
        bunRepositories.telegramAuth.claimInitData(nonce),
        cloudflareRepositories.telegramAuth.claimInitData(nonce),
      ]);
      const [bunReplay, cloudflareReplay] = await Promise.all([
        bunRepositories.telegramAuth.claimInitData(nonce),
        cloudflareRepositories.telegramAuth.claimInitData(nonce),
      ]);
      expect([bunFirst, bunReplay]).toEqual([true, false]);
      expect([cloudflareFirst, cloudflareReplay]).toEqual([true, false]);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("account-wide API rate-limit decisions agree", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const request = { tenantId, ownerId, limitPerMinute: 2 };
      const results: boolean[][] = [];
      for (const now of [createdAt, createdAt, createdAt, "2026-10-30T00:01:00.000Z"]) {
        const [bunAllowed, cloudflareAllowed] = await Promise.all([
          bunRepositories.apiTokens.consumeApiRequest({ ...request, now }),
          cloudflareRepositories.apiTokens.consumeApiRequest({ ...request, now }),
        ]);
        results.push([bunAllowed, cloudflareAllowed]);
      }
      expect(results).toEqual([
        [true, true],
        [true, true],
        [false, false],
        [true, true],
      ]);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("owner-scoped API audit events agree", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const event = {
      tenantId,
      ownerId,
      tokenId: "token-audit-parity",
      method: "PATCH",
      pathname: "/v1/bots/bot_parity",
      createdAt,
    };
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      for (const db of [bunDatabase, cloudflareDatabase]) {
        db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'parity-test', ?, ?)").run(
          memberId,
          memberId,
          createdAt,
        );
        db.query(
          "INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
        ).run(tenantId, memberId, createdAt);
      }
      const [bunBotId, cloudflareBotId] = await Promise.all([
        bunRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "audit-parity-bot",
          answers: creationAnswers(),
        }),
        cloudflareRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "audit-parity-bot",
          answers: creationAnswers(),
        }),
      ]);
      await Promise.all([
        bunRepositories.apiTokens.recordApiMutation(event),
        cloudflareRepositories.apiTokens.recordApiMutation(event),
        bunRepositories.recordApiAuthorizationDenial({
          ...event,
          ownerId: memberId,
          method: "GET",
          pathname: "/v1/members",
          denialType: "scope",
          errorCode: "FORBIDDEN",
          requiredScope: "members:manage",
          createdAt: "2026-10-30T00:00:02.000Z",
        }),
        cloudflareRepositories.recordApiAuthorizationDenial({
          ...event,
          ownerId: memberId,
          method: "GET",
          pathname: "/v1/members",
          denialType: "scope",
          errorCode: "FORBIDDEN",
          requiredScope: "members:manage",
          createdAt: "2026-10-30T00:00:02.000Z",
        }),
        bunRepositories.recordApiAuthorizationDenial({
          ...event,
          ownerId: memberId,
          method: "GET",
          pathname: "/v1/bots/bot_private",
          denialType: "resource",
          errorCode: "NOT_FOUND",
          createdAt: "2026-10-30T00:00:03.000Z",
        }),
        cloudflareRepositories.recordApiAuthorizationDenial({
          ...event,
          ownerId: memberId,
          method: "GET",
          pathname: "/v1/bots/bot_private",
          denialType: "resource",
          errorCode: "NOT_FOUND",
          createdAt: "2026-10-30T00:00:03.000Z",
        }),
        bunRepositories.recordPermissionDecision({
          tenantId,
          botId: bunBotId,
          category: "skill",
          permission: "skill:weather.lookup",
          outcome: "denied",
          createdAt: "2026-10-30T00:00:01.000Z",
        }),
        cloudflareRepositories.recordPermissionDecision({
          tenantId,
          botId: cloudflareBotId,
          category: "skill",
          permission: "skill:weather.lookup",
          outcome: "denied",
          createdAt: "2026-10-30T00:00:01.000Z",
        }),
      ]);
      const [bunLogs, cloudflareLogs] = await Promise.all([
        bunRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 }),
        cloudflareRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 }),
      ]);
      const project = (items: typeof bunLogs) =>
        items.map(({ action, resourceType, resourceId, metadata, createdAt: timestamp }) => ({
          action,
          resourceType,
          resourceId: resourceType === "bot" ? "bot-resource" : resourceId,
          metadata,
          createdAt: timestamp,
        }));
      expect(project(cloudflareLogs)).toEqual(project(bunLogs));
      expect(bunLogs.map((item) => item.action)).toEqual([
        "authorization.resource_denied",
        "authorization.scope_denied",
        "authorization.permission_decision",
        "api.mutation_attempt",
      ]);
      expect(bunLogs[1]).toMatchObject({
        resourceType: "http_api",
        resourceId: "GET /v1/members",
        metadata: {
          tokenId: "token-audit-parity",
          method: "GET",
          requiredScope: "members:manage",
          errorCode: "FORBIDDEN",
          outcome: "denied",
        },
      });
      expect(bunLogs[0]).toMatchObject({
        resourceType: "http_api",
        resourceId: "GET /v1/bots/bot_private",
        metadata: { errorCode: "NOT_FOUND", outcome: "denied" },
      });
      expect(bunLogs[2]?.resourceId).toBe(bunBotId);
      expect(bunLogs[3]?.resourceId).toBe("PATCH /v1/bots/bot_parity");
      expect(cloudflareLogs[2]?.resourceId).toBe(cloudflareBotId);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("one-use workspace invitations produce the same Bun and D1 memberships", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const invitation = {
      tenantId,
      actorId: ownerId,
      invitationId: "invite_runtime_parity",
      tokenHash: "e".repeat(64),
      role: "member" as const,
      createdAt,
      expiresAt: "2026-11-06T00:00:00.000Z",
    };
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      for (const db of [bunDatabase, cloudflareDatabase]) {
        db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'parity-test', ?, ?)").run(
          memberId,
          memberId,
          createdAt,
        );
      }
      const [bunInvitation, d1Invitation] = await Promise.all([
        bunRepositories.tenantMembers.createInvitation(invitation),
        cloudflareRepositories.tenantMembers.createInvitation(invitation),
      ]);
      expect(bunInvitation).toEqual(d1Invitation);
      const [bunAccepted, d1Accepted] = await Promise.all([
        bunRepositories.tenantMembers.acceptInvitation({
          tokenHash: invitation.tokenHash,
          userId: memberId,
          now: "2026-10-30T00:01:00.000Z",
        }),
        cloudflareRepositories.tenantMembers.acceptInvitation({
          tokenHash: invitation.tokenHash,
          userId: memberId,
          now: "2026-10-30T00:01:00.000Z",
        }),
      ]);
      expect(bunAccepted).toEqual(d1Accepted);
      const [bunWorkspaces, d1Workspaces] = await Promise.all([
        bunRepositories.tenantMembers.listWorkspacesForUser(memberId),
        cloudflareRepositories.tenantMembers.listWorkspacesForUser(memberId),
      ]);
      expect(bunWorkspaces).toEqual(d1Workspaces);
      expect(bunWorkspaces).toContainEqual({
        tenantId,
        name: "Parity test",
        role: "member",
        createdAt: "2026-10-30T00:01:00.000Z",
      });
      const [bunAcceptedInvitation, d1AcceptedInvitation] = await Promise.all([
        bunRepositories.tenantMembers.listInvitations({
          tenantId,
          actorId: ownerId,
          now: "2026-10-30T00:01:00.000Z",
        }),
        cloudflareRepositories.tenantMembers.listInvitations({
          tenantId,
          actorId: ownerId,
          now: "2026-10-30T00:01:00.000Z",
        }),
      ]);
      expect(bunAcceptedInvitation).toEqual(d1AcceptedInvitation);
      expect(bunAcceptedInvitation[0]?.status).toBe("accepted");
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("creation approval issuance and outcomes are audited consistently", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const session: CreationSession = {
      id: "factory_approval_parity",
      tenantId,
      ownerId,
      status: "in_progress",
      currentStep: "name",
      answers: {},
      revision: 1,
      createdAt,
      updatedAt: createdAt,
    };
    const approval = {
      approvalHash: "a".repeat(64),
      tenantId,
      ownerId,
      sessionId: session.id,
      action: "publish_bot" as const,
      createdAt,
      expiresAt: "2026-10-30T00:10:00.000Z",
    };
    const consume = {
      approvalHash: approval.approvalHash,
      tenantId,
      ownerId,
      sessionId: session.id,
      action: approval.action,
      now: "2026-10-30T00:01:00.000Z",
    };
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      await Promise.all([bunRepositories.sessions.create(session), cloudflareRepositories.sessions.create(session)]);
      await Promise.all([
        bunRepositories.creationApprovals.create(approval),
        cloudflareRepositories.creationApprovals.create(approval),
      ]);
      const outcomes = await Promise.all([
        bunRepositories.creationApprovals.consume({ ...consume, sessionId: "factory_wrong_session" }),
        cloudflareRepositories.creationApprovals.consume({ ...consume, sessionId: "factory_wrong_session" }),
      ]);
      expect(outcomes).toEqual([false, false]);
      const validOutcomes = await Promise.all([
        bunRepositories.creationApprovals.consume(consume),
        cloudflareRepositories.creationApprovals.consume(consume),
      ]);
      expect(validOutcomes).toEqual([true, true]);
      const replayOutcomes = await Promise.all([
        bunRepositories.creationApprovals.consume(consume),
        cloudflareRepositories.creationApprovals.consume(consume),
      ]);
      expect(replayOutcomes).toEqual([false, false]);
      const [bunLogs, cloudflareLogs] = await Promise.all([
        bunRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 }),
        cloudflareRepositories.listOwnedAuditLogs({ tenantId, ownerId, limit: 10 }),
      ]);
      const project = (items: typeof bunLogs) =>
        items
          .map(({ action, resourceType, resourceId, metadata }) => ({
            action,
            resourceType,
            resourceId,
            metadata,
          }))
          .sort((left, right) =>
            `${left.action}:${left.resourceId}`.localeCompare(`${right.action}:${right.resourceId}`),
          );
      expect(project(cloudflareLogs)).toEqual(project(bunLogs));
      expect(bunLogs.map((event) => event.action).sort()).toEqual(
        [
          "creation.approval_issued",
          "creation.approval_rejected",
          "creation.approval_consumed",
          "creation.approval_rejected",
        ].sort(),
      );
      expect(JSON.stringify(bunLogs)).not.toContain(approval.approvalHash);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("bot lifecycle, model execution, skills, MCP permissions, conversation memory, and scheduled jobs agree", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      seedHttpSkill(bunDatabase);
      seedHttpSkill(cloudflareDatabase);

      const bunResult = await runParityScenario(bunRepositories);
      const cloudflareResult = await runParityScenario(cloudflareRepositories);
      expect(cloudflareResult).toEqual(bunResult);
      expect(bunResult.factoryModelSelection).toEqual({
        imageModel: "gpt-image-1",
        searchModel: "provider-search-v2",
      });
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("owners can recover failed scheduled jobs identically in Bun and D1", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const recover = async (repositories: BunSqliteRepositories | CloudflareD1Repositories, suffix: string) => {
        const botId = await repositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: `retry-scheduled-${suffix}`,
          answers: creationAnswers(),
        });
        await repositories.publish({
          tenantId,
          ownerId,
          botId,
          idempotencyKey: `retry-scheduled-publish-${suffix}`,
        });
        const taskId = `task_${"e".repeat(32)}` as ScheduledTaskId;
        const jobId = `job_${"f".repeat(32)}` as JobId;
        const runAt = "2026-10-31T09:00:00.000Z";
        await repositories.createScheduledTask({
          task: {
            id: taskId,
            tenantId,
            botId,
            ownerId,
            schedule: `once:${runAt}`,
            timezone: "UTC",
            prompt: "Prepare the daily report.",
            notifyTelegramUserId: 54321,
            status: "active",
            nextRunAt: runAt,
            createdAt,
            updatedAt: createdAt,
          },
          firstJobId: jobId,
          idempotencyKey: `${taskId}:${runAt}`,
        });
        const claimed = await repositories.claimScheduledJob({
          jobId,
          now: runAt,
          leaseUntil: "2026-10-31T09:10:00.000Z",
        });
        if (!claimed) throw new Error("Scheduled job could not be claimed.");
        await repositories.failScheduledJob({ jobId, now: "2026-10-31T09:01:00.000Z" });
        await repositories.setScheduledTaskStatus({
          tenantId,
          ownerId,
          taskId,
          status: "failed",
          now: "2026-10-31T09:01:00.000Z",
        });
        const retriedJobId = await repositories.retryFailedScheduledTask({
          tenantId,
          ownerId,
          taskId,
          now: "2026-10-31T09:02:00.000Z",
        });
        const task = await repositories.getScheduledTask({ tenantId, taskId });
        const job = await repositories.getScheduledJob({ jobId });
        return {
          retriedJobId,
          task: task ? { status: task.status, nextRunAt: task.nextRunAt } : undefined,
          job: job
            ? {
                status: job.status,
                attempts: job.attempts,
                availableAt: job.availableAt,
                taskId: job.taskId,
              }
            : undefined,
        };
      };
      const bun = await recover(bunRepositories, "bun");
      const d1 = await recover(cloudflareRepositories, "d1");
      expect(d1).toEqual(bun);
      expect(bun).toMatchObject({
        retriedJobId: `job_${"f".repeat(32)}`,
        task: { status: "active", nextRunAt: "2026-10-31T09:02:00.000Z" },
        job: { status: "queued", attempts: 0, availableAt: "2026-10-31T09:02:00.000Z" },
      });
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });

  test("tool results replay once from encrypted storage with identical Bun and D1 behavior", async () => {
    const bunDatabase = openSqliteDatabase(":memory:");
    const cloudflareDatabase = openSqliteDatabase(":memory:");
    const bunRepositories = new BunSqliteRepositories(bunDatabase);
    const cloudflareRepositories = new CloudflareD1Repositories(
      new SqliteD1(cloudflareDatabase) as unknown as D1Database,
    );
    const keyMaterial = new Uint8Array(32).fill(43);
    const keyring = {
      activeKey: async () => ({ id: "tool-result-key", material: keyMaterial }),
      getKey: async (id: string) => (id === "tool-result-key" ? keyMaterial : undefined),
    };
    const now = new Date("2026-10-30T12:00:00.000Z");
    const resultUrl = "https://images.example.test/generated.png";
    try {
      seedTenant(bunDatabase);
      seedTenant(cloudflareDatabase);
      const [bunBotId, cloudflareBotId] = await Promise.all([
        bunRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "durable-tool-bun",
          answers: creationAnswers(),
        }),
        cloudflareRepositories.createDraft({
          tenantId,
          ownerId,
          idempotencyKey: "durable-tool-cloudflare",
          answers: creationAnswers(),
        }),
      ]);
      const bunSecrets = new EncryptedSecretStore(bunRepositories.secretRecords, keyring);
      const cloudflareSecrets = new EncryptedSecretStore(cloudflareRepositories.secretRecords, keyring);
      const bunRuns = { count: 0 };
      const cloudflareRuns = { count: 0 };
      const makeRegistry = (runs: { count: number }) =>
        new DurableToolRegistry({
          registry: {
            available: async () => [],
            execute: async (_context, _name, input) => {
              runs.count += 1;
              return withToolAttachments({ result: "durable-tool-result", input }, [{ kind: "image", url: resultUrl }]);
            },
          },
          executions: bunRuns === runs ? bunRepositories.toolExecutions : cloudflareRepositories.toolExecutions,
          secrets: bunRuns === runs ? bunSecrets : cloudflareSecrets,
          secretWriter: bunRuns === runs ? bunSecrets : cloudflareSecrets,
          now: () => new Date(now),
        });
      const bunTools = makeRegistry(bunRuns);
      const cloudflareTools = makeRegistry(cloudflareRuns);
      const input = { city: "Oslo", units: "metric" };
      const key = "f".repeat(64);
      const bunContext: ToolContext = { tenantId, botId: bunBotId, actorId: ownerId, executionKey: key };
      const cloudflareContext: ToolContext = {
        tenantId,
        botId: cloudflareBotId,
        actorId: ownerId,
        executionKey: key,
      };
      const [bunFirst, cloudflareFirst] = await Promise.all([
        bunTools.execute(bunContext, "lookup", input),
        cloudflareTools.execute(cloudflareContext, "lookup", input),
      ]);
      const [bunReplay, cloudflareReplay] = await Promise.all([
        bunTools.execute(bunContext, "lookup", { units: "metric", city: "Oslo" }),
        cloudflareTools.execute(cloudflareContext, "lookup", { units: "metric", city: "Oslo" }),
      ]);

      expect(bunReplay).toEqual(bunFirst);
      expect(cloudflareReplay).toEqual(cloudflareFirst);
      expect(cloudflareReplay).toEqual(bunReplay);
      expect(getToolAttachments(bunReplay)).toEqual([{ kind: "image", url: resultUrl }]);
      expect(getToolAttachments(cloudflareReplay)).toEqual(getToolAttachments(bunReplay));
      expect(bunRuns.count).toBe(1);
      expect(cloudflareRuns.count).toBe(1);
      await expect(bunTools.execute(bunContext, "lookup", { city: "Bergen" })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(cloudflareTools.execute(cloudflareContext, "lookup", { city: "Bergen" })).rejects.toMatchObject({
        code: "CONFLICT",
      });

      const runBusyCheck = async (
        repositories: BunSqliteRepositories | CloudflareD1Repositories,
        secrets: EncryptedSecretStore,
        context: ToolContext,
        busyRuns: { count: number },
      ) => {
        let markStarted: (() => void) | undefined;
        let unblock: (() => void) | undefined;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const blocked = new Promise<void>((resolve) => {
          unblock = resolve;
        });
        const gatedTools = new DurableToolRegistry({
          registry: {
            available: async () => [],
            execute: async () => {
              busyRuns.count += 1;
              markStarted?.();
              await blocked;
              return { completed: true };
            },
          },
          executions: repositories.toolExecutions,
          secrets,
          secretWriter: secrets,
          now: () => new Date(now),
        });
        const busyContext = { ...context, executionKey: "a".repeat(64) };
        const running = gatedTools.execute(busyContext, "slow_tool", { task: "one" });
        await started;
        await expect(gatedTools.execute(busyContext, "slow_tool", { task: "one" })).rejects.toMatchObject({
          code: "DEPENDENCY_UNAVAILABLE",
        });
        unblock?.();
        await running;
      };
      const [bunBusyRuns, cloudflareBusyRuns] = [{ count: 0 }, { count: 0 }];
      await Promise.all([
        runBusyCheck(bunRepositories, bunSecrets, bunContext, bunBusyRuns),
        runBusyCheck(cloudflareRepositories, cloudflareSecrets, cloudflareContext, cloudflareBusyRuns),
      ]);
      expect(bunBusyRuns.count).toBe(1);
      expect(cloudflareBusyRuns.count).toBe(1);

      const checkFailedExecutionRecovery = async (
        repositories: BunSqliteRepositories | CloudflareD1Repositories,
        secrets: EncryptedSecretStore,
        context: ToolContext,
      ) => {
        const runs = { count: 0 };
        const recoveryContext = { ...context, executionKey: "d".repeat(64) };
        const recoverable = new DurableToolRegistry({
          registry: {
            available: async () => [],
            execute: async () => {
              runs.count += 1;
              if (runs.count === 1) throw new Error("The remote result was lost.");
              return { completed: true };
            },
          },
          executions: repositories.toolExecutions,
          secrets,
          secretWriter: secrets,
          now: () => new Date(now),
        });
        await expect(recoverable.execute(recoveryContext, "remote_action", { action: "send" })).rejects.toThrow(
          "The remote result was lost.",
        );
        await expect(recoverable.execute(recoveryContext, "remote_action", { action: "send" })).rejects.toMatchObject({
          code: "CONFLICT",
          status: 409,
        });
        expect(runs.count).toBe(1);
        const [pending] = await repositories.toolExecutions.listOwnedRecoveries({
          tenantId,
          ownerId,
          botId: context.botId,
          now: now.toISOString(),
          limit: 100,
        });
        expect(pending).toMatchObject({ toolName: "remote_action", status: "ambiguous" });
        expect(
          await repositories.toolExecutions.resolveOwnedRecovery({
            tenantId,
            ownerId,
            botId: context.botId,
            executionKey: recoveryContext.executionKey ?? "",
            resolution: "retry",
            now: now.toISOString(),
          }),
        ).toBe("retry_approved");
        const retried = await recoverable.execute(recoveryContext, "remote_action", { action: "send" });
        expect(retried).toEqual({ completed: true });
        expect(runs.count).toBe(2);
        expect(await recoverable.execute(recoveryContext, "remote_action", { action: "send" })).toEqual(retried);
        expect(runs.count).toBe(2);
      };
      await Promise.all([
        checkFailedExecutionRecovery(bunRepositories, bunSecrets, bunContext),
        checkFailedExecutionRecovery(cloudflareRepositories, cloudflareSecrets, cloudflareContext),
      ]);

      const checkLeaseRecovery = async (
        repositories: BunSqliteRepositories | CloudflareD1Repositories,
        database: Database,
        botId: ToolContext["botId"],
      ) => {
        const key = "b".repeat(64);
        const base = {
          tenantId,
          botId,
          executionKey: key,
          toolName: "recover_tool",
          inputHash: "c".repeat(64),
          expiresAt: "2026-10-30T12:10:00.000Z",
        };
        const firstLease = await repositories.toolExecutions.acquire({
          ...base,
          leaseToken: "expired-lease",
          now: "2026-10-30T12:00:00.000Z",
          leaseUntil: "2026-10-30T12:00:01.000Z",
        });
        expect(firstLease.state).toBe("acquired");
        const ambiguous = await repositories.toolExecutions.acquire({
          ...base,
          leaseToken: "recovered-lease",
          now: "2026-10-30T12:00:02.000Z",
          leaseUntil: "2026-10-30T12:02:32.000Z",
        });
        expect(ambiguous).toEqual({ state: "ambiguous" });
        expect(
          await repositories.toolExecutions.listOwnedRecoveries({
            tenantId,
            ownerId: memberId,
            botId,
            now: "2026-10-30T12:00:02.000Z",
            limit: 100,
          }),
        ).toEqual([]);
        expect(
          await repositories.toolExecutions.resolveOwnedRecovery({
            tenantId,
            ownerId: memberId,
            botId,
            executionKey: key,
            resolution: "retry",
            now: "2026-10-30T12:00:02.000Z",
          }),
        ).toBeUndefined();
        expect(
          await repositories.toolExecutions.listOwnedRecoveries({
            tenantId,
            ownerId,
            botId,
            now: "2026-10-30T12:00:02.000Z",
            limit: 100,
          }),
        ).toMatchObject([{ executionKey: key, status: "ambiguous", toolName: "recover_tool" }]);
        expect(
          await repositories.toolExecutions.resolveOwnedRecovery({
            tenantId,
            ownerId,
            botId,
            executionKey: key,
            resolution: "retry",
            now: "2026-10-30T12:00:02.000Z",
          }),
        ).toBe("retry_approved");
        expect(
          await repositories.toolExecutions.listOwnedRecoveries({
            tenantId,
            ownerId,
            botId,
            now: "2026-10-30T12:00:02.000Z",
            limit: 100,
          }),
        ).toMatchObject([{ executionKey: key, status: "retry_approved" }]);
        const recoveredLease = await repositories.toolExecutions.acquire({
          ...base,
          leaseToken: "recovered-lease",
          now: "2026-10-30T12:00:03.000Z",
          leaseUntil: "2026-10-30T12:02:33.000Z",
        });
        expect(recoveredLease).toEqual({ state: "acquired", leaseToken: "recovered-lease" });
        expect(
          await repositories.toolExecutions.complete({
            tenantId,
            botId,
            executionKey: key,
            leaseToken: "expired-lease",
            resultRef: "unused-stale-result",
            now: "2026-10-30T12:00:03.000Z",
            expiresAt: base.expiresAt,
          }),
        ).toBe(false);

        const closeKey = "e".repeat(64);
        const closeInput = { ...base, executionKey: closeKey };
        expect(
          await repositories.toolExecutions.acquire({
            ...closeInput,
            leaseToken: "close-lease",
            now: "2026-10-30T12:00:00.000Z",
            leaseUntil: "2026-10-30T12:00:01.000Z",
          }),
        ).toMatchObject({ state: "acquired" });
        expect(
          await repositories.toolExecutions.acquire({
            ...closeInput,
            leaseToken: "close-expired",
            now: "2026-10-30T12:00:02.000Z",
            leaseUntil: "2026-10-30T12:02:32.000Z",
          }),
        ).toEqual({ state: "ambiguous" });
        expect(
          await repositories.toolExecutions.resolveOwnedRecovery({
            tenantId,
            ownerId,
            botId,
            executionKey: closeKey,
            resolution: "close",
            now: "2026-10-30T12:00:02.000Z",
          }),
        ).toBe("closed");
        expect(
          await repositories.toolExecutions.acquire({
            ...closeInput,
            leaseToken: "closed-retry",
            now: "2026-10-30T12:00:03.000Z",
            leaseUntil: "2026-10-30T12:02:33.000Z",
          }),
        ).toEqual({ state: "closed" });
        const auditEvents = database
          .query<{ action: string; metadata_json: string }, [string]>(`
            SELECT action, metadata_json FROM audit_logs
            WHERE tenant_id = ? AND resource_type = 'tool_execution' ORDER BY action
          `)
          .all(tenantId);
        expect(auditEvents.map(({ action }) => action)).toEqual([
          "tool.execution_closed",
          "tool.execution_retry_approved",
          "tool.execution_retry_approved",
        ]);
        for (const event of auditEvents) {
          const metadata: unknown = JSON.parse(event.metadata_json);
          expect(metadata).toHaveProperty("toolName");
          expect(metadata).not.toHaveProperty("input");
          expect(metadata).not.toHaveProperty("result");
          expect(metadata).not.toHaveProperty("inputHash");
        }
      };
      await Promise.all([
        checkLeaseRecovery(bunRepositories, bunDatabase, bunBotId),
        checkLeaseRecovery(cloudflareRepositories, cloudflareDatabase, cloudflareBotId),
      ]);

      const bunCiphertext = bunDatabase
        .query<{ ciphertext: string }, [string]>("SELECT ciphertext FROM encrypted_secrets WHERE tenant_id = ?")
        .get(tenantId);
      const cloudflareCiphertext = cloudflareDatabase
        .query<{ ciphertext: string }, [string]>("SELECT ciphertext FROM encrypted_secrets WHERE tenant_id = ?")
        .get(tenantId);
      expect(bunCiphertext?.ciphertext).not.toContain("durable-tool-result");
      expect(cloudflareCiphertext?.ciphertext).not.toContain("durable-tool-result");

      const [bunExpiredRefs, cloudflareExpiredRefs] = await Promise.all([
        bunRepositories.toolExecutions.purgeExpired(tenantId, "2026-11-07T12:00:00.000Z", 10),
        cloudflareRepositories.toolExecutions.purgeExpired(tenantId, "2026-11-07T12:00:00.000Z", 10),
      ]);
      expect(bunExpiredRefs).toHaveLength(3);
      expect(cloudflareExpiredRefs).toHaveLength(3);
      await Promise.all([
        ...bunExpiredRefs.map((reference) => bunSecrets.delete(tenantId, reference)),
        ...cloudflareExpiredRefs.map((reference) => cloudflareSecrets.delete(tenantId, reference)),
      ]);
      expect(
        await Promise.all(bunExpiredRefs.map((reference) => bunRepositories.secretRecords.get(tenantId, reference))),
      ).toEqual([undefined, undefined, undefined]);
      expect(
        await Promise.all(
          cloudflareExpiredRefs.map((reference) => cloudflareRepositories.secretRecords.get(tenantId, reference)),
        ),
      ).toEqual([undefined, undefined, undefined]);
    } finally {
      bunDatabase.close();
      cloudflareDatabase.close();
    }
  });
});

async function runParityScenario(repositories: BunSqliteRepositories | CloudflareD1Repositories) {
  const memoryKey = new Uint8Array(32).fill(29);
  const memoryService = createEncryptedMemoryService(
    repositories,
    new EncryptedSecretStore(repositories.secretRecords, {
      activeKey: async () => ({ id: "parity-memory-key", material: memoryKey }),
      getKey: async (id) => (id === "parity-memory-key" ? memoryKey : undefined),
    }),
  );
  const botId = await repositories.createDraft({
    tenantId,
    ownerId,
    idempotencyKey: "runtime-parity-draft",
    answers: creationAnswers(),
  });
  const draftBot = await repositories.get(tenantId, botId);
  if (!draftBot) throw new Error("Factory draft could not be loaded after creation.");
  const factoryModelSelection = {
    imageModel: draftBot.model.imageModel,
    searchModel: draftBot.model.searchModel,
  };
  await repositories.publish({ tenantId, ownerId, botId, idempotencyKey: "runtime-parity-publish" });
  await repositories.updateOwned({
    tenantId,
    ownerId,
    botId,
    expectedVersion: 1,
    patch: {
      name: "Parity weather assistant",
      description: "Answers weather questions.",
      systemPrompt: "Use the configured weather service and explain results clearly.",
      model: {
        providerId: "openai-compatible",
        model: "gpt-4o-mini",
        endpoint: "https://api.example.test/v1",
        credentialRef: modelSecret,
        parameters: { temperature: 0.2 },
      },
    },
  });
  const botVersions = await repositories.listVersions({ tenantId, ownerId, botId, limit: 50 });
  if (botVersions.length !== 2 || !botVersions[0]?.current || botVersions[1]?.current) {
    throw new Error("Bot version history differs between persistence runtimes.");
  }
  if (JSON.stringify(botVersions).includes(modelSecret)) {
    throw new Error("Bot version history leaked a credential reference.");
  }
  const bot = await repositories.get(tenantId, botId);
  if (!bot) throw new Error("Published bot could not be loaded.");
  await memoryService.putOwnedBotMemory({
    tenantId,
    ownerId,
    botId,
    key: "tea_preference",
    value: "prefers jasmine tea",
    now: createdAt,
  });

  await repositories.skills.install({
    tenantId,
    botId,
    skillId: "weather.lookup",
    installedBy: ownerId,
    configuration: {},
    grantedPermissions: ["weather:read"],
  });

  const httpCalls: unknown[] = [];
  const mcpCalls: string[] = [];
  const modelRequests: Record<string, unknown>[] = [];
  const mcpManager = new McpManager({
    repository: repositories.mcp,
    secrets: { resolve: async () => "mcp-test-secret" },
    allowedOrigins: new Set(["https://mcp.example.test"]),
    fetch: async (input, init) => mockMcpResponse(input, init, mcpCalls),
  });
  await mcpManager.addServer({
    id: "mcp_parity_server",
    tenantId,
    botId,
    name: "Parity MCP server",
    endpoint: mcpEndpoint,
    installedBy: ownerId,
  });
  const discovered = await mcpManager.connect(tenantId, botId, "mcp_parity_server");
  await mcpManager.setToolPermission({
    tenantId,
    botId,
    serverId: "mcp_parity_server",
    toolName: "lookup",
    enabled: true,
    grantedPermissions: [MCP_INVOKE_PERMISSION],
  });
  const mcpTools = await mcpManager.available({ tenantId, botId, actorId: ownerId });
  const mcpResult = await mcpManager.execute({ tenantId, botId, actorId: ownerId }, mcpTools[0]?.name ?? "missing", {
    key: "item-1",
  });

  const skillEngine = new SkillEngine({
    skills: repositories.skills,
    rateLimiter: repositories.skillRateLimiter,
    secrets: { resolve: async () => "skill-test-secret" },
    allowedHttpOrigins: new Set(["https://weather.example.test"]),
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      httpCalls.push(await request.json());
      return Response.json({ forecast: "sunny" });
    },
  });
  const secrets = {
    resolve: async (_tenant: TenantId, reference: string) => {
      if (reference !== modelSecret) throw new Error("Unexpected secret reference.");
      return "model-test-secret";
    },
  };
  const providers = new ModelProviderRegistry();
  providers.register(
    new OpenAICompatibleProvider({
      id: "openai-compatible",
      defaultEndpoint: "https://api.example.test/v1",
      secrets,
      allowedOrigins: new Set(["https://api.example.test"]),
      toolCalling: true,
      fetch: async (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body = (await request.json()) as Record<string, unknown>;
        modelRequests.push(body);
        const messages = body.messages as readonly { role: string; content?: unknown }[];
        const round = modelRequests.length;
        if (round === 1) {
          const modelTools = body.tools as readonly { function: { name: string } }[];
          const toolName = modelTools[0]?.function.name;
          if (!toolName) throw new Error("HTTP skill was not registered with the model.");
          return Response.json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    { id: "call-weather", function: { name: toolName, arguments: JSON.stringify({ city: "Oslo" }) } },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          });
        }
        if (round === 2) {
          return Response.json({
            choices: [{ message: { role: "assistant", content: "Oslo is sunny." } }],
            usage: { prompt_tokens: 6, completion_tokens: 3 },
          });
        }
        if (!messages.some((message) => message.role === "assistant" && message.content === "Oslo is sunny.")) {
          throw new Error("Prior assistant turn was not loaded into conversation history.");
        }
        return Response.json({ choices: [{ message: { role: "assistant", content: "Yesterday was also sunny." } }] });
      },
    }),
  );
  const engine = createMemoryAwareAgentEngine(
    new AgentOrchestrator({ providers, tools: skillEngine, conversations: repositories }),
    memoryService,
    { info: () => {}, warn: () => {}, error: () => {} },
  );

  const conversationId = await repositories.getOrCreateApiConversation({
    tenantId,
    botId,
    actorId: ownerId,
    conversationKey: "runtime-parity-conversation",
  });
  const repeatedConversationId = await repositories.getOrCreateApiConversation({
    tenantId,
    botId,
    actorId: ownerId,
    conversationKey: "runtime-parity-conversation",
  });
  if (conversationId !== repeatedConversationId)
    throw new Error("Conversation key did not reuse its stored conversation.");

  const firstResponse = await engine.respond({
    bot,
    conversationId,
    actorId: ownerId,
    messages: [{ role: "user", content: "What is the weather in Oslo?" }],
  });
  const secondResponse = await engine.respond({
    bot,
    conversationId,
    actorId: ownerId,
    messages: [{ role: "user", content: "And yesterday?" }],
  });
  const storedConversation = await repositories.load(tenantId, conversationId, 100);
  const conversationSummaries = await repositories.listOwnedConversations({
    tenantId,
    ownerId,
    botId,
    limit: 25,
    offset: 0,
  });
  const conversationMessages = await repositories.getOwnedConversationMessages({
    tenantId,
    ownerId,
    botId,
    conversationId,
    limit: 100,
  });
  const systemPrompt = (modelRequests[0]?.messages as readonly { role: string; content?: unknown }[] | undefined)?.find(
    (message) => message.role === "system",
  )?.content;
  if (typeof systemPrompt !== "string" || !systemPrompt.includes("prefers jasmine tea")) {
    throw new Error("Owner memory was not added to the enabled bot's system context.");
  }
  await repositories.recordUsage({
    id: "usage_runtime_parity",
    tenantId,
    botId,
    actorId: ownerId,
    providerId: "openai-compatible",
    model: "gpt-4o-mini",
    inputTokens: 11,
    outputTokens: 5,
    usageReported: true,
    createdAt,
  });
  await repositories.recordModelRetry({
    id: "retry_runtime_parity",
    tenantId,
    botId,
    attempt: 1,
    maxAttempts: 2,
    delayMs: 250,
    statusCode: 503,
    createdAt,
  });
  const usageSummary = await repositories.getOwnedUsageSummary({
    tenantId,
    ownerId,
    from: "2026-10-30T00:00:00.000Z",
    through: "2026-10-30T23:59:59.999Z",
  });

  const taskId = `task_${"c".repeat(32)}` as ScheduledTaskId;
  const jobId = `job_${"d".repeat(32)}` as JobId;
  const runAt = "2026-10-31T09:00:00.000Z";
  await repositories.createScheduledTask({
    task: {
      id: taskId,
      tenantId,
      botId,
      ownerId,
      schedule: `once:${runAt}`,
      timezone: "Europe/Oslo",
      prompt: "Prepare a concise morning weather report.",
      notifyTelegramUserId: 54321,
      status: "active",
      nextRunAt: runAt,
      createdAt,
      updatedAt: createdAt,
    },
    firstJobId: jobId,
    idempotencyKey: `runtime-parity:${taskId}:${runAt}`,
  });
  const scheduledTask = await repositories.getScheduledTask({ tenantId, taskId });
  if (!scheduledTask) throw new Error("Scheduled task could not be loaded after creation.");
  const dueJobs = await repositories.listDueScheduledJobIds({ now: runAt, limit: 10 });

  let staleVersionCode = "none";
  try {
    await repositories.updateOwned({
      tenantId,
      ownerId,
      botId,
      expectedVersion: 1,
      patch: { name: "Stale update" },
    });
  } catch (error) {
    staleVersionCode = error instanceof AppError ? error.code : "unexpected_error";
  }

  return {
    factoryModelSelection,
    bot: {
      name: bot.name,
      description: bot.description,
      systemPrompt: bot.systemPrompt,
      status: bot.status,
      version: bot.version,
      providerId: bot.model.providerId,
      model: bot.model.model,
      endpoint: bot.model.endpoint,
      parameters: bot.model.parameters,
    },
    firstResponse: firstResponse.message.content,
    secondResponse: secondResponse.message.content,
    modelSystemPrompt: systemPrompt,
    registeredSkillNames: (
      (modelRequests[0]?.tools as readonly { function: { name: string } }[] | undefined) ?? []
    ).map((tool) => tool.function.name),
    httpCalls,
    conversation: storedConversation.map(({ role, content }) => ({ role, content })),
    conversationHistory: {
      summary: conversationSummaries.map(({ platform, messageCount, preview }) => ({
        platform,
        messageCount,
        preview,
      })),
      messages: conversationMessages?.items.map(({ sequence, role, content }) => ({ sequence, role, content })),
      hasMore: conversationMessages?.hasMore,
    },
    usageSummary: {
      ...usageSummary,
      byBot: usageSummary.byBot.map(({ botName, requests, reportedRequests, inputTokens, outputTokens }) => ({
        botName,
        requests,
        reportedRequests,
        inputTokens,
        outputTokens,
      })),
      modelRetries: {
        ...usageSummary.modelRetries,
        byBot: usageSummary.modelRetries.byBot.map(({ botName, retries }) => ({ botName, retries })),
      },
    },
    mcp: {
      discovered: discovered.map(({ name }) => name),
      available: mcpTools.map(({ name }) => name),
      result: mcpResult,
      calls: mcpCalls,
    },
    scheduledTask: {
      schedule: scheduledTask.schedule,
      timezone: scheduledTask.timezone,
      prompt: scheduledTask.prompt,
      recipient: scheduledTask.notifyTelegramUserId,
      status: scheduledTask.status,
    },
    dueJobs,
    staleVersionCode,
    crossTenantBotMissing: (await repositories.get("tenant-other" as TenantId, botId)) === undefined,
  };
}

function seedTenant(db: Database): void {
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)").run(tenantId, "Parity test", createdAt);
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, ?, ?, ?)").run(
    ownerId,
    "parity-test",
    ownerId,
    createdAt,
  );
  db.query("INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)").run(
    tenantId,
    ownerId,
    createdAt,
  );
}

function seedHttpSkill(db: Database): void {
  db.query(`
    INSERT INTO skills (
      id, tenant_id, name, version, author, category, description, execution_type,
      input_schema_json, output_schema_json, permissions_json, definition_json, enabled, created_at
    ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'http', ?, ?, ?, ?, 1, ?)
  `).run(
    "weather.lookup",
    "Weather lookup",
    "1.0.0",
    "AIHAT",
    "information",
    "Look up the current weather.",
    JSON.stringify({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    }),
    JSON.stringify({
      type: "object",
      properties: { forecast: { type: "string" } },
      required: ["forecast"],
      additionalProperties: false,
    }),
    JSON.stringify(["weather:read"]),
    JSON.stringify({
      configuration: { http: { endpoint: weatherEndpoint, method: "POST" } },
      timeoutMs: 1000,
      rateLimit: { maxRequests: 10, windowSeconds: 60 },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [503] },
    }),
    createdAt,
  );
}

function creationAnswers(): CreationAnswers {
  return {
    name: "Parity bot",
    description: "Runtime parity fixture.",
    purpose: "Verify supported behavior across runtimes.",
    audience: "Test suite",
    personality: "Clear and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.example.test/v1",
    model: "gpt-4o-mini",
    imageModel: "gpt-image-1",
    searchModel: "provider-search-v2",
    credentialRef: modelSecret,
    skills: ["weather.lookup"],
    mcpConnections: [],
    integrations: [],
    memoryEnabled: true,
    scheduledTasks: [],
    privacySettings: [],
    visibility: "private",
    interfaces: ["api"],
  };
}

async function mockMcpResponse(
  input: string | URL | Request,
  init: RequestInit | undefined,
  calls: string[],
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const message = (await request.json()) as { id?: string | number; method: string; params?: Record<string, unknown> };
  calls.push(message.method);
  if (message.id === undefined) return new Response(null, { status: 202 });
  let result: unknown;
  if (message.method === "initialize") {
    result = {
      protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "parity-mcp", version: "1" },
    };
  } else if (message.method === "tools/list") {
    result = {
      tools: [
        {
          name: "lookup",
          description: "Look up a saved item.",
          inputSchema: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
        },
      ],
    };
  } else if (message.method === "tools/call") {
    result = { content: [{ type: "text", text: "value: saved" }], structuredContent: { value: "saved" } };
  } else {
    return Response.json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
  return Response.json({ jsonrpc: "2.0", id: message.id, result });
}
