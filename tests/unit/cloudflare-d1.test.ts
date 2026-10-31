import { describe, expect, test } from "bun:test";
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { CloudflareD1Repositories } from "../../apps/cloudflare-runtime/src/d1-repositories.js";
import { createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { EncryptedSecretStore } from "../../packages/core/src/encrypted-secrets.js";
import { createSecretRotationApiHandler } from "../../packages/core/src/secret-rotation-http-api.js";
import type { EncryptedSecretRecord } from "../../packages/core/src/ports.js";
import type {
  BotId,
  ConversationId,
  CreationAnswers,
  CreationSession,
  JobId,
  ScheduledTask,
  ScheduledTaskId,
  TelegramDeploymentId,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant-cloudflare" as TenantId;
const userId = "user-cloudflare" as UserId;

describe("Cloudflare D1 repositories", () => {
  test("operator rotation endpoint previews by default, requires its bearer secret, and applies one page", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    const previousKey = new Uint8Array(32).fill(13);
    const activeKey = new Uint8Array(32).fill(29);
    const oldKeyring = {
      activeKey: async () => ({ id: "previous", material: previousKey }),
      getKey: async (id: string) => (id === "previous" ? previousKey : undefined),
    };
    const currentKeyring = {
      activeKey: async () => ({ id: "current", material: activeKey }),
      getKey: async (id: string) => (id === "previous" ? previousKey : id === "current" ? activeKey : undefined),
    };
    const reference = await new EncryptedSecretStore(repos.secretRecords, oldKeyring).put(tenantId, "rotation-value");
    const token = "operator-rotation-token-".padEnd(48, "x");
    const handler = createSecretRotationApiHandler({
      records: repos.secretRecords,
      keyring: currentKeyring,
      authorizationToken: token,
    });
    const endpoint = `https://factory.example.test${"/_operator/secrets/rotation"}`;
    try {
      const denied = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer invalid" },
          body: "{}",
        }),
      );
      expect(denied?.status).toBe(401);

      const preview = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: "{}",
        }),
      );
      expect(preview?.status).toBe(200);
      expect(await preview?.json()).toMatchObject({ mode: "dry_run", scanned: 1, needingRotation: 1, rotated: 0 });
      expect((await repos.secretRecords.get(tenantId, reference))?.keyId).toBe("previous");

      const applied = await handler(
        new Request(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ mode: "apply", limit: 10 }),
        }),
      );
      expect(applied?.status).toBe(200);
      expect(await applied?.json()).toMatchObject({ mode: "apply", scanned: 1, needingRotation: 1, rotated: 1 });
      expect((await repos.secretRecords.get(tenantId, reference))?.keyId).toBe("current");
      expect(await new EncryptedSecretStore(repos.secretRecords, currentKeyring).resolve(tenantId, reference)).toBe(
        "rotation-value",
      );
      expect(applied?.headers.get("cache-control")).toBe("no-store");
    } finally {
      db.close();
    }
  });

  test("leases workflow executions, compare-and-swaps checkpoints, and purges expired encrypted-state references", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    const now = "2026-10-30T12:00:00.000Z";
    try {
      const botId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "workflow-d1-bot",
        answers: creationAnswers(),
      });
      const references = ["a", "b", "c"].map((letter) => `secret_${letter.repeat(32)}`);
      for (const reference of references) {
        await repos.secretRecords.create({
          tenantId,
          reference,
          keyId: "test-key",
          nonce: "nonce",
          ciphertext: "ciphertext",
          version: 1,
          createdAt: now,
        });
      }
      const key = "e".repeat(64);
      const first = await repos.workflowExecutions.acquire({
        tenantId,
        botId,
        skillId: "workflow.example",
        executionKey: key,
        initialStateRef: references[0] as string,
        leaseToken: "lease-one",
        now,
        leaseUntil: "2026-10-30T12:00:10.000Z",
        expiresAt: "2026-10-30T12:01:00.000Z",
      });
      expect(first.state).toBe("acquired");
      if (first.state !== "acquired") throw new Error("Workflow lease was not acquired.");
      expect(first.execution.version).toBe(1);
      expect(
        await repos.workflowExecutions.checkpoint({
          tenantId,
          botId,
          skillId: "workflow.example",
          executionKey: key,
          leaseToken: "lease-one",
          expectedVersion: 1,
          stateRef: references[1] as string,
          nextStep: 1,
          now: "2026-10-30T12:00:01.000Z",
          leaseUntil: "2026-10-30T12:00:11.000Z",
          expiresAt: "2026-10-30T12:01:01.000Z",
        }),
      ).toBe(true);
      expect(
        await repos.workflowExecutions.checkpoint({
          tenantId,
          botId,
          skillId: "workflow.example",
          executionKey: key,
          leaseToken: "lease-one",
          expectedVersion: 1,
          stateRef: references[2] as string,
          nextStep: 2,
          now: "2026-10-30T12:00:02.000Z",
          leaseUntil: "2026-10-30T12:00:12.000Z",
          expiresAt: "2026-10-30T12:01:02.000Z",
        }),
      ).toBe(false);
      await repos.workflowExecutions.release({
        tenantId,
        botId,
        skillId: "workflow.example",
        executionKey: key,
        leaseToken: "lease-one",
        now: "2026-10-30T12:00:03.000Z",
      });
      const resumed = await repos.workflowExecutions.acquire({
        tenantId,
        botId,
        skillId: "workflow.example",
        executionKey: key,
        initialStateRef: references[2] as string,
        leaseToken: "lease-two",
        now: "2026-10-30T12:00:04.000Z",
        leaseUntil: "2026-10-30T12:00:14.000Z",
        expiresAt: "2026-10-30T12:01:04.000Z",
      });
      expect(resumed).toMatchObject({
        state: "acquired",
        execution: { stateRef: references[1], nextStep: 1, version: 3 },
      });
      expect(
        await repos.workflowExecutions.complete({
          tenantId,
          botId,
          skillId: "workflow.example",
          executionKey: key,
          leaseToken: "lease-two",
          expectedVersion: 3,
          stateRef: references[2] as string,
          nextStep: 2,
          now: "2026-10-30T12:00:05.000Z",
          expiresAt: "2026-10-30T12:00:30.000Z",
        }),
      ).toBe(true);
      expect(
        await repos.workflowExecutions.acquire({
          tenantId,
          botId,
          skillId: "workflow.example",
          executionKey: key,
          initialStateRef: references[0] as string,
          leaseToken: "lease-three",
          now: "2026-10-30T12:00:06.000Z",
          leaseUntil: "2026-10-30T12:00:16.000Z",
          expiresAt: "2026-10-30T12:00:31.000Z",
        }),
      ).toMatchObject({ state: "completed", execution: { stateRef: references[2], status: "succeeded" } });
      expect(await repos.workflowExecutions.purgeExpired(tenantId, "2026-10-31T00:00:00.000Z", 10)).toEqual([
        references[2] as string,
      ]);
    } finally {
      db.close();
    }
  });

  test("persists master-bot routing and replays a cached response exactly once", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    const now = "2026-10-30T12:00:00.000Z";
    try {
      const masterSession = {
        telegramUserId: 712345678,
        chatId: 712345678,
        tenantId,
        ownerId: userId,
        sessionId: `factory_${"a".repeat(36)}`,
        updatedAt: now,
      };
      await repos.masterBot.saveSession(masterSession);
      expect(await repos.masterBot.getSession(masterSession.telegramUserId)).toEqual(masterSession);

      const reservation = {
        updateId: 72,
        now,
        leaseUntil: "2026-10-30T12:02:00.000Z",
      };
      expect(await repos.masterBot.reserveUpdate(reservation)).toEqual({ state: "acquired" });
      const reply = { chat_id: masterSession.chatId, text: "Continue in the Mini App." };
      await repos.masterBot.saveUpdateReply({ ...reservation, reply });
      expect(await repos.masterBot.reserveUpdate(reservation)).toEqual({ state: "busy" });
      expect(await repos.masterBot.reserveUpdate({ ...reservation, now: "2026-10-30T12:03:00.000Z" })).toEqual({
        state: "ready",
        reply,
      });
      await repos.masterBot.completeUpdate({ updateId: 72, now: "2026-10-30T12:03:01.000Z" });
      expect(await repos.masterBot.reserveUpdate(reservation)).toEqual({ state: "completed" });
      await repos.masterBot.deleteSession(masterSession.telegramUserId);
      expect(await repos.masterBot.getSession(masterSession.telegramUserId)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("provisions one Telegram owner workspace and consumes initData only once", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    const input = {
      telegramUserId: 712345678,
      ownerId: "usr_telegram-auth-test" as UserId,
      tenantId: "ten_telegram-auth-test" as TenantId,
      workspaceName: "Taylor's workspace",
      now: "2026-10-30T12:00:00.000Z",
    };
    try {
      const account = await repos.telegramAuth.getOrCreateOwner(input);
      expect(await repos.telegramAuth.getOrCreateOwner(input)).toEqual(account);
      expect(account).toEqual({ ownerId: input.ownerId, tenantId: input.tenantId });
      expect(
        await repos.telegramAuth.claimInitData({
          dataHash: "c".repeat(64),
          expiresAt: "2026-10-30T12:05:00.000Z",
          now: input.now,
        }),
      ).toBe(true);
      expect(
        await repos.telegramAuth.claimInitData({
          dataHash: "c".repeat(64),
          expiresAt: "2026-10-30T12:05:00.000Z",
          now: input.now,
        }),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  test("enforces public quotas and single-use shared bot invitations", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    const inviteeId = `usr_${"c".repeat(32)}` as UserId;
    const inviteeTenantId = `ten_${"c".repeat(32)}` as TenantId;
    try {
      await repos.telegramAuth.getOrCreateOwner({
        telegramUserId: 712345679,
        ownerId: inviteeId,
        tenantId: inviteeTenantId,
        workspaceName: "Invitation test workspace",
        now: "2026-10-30T12:00:00.000Z",
      });

      const publicBotId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "public-access-d1-bot",
        answers: creationAnswers(),
      });
      await repos.publish({
        tenantId,
        ownerId: userId,
        botId: publicBotId,
        idempotencyKey: "public-access-d1-publish",
      });
      const publicListings = await repos.listPublicBots({ limit: 10 });
      expect(publicListings).toHaveLength(1);
      expect(publicListings[0]).toMatchObject({
        botId: publicBotId,
        title: "Cloudflare D1 Test Bot",
        dailyUsageLimit: 100,
        rateLimitPerMinute: 10,
      });

      await repos.setPublicBotAccessPolicy({
        tenantId,
        ownerId: userId,
        botId: publicBotId,
        dailyUsageLimit: 2,
        rateLimitPerMinute: 1,
        now: "2026-10-30T12:00:00.000Z",
      });
      expect(
        await repos.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:00:00.000Z",
        }),
      ).toBe("allowed");
      expect(
        await repos.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:00:30.000Z",
        }),
      ).toBe("rate_limited");
      expect(
        await repos.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:01:00.000Z",
        }),
      ).toBe("allowed");
      expect(
        await repos.consumeBotUse({
          botId: publicBotId,
          userId: inviteeId,
          accessMode: "public",
          now: "2026-10-30T12:02:00.000Z",
        }),
      ).toBe("quota_exceeded");

      const sharedBotId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "shared-access-d1-bot",
        answers: { ...creationAnswers(), visibility: "shared" },
      });
      await repos.publish({
        tenantId,
        ownerId: userId,
        botId: sharedBotId,
        idempotencyKey: "shared-access-d1-publish",
      });
      const grant = await repos.createOwnedAccessGrant({
        tenantId,
        ownerId: userId,
        botId: sharedBotId,
        invitationTokenHash: "a".repeat(64),
        now: "2026-10-30T12:00:00.000Z",
      });
      expect(grant).toMatchObject({ invitationAvailable: true, status: "active" });
      const accepted = await repos.acceptBotInvitation({
        invitationTokenHash: "a".repeat(64),
        userId: inviteeId,
        now: "2026-10-30T12:00:01.000Z",
      });
      expect(accepted).toMatchObject({ id: grant.id, userId: inviteeId, invitationAvailable: false });
      expect(
        await repos.getSharedBot({ botId: sharedBotId, userId: inviteeId, now: "2026-10-30T12:00:02.000Z" }),
      ).toMatchObject({ id: sharedBotId, visibility: "shared" });
      expect(
        await repos.consumeBotUse({
          botId: sharedBotId,
          userId: inviteeId,
          accessMode: "shared",
          now: "2026-10-30T12:00:03.000Z",
        }),
      ).toBe("allowed");
      expect(
        await repos.acceptBotInvitation({
          invitationTokenHash: "a".repeat(64),
          userId: inviteeId,
          now: "2026-10-30T12:00:04.000Z",
        }),
      ).toBeUndefined();
      expect(
        await repos.revokeOwnedAccessGrant({ tenantId, ownerId: userId, botId: sharedBotId, grantId: grant.id }),
      ).toBe(true);
      expect(
        await repos.getSharedBot({ botId: sharedBotId, userId: inviteeId, now: "2026-10-30T12:00:05.000Z" }),
      ).toBeUndefined();

      const audit = await repos.listOwnedAuditLogs({ tenantId, ownerId: userId, limit: 100 });
      const accessDecisions = audit.filter((event) => event.action === "bot.access.decision");
      expect(accessDecisions).toHaveLength(5);
      expect(accessDecisions.map((event) => event.metadata.outcome)).toEqual([
        "quota_exceeded",
        "allowed",
        "rate_limited",
        "allowed",
        "allowed",
      ]);
    } finally {
      db.close();
    }
  });

  test("persist, claim, retry, and complete scheduled jobs", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    try {
      const now = "2026-10-30T12:00:00.000Z";
      const botId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "scheduled-d1-bot",
        answers: creationAnswers(),
      });
      await repos.publish({ tenantId, ownerId: userId, botId, idempotencyKey: "scheduled-d1-publish" });
      const taskId = `task_${"a".repeat(32)}` as ScheduledTaskId;
      const jobId = `job_${"b".repeat(32)}` as JobId;
      const runAt = "2026-10-30T12:05:00.000Z";
      const task: ScheduledTask = {
        id: taskId,
        tenantId,
        botId,
        ownerId: userId,
        schedule: `once:${runAt}`,
        timezone: "UTC",
        prompt: "Prepare a report.",
        notifyTelegramUserId: 54321,
        status: "active",
        nextRunAt: runAt,
        createdAt: now,
        updatedAt: now,
      };
      await repos.createScheduledTask({ task, firstJobId: jobId, idempotencyKey: `${taskId}:${runAt}` });
      expect(await repos.getScheduledTask({ tenantId, taskId })).toMatchObject(task);
      expect(await repos.listDueScheduledJobIds({ now: runAt, limit: 10 })).toEqual([jobId]);

      const claimed = await repos.claimScheduledJob({
        jobId,
        now: runAt,
        leaseUntil: "2026-10-30T12:15:00.000Z",
      });
      expect(claimed).toMatchObject({ id: jobId, taskId, status: "running", attempts: 1 });
      await repos.saveScheduledJobResult({ jobId, resultText: "The report is ready.", now: runAt });
      await repos.retryScheduledJob({
        jobId,
        availableAt: "2026-10-30T12:06:00.000Z",
        now: runAt,
      });
      expect(await repos.listDueScheduledJobIds({ now: runAt, limit: 10 })).toEqual([]);
      expect(await repos.getScheduledJob({ jobId })).toMatchObject({
        resultText: "The report is ready.",
        status: "retrying",
      });

      const recovered = await repos.claimScheduledJob({
        jobId,
        now: "2026-10-30T12:06:00.000Z",
        leaseUntil: "2026-10-30T12:16:00.000Z",
      });
      expect(recovered).toMatchObject({ resultText: "The report is ready.", attempts: 2 });
      await repos.completeScheduledRun({ tenantId, taskId, jobId, now: "2026-10-30T12:06:01.000Z" });
      expect(await repos.getScheduledTask({ tenantId, taskId })).toMatchObject({ status: "completed" });
      expect(await repos.getScheduledJob({ jobId })).toMatchObject({ status: "succeeded" });
    } finally {
      db.close();
    }
  });

  test("persist tenant-scoped drafts, sessions, conversations, and encrypted secret records", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    try {
      const answers = creationAnswers();
      const botId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "draft-session-cloudflare",
        answers,
      });
      expect(
        await repos.createDraft({
          tenantId,
          ownerId: userId,
          idempotencyKey: "draft-session-cloudflare",
          answers,
        }),
      ).toBe(botId);
      expect(await repos.get(tenantId, botId)).toMatchObject({
        id: botId,
        ownerId: userId,
        name: answers.name,
        model: { providerId: answers.providerId, model: answers.model },
        status: "draft",
      });
      await repos.publish({ tenantId, ownerId: userId, botId, idempotencyKey: "publish-session-cloudflare" });
      expect((await repos.get(tenantId, botId))?.status).toBe("published");
      const editedBot = await repos.updateOwned({
        tenantId,
        ownerId: userId,
        botId,
        expectedVersion: 1,
        patch: { description: "A revised assistant." },
      });
      expect(editedBot).toMatchObject({ version: 2, description: "A revised assistant." });
      const versions = await repos.listVersions({ tenantId, ownerId: userId, botId, limit: 50 });
      expect(versions.map(({ version, current }) => ({ version, current }))).toEqual([
        { version: 2, current: true },
        { version: 1, current: false },
      ]);
      expect(await repos.listOwned(tenantId, userId)).toContainEqual(editedBot);
      await expect(
        repos.updateOwned({ tenantId, ownerId: userId, botId, expectedVersion: 1, patch: { name: "Stale edit" } }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await repos.setDisabled({ tenantId, ownerId: userId, botId, disabled: true });
      expect((await repos.get(tenantId, botId))?.status).toBe("disabled");
      await repos.setDisabled({ tenantId, ownerId: userId, botId, disabled: false });
      expect((await repos.get(tenantId, botId))?.status).toBe("published");

      seedHttpSkill(db);
      expect((await repos.skills.listCatalog(tenantId)).map((skill) => skill.id)).toContain("weather.lookup");
      await repos.skills.install({
        tenantId,
        botId,
        skillId: "weather.lookup",
        installedBy: userId,
        configuration: {},
        grantedPermissions: ["weather:read"],
      });
      expect(await repos.skills.listInstalled(tenantId, botId)).toMatchObject([
        { definition: { id: "weather.lookup" }, grantedPermissions: ["weather:read"] },
      ]);
      expect(await repos.skills.listInstalled("other-tenant" as TenantId, botId)).toEqual([]);
      const limit = { tenantId, botId, skillId: "weather.lookup", now: 60_000, maxRequests: 2, windowSeconds: 60 };
      expect(await repos.skillRateLimiter.consume(limit)).toBe(true);
      expect(await repos.skillRateLimiter.consume(limit)).toBe(true);
      expect(await repos.skillRateLimiter.consume(limit)).toBe(false);
      expect(await repos.skillRateLimiter.consume({ ...limit, now: 120_000 })).toBe(true);
      await repos.skills.setEnabled({ tenantId, botId, skillId: "weather.lookup", enabled: false });
      expect((await repos.skills.listInstalled(tenantId, botId))[0]?.enabled).toBe(false);
      await repos.skills.uninstall({ tenantId, botId, skillId: "weather.lookup" });
      expect(await repos.skills.listInstalled(tenantId, botId)).toEqual([]);

      const oldMcpCredentialRef = `secret_${"3".repeat(32)}`;
      const newMcpCredentialRef = `secret_${"4".repeat(32)}`;
      for (const reference of [oldMcpCredentialRef, newMcpCredentialRef]) {
        await repos.secretRecords.create({
          tenantId,
          reference,
          keyId: "test-key",
          nonce: "nonce",
          ciphertext: "ciphertext",
          version: 1,
          createdAt: "2026-10-30T00:00:00.000Z",
        });
      }
      await repos.mcp.createServer({
        id: "mcp-cloudflare-test",
        tenantId,
        botId,
        name: "Cloudflare MCP test",
        endpoint: "https://mcp.example.test/mcp",
        credentialRef: oldMcpCredentialRef,
        installedBy: userId,
      });
      expect(await repos.mcp.listServers(tenantId, botId)).toMatchObject([
        { id: "mcp-cloudflare-test", status: "disconnected", credentialRef: oldMcpCredentialRef },
      ]);
      await repos.mcp.setServerCredentialRef({
        tenantId,
        botId,
        serverId: "mcp-cloudflare-test",
        expectedCredentialRef: oldMcpCredentialRef,
        credentialRef: newMcpCredentialRef,
      });
      expect(await repos.mcp.getServer(tenantId, botId, "mcp-cloudflare-test")).toMatchObject({
        credentialRef: newMcpCredentialRef,
      });
      await expect(
        repos.mcp.setServerCredentialRef({
          tenantId,
          botId,
          serverId: "mcp-cloudflare-test",
          expectedCredentialRef: oldMcpCredentialRef,
          credentialRef: oldMcpCredentialRef,
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const discovered = {
        name: "lookup",
        description: "Lookup one item.",
        inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
        outputSchema: { type: "object", properties: { value: { type: "string" } } },
      } as const;
      await repos.mcp.replaceDiscoveredTools({
        tenantId,
        botId,
        serverId: "mcp-cloudflare-test",
        tools: [discovered],
        discoveredAt: "2026-10-30T00:00:00.000Z",
      });
      expect(await repos.mcp.listTools(tenantId, botId)).toMatchObject([
        { name: "lookup", enabled: false, grantedPermissions: [], inputSchema: discovered.inputSchema },
      ]);
      await repos.mcp.setToolPermission({
        tenantId,
        botId,
        serverId: "mcp-cloudflare-test",
        toolName: "lookup",
        enabled: true,
        grantedPermissions: ["mcp:invoke"],
      });
      await repos.mcp.replaceDiscoveredTools({
        tenantId,
        botId,
        serverId: "mcp-cloudflare-test",
        tools: [{ ...discovered, inputSchema: { type: "object", properties: { key: { type: "number" } } } }],
        discoveredAt: "2026-10-30T00:01:00.000Z",
      });
      expect(await repos.mcp.getTool(tenantId, botId, "mcp-cloudflare-test", "lookup")).toMatchObject({
        enabled: false,
        grantedPermissions: [],
      });
      expect(await repos.mcp.listTools("other-tenant" as TenantId, botId)).toEqual([]);
      await repos.mcp.deleteServer({ tenantId, botId, serverId: "mcp-cloudflare-test" });
      expect(await repos.mcp.listTools(tenantId, botId)).toEqual([]);

      const session: CreationSession = {
        id: "factory-cloudflare",
        tenantId,
        ownerId: userId,
        status: "in_progress",
        currentStep: "name",
        answers: {},
        revision: 1,
        createdAt: "2026-10-30T00:00:00.000Z",
        updatedAt: "2026-10-30T00:00:00.000Z",
      };
      await repos.sessions.create(session);
      expect(await repos.sessions.get(tenantId, userId, session.id)).toEqual(session);
      await repos.sessions.save({ ...session, revision: 2, status: "paused" }, 1);
      await expect(repos.sessions.save({ ...session, revision: 3 }, 1)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(await repos.sessions.get("other-tenant" as TenantId, userId, session.id)).toBeUndefined();
      const apiConversation = await repos.getOrCreateApiConversation({
        tenantId,
        botId,
        actorId: userId,
        conversationKey: `${userId}:conv_cloudflare_test`,
      });
      expect(
        await repos.getOrCreateApiConversation({
          tenantId,
          botId,
          actorId: userId,
          conversationKey: `${userId}:conv_cloudflare_test`,
        }),
      ).toBe(apiConversation);
      expect(
        await repos.getOrCreateApiConversation({
          tenantId,
          botId,
          actorId: userId,
          conversationKey: `${userId}:conv_cloudflare_other`,
        }),
      ).not.toBe(apiConversation);
      const approval = {
        approvalHash: "a".repeat(64),
        tenantId,
        ownerId: userId,
        sessionId: session.id,
        action: "connect_credentials" as const,
        createdAt: "2026-10-30T00:00:00.000Z",
        expiresAt: "2026-10-30T00:10:00.000Z",
      };
      await repos.creationApprovals.create(approval);
      const consumeApproval = (input: {
        tenantId: TenantId;
        sessionId: string;
        action: typeof approval.action;
        now: string;
      }) => repos.creationApprovals.consume({ ...input, ownerId: userId, approvalHash: approval.approvalHash });
      expect(
        await consumeApproval({ ...approval, tenantId: "other-tenant" as TenantId, now: "2026-10-30T00:01:00.000Z" }),
      ).toBe(false);
      expect(await consumeApproval({ ...approval, sessionId: "factory-other", now: "2026-10-30T00:01:00.000Z" })).toBe(
        false,
      );
      expect(await consumeApproval({ ...approval, now: "2026-10-30T00:01:00.000Z" })).toBe(true);
      expect(await consumeApproval({ ...approval, now: "2026-10-30T00:02:00.000Z" })).toBe(false);

      const conversationId = "conversation-cloudflare" as ConversationId;
      await repos.createConversation({
        id: conversationId,
        tenantId,
        botId,
        actorId: userId,
        platform: "internal",
        platformConversationId: "cloudflare-test-chat",
      });
      await repos.append(tenantId, conversationId, [
        { role: "user", content: "Run the report." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-report", name: "report", arguments: { format: "json" } }],
        },
        { role: "tool", name: "report", toolCallId: "call-report", content: '{"ok":true}' },
        { role: "assistant", content: "The report is ready." },
      ]);
      expect(await repos.load(tenantId, conversationId, 10)).toEqual([
        { role: "user", content: "Run the report." },
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-report", name: "report", arguments: { format: "json" } }],
        },
        { role: "tool", name: "report", toolCallId: "call-report", content: '{"ok":true}' },
        { role: "assistant", content: "The report is ready." },
      ]);
      await expect(repos.load("other-tenant" as TenantId, conversationId, 10)).resolves.toEqual([]);

      const secret: EncryptedSecretRecord = {
        tenantId,
        reference: `secret_${"a".repeat(32)}`,
        keyId: "key-v1",
        nonce: "nonce-base64",
        ciphertext: "ciphertext-base64",
        version: 1,
        createdAt: "2026-10-30T00:00:00.000Z",
      };
      await repos.secretRecords.create(secret);
      expect(await repos.secretRecords.get(tenantId, secret.reference)).toEqual(secret);
      expect(await repos.secretRecords.get("other-tenant" as TenantId, secret.reference)).toBeUndefined();

      const token = await createApiTokenMaterial();
      await repos.apiTokens.create({
        tokenId: "token-cloudflare",
        tenantId,
        ownerId: userId,
        tokenHash: token.tokenHash,
        tokenPrefix: token.tokenPrefix,
        scopes: ["factory:read"],
        createdAt: "2026-10-30T00:00:00.000Z",
      });
      expect(await repos.apiTokens.findActive(token.tokenHash, "2026-10-30T01:00:00.000Z")).toEqual({
        tokenId: "token-cloudflare",
        tenantId,
        ownerId: userId,
        scopes: ["factory:read"],
        tenantRole: "owner",
      });
      await repos.apiTokens.revoke(tenantId, userId, "token-cloudflare", "2026-10-30T02:00:00.000Z");
      expect(await repos.apiTokens.findActive(token.tokenHash, "2026-10-30T03:00:00.000Z")).toBeUndefined();
      await repos.deleteOwned({ tenantId, ownerId: userId, botId });
      expect(await repos.get(tenantId, botId)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("reject a conversation turn when its tenant does not own the conversation", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    try {
      const conversationId = "conversation-owned" as ConversationId;
      const botId = "bot-cloudflare" as BotId;
      db.query(`
        INSERT INTO bots (id, tenant_id, owner_id, name, description, status, visibility,
                          current_version, created_at, updated_at)
        VALUES (?, ?, ?, 'Test bot', '', 'published', 'private', 1, ?, ?)
      `).run(botId, tenantId, userId, "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z");
      db.query(`
        INSERT INTO bot_versions (bot_id, tenant_id, version, configuration_json, created_by, created_at)
        VALUES (?, ?, 1, '{"systemPrompt":"test","model":{"providerId":"x","model":"y"}}', ?, ?)
      `).run(botId, tenantId, userId, "2026-10-30T00:00:00.000Z");
      db.query(`
        INSERT INTO conversations (
          id, tenant_id, bot_id, actor_id, platform, platform_conversation_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'internal', 'owned-chat', ?, ?)
      `).run(conversationId, tenantId, botId, userId, "2026-10-30T00:00:00.000Z", "2026-10-30T00:00:00.000Z");

      await expect(
        repos.append("other-tenant" as TenantId, conversationId, [{ role: "user", content: "cross tenant" }]),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await repos.load(tenantId, conversationId, 10)).toEqual([]);
    } finally {
      db.close();
    }
  });
  test("persists Telegram deployments, conversations, and retryable update reservations", async () => {
    const db = createDatabase();
    const repos = new CloudflareD1Repositories(new SqliteD1(db) as unknown as D1Database);
    try {
      const botId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "telegram-cloudflare-bot",
        answers: creationAnswers(),
      });
      await repos.publish({ tenantId, ownerId: userId, botId, idempotencyKey: "telegram-cloudflare-publish" });
      const credentialRef = `secret_${"b".repeat(32)}`;
      const webhookRef = `secret_${"c".repeat(32)}`;
      for (const reference of [credentialRef, webhookRef]) {
        await repos.secretRecords.create({
          tenantId,
          reference,
          keyId: "test-key",
          nonce: "nonce",
          ciphertext: "ciphertext",
          version: 1,
          createdAt: "2026-10-30T00:00:00.000Z",
        });
      }
      const deploymentId = "dep_telegram-cloudflare" as TelegramDeploymentId;
      await repos.createTelegramDeployment({
        id: deploymentId,
        tenantId,
        botId,
        externalId: "7654321",
        credentialRef,
        webhookSecretRef: webhookRef,
        status: "pending",
      });
      await repos.setTelegramDeploymentStatus({ tenantId, id: deploymentId, status: "active" });
      expect(await repos.getTelegramDeployment(deploymentId)).toMatchObject({
        tenantId,
        botId,
        externalId: "7654321",
        status: "active",
      });
      expect(await repos.getOwnedTelegramDeployment({ tenantId, ownerId: userId, botId })).toMatchObject({
        id: deploymentId,
      });
      expect(
        await repos.getOwnedTelegramDeployment({ tenantId: "other-tenant" as TenantId, ownerId: userId, botId }),
      ).toBeUndefined();
      expect(await repos.getTelegramAccessPolicy(deploymentId)).toEqual({ allowedUserIds: [], pendingUserIds: [] });
      await repos.recordTelegramAccessRequest({
        deploymentId,
        telegramUserId: 22,
        now: "2026-10-30T00:00:00.000Z",
      });
      expect(await repos.getTelegramAccessPolicy(deploymentId)).toEqual({
        allowedUserIds: [],
        pendingUserIds: [22],
      });
      expect(await repos.isTelegramSenderAllowed({ deploymentId, telegramUserId: 22 })).toBe(false);
      await repos.replaceTelegramAllowedUsers({
        deploymentId,
        telegramUserIds: [22],
        now: "2026-10-30T00:01:00.000Z",
      });
      expect(await repos.getTelegramAccessPolicy(deploymentId)).toEqual({ allowedUserIds: [22], pendingUserIds: [] });
      expect(await repos.isTelegramSenderAllowed({ deploymentId, telegramUserId: 22 })).toBe(true);
      await repos.replaceTelegramToolGrants({
        deploymentId,
        telegramUserId: 22,
        toolRefs: ["skill:weather.lookup", "mcp:mcp_server_test:lookup"],
        now: "2026-10-30T00:02:00.000Z",
      });
      expect(await repos.listTelegramToolGrants({ deploymentId, telegramUserId: 22 })).toEqual([
        "mcp:mcp_server_test:lookup",
        "skill:weather.lookup",
      ]);
      expect(
        await repos.isTelegramToolAllowed({
          deploymentId,
          telegramUserId: 22,
          toolRef: "skill:weather.lookup",
        }),
      ).toBe(true);
      await repos.replaceTelegramAllowedUsers({
        deploymentId,
        telegramUserIds: [22, 23],
        now: "2026-10-30T00:03:00.000Z",
      });
      expect(await repos.listTelegramToolGrants({ deploymentId, telegramUserId: 22 })).toHaveLength(2);
      await repos.replaceTelegramAllowedUsers({
        deploymentId,
        telegramUserIds: [23],
        now: "2026-10-30T00:04:00.000Z",
      });
      expect(await repos.listTelegramToolGrants({ deploymentId, telegramUserId: 22 })).toEqual([]);
      expect(
        await repos.isTelegramToolAllowed({
          deploymentId,
          telegramUserId: 22,
          toolRef: "skill:weather.lookup",
        }),
      ).toBe(false);
      await repos.replaceTelegramAllowedUsers({
        deploymentId,
        telegramUserIds: [22],
        now: "2026-10-30T00:05:00.000Z",
      });
      for (let index = 1; index <= 101; index += 1) {
        await repos.recordTelegramAccessRequest({
          deploymentId,
          telegramUserId: 1000 + index,
          now: new Date(Date.parse("2026-10-30T00:00:00.000Z") + index * 1000).toISOString(),
        });
      }
      const boundedPendingUsers = (await repos.getTelegramAccessPolicy(deploymentId)).pendingUserIds;
      expect(boundedPendingUsers).toHaveLength(100);
      expect(boundedPendingUsers).not.toContain(1001);

      const otherBotId = await repos.createDraft({
        tenantId,
        ownerId: userId,
        idempotencyKey: "telegram-cloudflare-other-bot",
        answers: { ...creationAnswers(), name: "Another Telegram bot" },
      });
      await repos.publish({
        tenantId,
        ownerId: userId,
        botId: otherBotId,
        idempotencyKey: "telegram-cloudflare-other-publish",
      });
      for (const reference of [`secret_${"d".repeat(32)}`, `secret_${"e".repeat(32)}`]) {
        await repos.secretRecords.create({
          tenantId,
          reference,
          keyId: "test-key",
          nonce: "nonce",
          ciphertext: "ciphertext",
          version: 1,
          createdAt: "2026-10-30T00:00:00.000Z",
        });
      }
      await expect(
        repos.createTelegramDeployment({
          id: "dep_telegram-cloudflare-duplicate" as TelegramDeploymentId,
          tenantId,
          botId: otherBotId,
          externalId: "7654321",
          credentialRef: `secret_${"d".repeat(32)}`,
          webhookSecretRef: `secret_${"e".repeat(32)}`,
          status: "pending",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });

      const conversationId = await repos.getOrCreateTelegramConversation({
        tenantId,
        botId,
        actorId: userId,
        conversationKey: "telegram:-1001:0:22",
      });
      expect(
        await repos.getOrCreateTelegramConversation({
          tenantId,
          botId,
          actorId: userId,
          conversationKey: "telegram:-1001:0:22",
        }),
      ).toBe(conversationId);
      await repos.append(tenantId, conversationId, [{ role: "user", content: "Hello" }]);
      expect(await repos.load(tenantId, conversationId, 10)).toEqual([{ role: "user", content: "Hello" }]);

      expect(
        await repos.reserveTelegramUpdate({
          deploymentId,
          updateId: 17,
          now: "2026-10-30T00:00:00.000Z",
          leaseUntil: "2026-10-30T00:00:10.000Z",
        }),
      ).toEqual({ state: "acquired" });
      expect(
        await repos.reserveTelegramUpdate({
          deploymentId,
          updateId: 17,
          now: "2026-10-30T00:00:05.000Z",
          leaseUntil: "2026-10-30T00:02:05.000Z",
        }),
      ).toEqual({ state: "busy" });
      await repos.saveTelegramUpdateResponse({
        deploymentId,
        updateId: 17,
        responseText: "Stored reply",
        attachmentRefs: [{ kind: "image", secretRef: `secret_${"f".repeat(32)}` }],
        leaseUntil: "2026-10-30T00:00:10.000Z",
        now: "2026-10-30T00:00:06.000Z",
      });
      expect(
        await repos.reserveTelegramUpdate({
          deploymentId,
          updateId: 17,
          now: "2026-10-30T00:00:11.000Z",
          leaseUntil: "2026-10-30T00:02:11.000Z",
        }),
      ).toEqual({
        state: "ready",
        responseText: "Stored reply",
        attachmentRefs: [{ kind: "image", secretRef: `secret_${"f".repeat(32)}` }],
      });
      await repos.completeTelegramUpdate({
        deploymentId,
        updateId: 17,
        now: "2026-10-30T00:00:12.000Z",
      });
      expect(
        await repos.reserveTelegramUpdate({
          deploymentId,
          updateId: 17,
          now: "2026-10-30T00:01:00.000Z",
          leaseUntil: "2026-10-30T00:03:00.000Z",
        }),
      ).toEqual({
        state: "completed",
        attachmentRefs: [{ kind: "image", secretRef: `secret_${"f".repeat(32)}` }],
      });
      await repos.clearTelegramUpdateAttachments({ deploymentId, updateId: 17 });
      expect(
        await repos.reserveTelegramUpdate({
          deploymentId,
          updateId: 17,
          now: "2026-10-30T00:01:01.000Z",
          leaseUntil: "2026-10-30T00:03:01.000Z",
        }),
      ).toEqual({ state: "completed" });
    } finally {
      db.close();
    }
  });
});

function createDatabase(): Database {
  const db = new Database(":memory:");
  for (const migrationName of [
    "0001_initial.sql",
    "0002_creation_approvals.sql",
    "0003_skill_rate_limits.sql",
    "0004_mcp_discovered_tools.sql",
    "0005_telegram_webhooks.sql",
    "0006_telegram_bot_identity.sql",
    "0007_telegram_sender_access.sql",
    "0008_telegram_tool_grants.sql",
    "0009_telegram_webapp_auth.sql",
    "0010_usage_reporting.sql",
    "0011_master_bot.sql",
    "0012_encrypted_memory.sql",
    "0013_public_bot_access.sql",
    "0014_api_rate_limits.sql",
    "0015_bot_version_labels.sql",
    "0016_bot_credential_approvals.sql",
    "0017_workflow_executions.sql",
    "0018_telegram_response_attachments.sql",
    "0019_tool_executions.sql",
    "0020_tenant_membership_status.sql",
    "0021_tenant_invitations.sql",
    "0022_uploaded_files.sql",
    "0023_tool_execution_recovery.sql",
    "0024_model_retry_analytics.sql",
    "0025_bot_ownership_transfers.sql",
    "0026_bot_collaborators.sql",
    "0027_native_text_statistics.sql",
    "0028_mcp_reconnect_state.sql",
    "0029_telegram_master_rate_limits.sql",
  ]) {
    const migration = readFileSync(new URL(`../../migrations/sqlite/${migrationName}`, import.meta.url), "utf8");
    db.exec(migration);
  }
  db.query("INSERT INTO tenants (id, name, created_at) VALUES (?, 'Cloudflare test tenant', ?)").run(
    tenantId,
    "2026-10-30T00:00:00.000Z",
  );
  db.query("INSERT INTO users (id, auth_issuer, auth_subject, created_at) VALUES (?, 'test', ?, ?)").run(
    userId,
    userId,
    "2026-10-30T00:00:00.000Z",
  );
  db.query(`
    INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)
  `).run(tenantId, userId, "2026-10-30T00:00:00.000Z");
  return db;
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
    "Aihat",
    "information",
    "Look up weather.",
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
      configuration: { http: { endpoint: "https://weather.example.test/lookup", method: "POST" } },
      timeoutMs: 1000,
      rateLimit: { maxRequests: 2, windowSeconds: 60 },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [503] },
    }),
    "2026-10-30T00:00:00.000Z",
  );
}

function creationAnswers(): CreationAnswers {
  return {
    name: "Cloudflare D1 Test Bot",
    description: "D1 adapter persistence test",
    purpose: "Verify D1 storage behavior",
    audience: "Test suite",
    personality: "Clear and concise.",
    providerId: "openai-compatible",
    endpoint: "https://api.example.com/v1",
    model: "model-test",
    credentialRef: `secret_${"b".repeat(32)}`,
    skills: [],
    mcpConnections: [],
    integrations: [],
    memoryEnabled: true,
    scheduledTasks: [],
    privacySettings: [],
    visibility: "public",
    interfaces: ["api"],
  };
}

class SqliteD1 {
  constructor(private readonly db: Database) {}

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.db, query) as unknown as D1PreparedStatement;
  }

  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const runBatch = this.db.transaction(() =>
      statements.map((statement) => (statement as unknown as SqliteD1Statement).execute()),
    );
    return Promise.resolve(runBatch() as D1Result<T>[]);
  }
}

class SqliteD1Statement {
  #bindings: SQLQueryBindings[] = [];

  constructor(
    private readonly db: Database,
    private readonly query: string,
  ) {}

  bind(...bindings: SQLQueryBindings[]): this {
    this.#bindings = bindings;
    return this;
  }

  async first<T>(): Promise<T | null> {
    return this.db.query<T, SQLQueryBindings[]>(this.query).get(...this.#bindings) ?? null;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = this.db.query<T, SQLQueryBindings[]>(this.query).all(...this.#bindings);
    return {
      success: true,
      results,
      meta: { changes: 0 },
    } as unknown as D1Result<T>;
  }

  async run<T>(): Promise<D1Result<T>> {
    const result = this.db.query(this.query).run(...this.#bindings);
    return {
      success: true,
      results: [],
      meta: { changes: result.changes },
    } as unknown as D1Result<T>;
  }

  execute<T>(): D1Result<T> {
    const result = this.db.query(this.query).run(...this.#bindings);
    return {
      success: true,
      results: [],
      meta: { changes: result.changes },
    } as unknown as D1Result<T>;
  }
}
