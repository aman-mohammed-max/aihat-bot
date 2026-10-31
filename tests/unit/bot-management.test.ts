import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  AppError,
  BotCredentialApprovalService,
  createApiTokenMaterial,
  createBotManagementApiHandler,
} from "../../packages/core/src/index.js";
import type { BotManagementRepository, BotRepository } from "../../packages/core/src/ports.js";
import type { BotDefinition, BotId, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-bot-management" as TenantId;
const ownerId = "owner-bot-management" as UserId;
const botId = "bot_123e4567-e89b-12d3-a456-426614174000" as BotId;
const bot: BotDefinition = {
  id: botId,
  tenantId,
  ownerId,
  name: "Assistant",
  description: "Current description",
  systemPrompt: "Be helpful.",
  model: {
    providerId: "openai-compatible",
    model: "gpt-test",
    endpoint: "https://api.example.test/v1",
    credentialRef: `secret_${"b".repeat(32)}`,
  },
  visibility: "private",
  status: "published",
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function managementRepository(overrides: Partial<BotManagementRepository> = {}): BotManagementRepository {
  return {
    listOwned: async () => [],
    listCollaborated: async () => [],
    getCollaborated: async () => undefined,
    listBotCollaborators: async () => [],
    setBotCollaborator: async (input) => ({
      userId: input.userId,
      role: input.role,
      memberStatus: "active",
      createdAt: input.now,
      updatedAt: input.now,
    }),
    removeBotCollaborator: async () => {},
    updateCollaborated: async (input) => ({ ...bot, ...input.patch, version: input.expectedVersion + 1 }),
    listVersions: async () => [],
    updateOwned: async () => bot,
    setDisabled: async () => {},
    deleteOwned: async () => {},
    ...overrides,
  };
}

describe("bot management API", () => {
  test("supports least-privilege bot collaborators without exposing owner model settings", async () => {
    const token = await createApiTokenMaterial();
    let principal = { tenantId, ownerId, tokenId: "token-collaborators", scopes: ["bots:read", "bots:write"] };
    const editorId = "workspace-editor" as UserId;
    const viewerId = "workspace-viewer" as UserId;
    const collaboratorRows: Array<{
      userId: UserId;
      role: "viewer" | "editor";
      memberStatus: "active" | "inactive";
      createdAt: string;
      updatedAt: string;
    }> = [];
    let collaboratorUpdate: unknown;
    const handler = createBotManagementApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => bot, saveDraft: async () => {} },
      managementRepository({
        listOwned: async (_tenant, userId) => (userId === ownerId ? [bot] : []),
        listCollaborated: async ({ userId }) =>
          userId === editorId ? [{ bot, role: "editor" }] : userId === viewerId ? [{ bot, role: "viewer" }] : [],
        getCollaborated: async ({ userId }) =>
          userId === editorId ? { bot, role: "editor" } : userId === viewerId ? { bot, role: "viewer" } : undefined,
        listBotCollaborators: async () => collaboratorRows,
        setBotCollaborator: async (input) => {
          const current = collaboratorRows.find((item) => item.userId === input.userId);
          const item = {
            userId: input.userId,
            role: input.role,
            memberStatus: "active" as const,
            createdAt: current?.createdAt ?? input.now,
            updatedAt: input.now,
          };
          if (current) Object.assign(current, item);
          else collaboratorRows.push(item);
          return item;
        },
        removeBotCollaborator: async ({ userId }) => {
          const index = collaboratorRows.findIndex((item) => item.userId === userId);
          if (index >= 0) collaboratorRows.splice(index, 1);
        },
        updateCollaborated: async (input) => {
          collaboratorUpdate = input;
          if (principal.ownerId === viewerId) throw new AppError("FORBIDDEN", "Editor access is required.", 403);
          return { ...bot, ...input.patch, version: input.expectedVersion + 1 };
        },
      }),
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };

    const granted = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/collaborators`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ userId: editorId, role: "editor" }),
      }),
    );
    expect(granted?.status).toBe(200);
    expect(await granted?.json()).toMatchObject({ item: { userId: editorId, role: "editor" } });

    const roster = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/collaborators`, { headers }),
    );
    expect(roster?.status).toBe(200);
    expect(await roster?.json()).toMatchObject({ items: [{ userId: editorId, role: "editor" }] });

    principal = { tenantId, ownerId: editorId, tokenId: "token-editor", scopes: ["bots:read", "bots:write"] };
    const sharedBots = await handler(new Request("https://factory.example.test/v1/bots", { headers }));
    expect(await sharedBots?.json()).toMatchObject([{ id: botId, collaboratorRole: "editor" }]);
    const sharedDetail = await handler(new Request(`https://factory.example.test/v1/bots/${botId}`, { headers }));
    const sharedText = await sharedDetail?.text();
    expect(sharedText).toContain('"collaboratorRole":"editor"');
    expect(sharedText).not.toContain("https://api.example.test/v1");
    expect(sharedText).not.toContain(bot.model.credentialRef);

    const edited = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 1, description: "Editor changed the description" }),
      }),
    );
    expect(edited?.status).toBe(200);
    expect(collaboratorUpdate).toMatchObject({
      userId: editorId,
      patch: { description: "Editor changed the description" },
    });

    const modelEdit = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 2, memoryEnabled: false }),
      }),
    );
    expect(modelEdit?.status).toBe(400);

    principal = { tenantId, ownerId: viewerId, tokenId: "token-viewer", scopes: ["bots:read", "bots:write"] };
    const viewerEdit = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 1, name: "Viewer must not edit" }),
      }),
    );
    expect(viewerEdit?.status).toBe(403);

    principal = { tenantId, ownerId, tokenId: "token-collaborators", scopes: ["bots:read", "bots:write"] };
    const removed = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/collaborators/${editorId}`, {
        method: "DELETE",
        headers,
      }),
    );
    expect(removed?.status).toBe(204);
    expect(collaboratorRows).toEqual([]);
  });

  test("lists owner bots, versions edits, and never returns credential references", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token-bots", scopes: ["bots:read", "bots:write"] };
    let update: unknown;
    const handler = createBotManagementApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => bot, saveDraft: async () => {} } satisfies BotRepository,
      managementRepository({
        listOwned: async () => [bot],
        listVersions: async () => [
          {
            botId,
            version: 1,
            name: "Assistant",
            description: "Initial setup",
            systemPrompt: "Be helpful.",
            model: { providerId: "openai-compatible", model: "gpt-test", hasCredential: true },
            memoryEnabled: false,
            createdAt: "2026-01-01T00:00:00.000Z",
            current: true,
          },
        ],
        updateOwned: async (input) => {
          update = input;
          return { ...bot, ...input.patch, version: 2 };
        },
        setDisabled: async () => {},
        deleteOwned: async () => {},
      }),
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const listed = await handler(new Request("https://factory.example.test/v1/bots", { headers }));
    expect(listed?.status).toBe(200);
    const listBody = await listed?.json();
    expect(JSON.stringify(listBody)).not.toContain(bot.model.credentialRef);
    expect(listBody).toMatchObject([{ id: botId, version: 1, model: { hasCredential: true } }]);

    const versions = await handler(new Request(`https://factory.example.test/v1/bots/${botId}/versions`, { headers }));
    expect(versions?.status).toBe(200);
    const versionBody = await versions?.text();
    expect(versionBody).toContain('"version":1');
    expect(versionBody).toContain('"hasCredential":true');
    expect(versionBody).not.toContain(bot.model.credentialRef);

    const updated = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 1, description: "Updated description" }),
      }),
    );
    expect(updated?.status).toBe(200);
    expect(await updated?.json()).toMatchObject({ version: 2, description: "Updated description" });
    expect(update).toMatchObject({ expectedVersion: 1, patch: { description: "Updated description" } });

    const rawSecret = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 2, apiKey: "plain-secret" }),
      }),
    );
    expect(rawSecret?.status).toBe(400);
  });

  test("replaces model credentials only with a bot-bound one-use approval", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token-credential", scopes: ["bots:read", "bots:write"] };
    const auth = new ApiTokenAuthenticator({
      findActive: async () => principal,
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });
    let approval:
      | { approvalHash: string; tenantId: TenantId; ownerId: UserId; botId: BotId; expiresAt: string; used: boolean }
      | undefined;
    const approvals = new BotCredentialApprovalService({
      create: async (input) => {
        approval = { ...input, used: false };
      },
      consume: async (input) => {
        if (
          !approval ||
          approval.used ||
          approval.approvalHash !== input.approvalHash ||
          approval.tenantId !== input.tenantId ||
          approval.ownerId !== input.ownerId ||
          approval.botId !== input.botId ||
          approval.expiresAt <= input.now
        ) {
          return false;
        }
        approval.used = true;
        return true;
      },
    });
    const newCredentialRef = `secret_${"c".repeat(32)}`;
    const persistedCredentials: string[] = [];
    const secrets = {
      put: async (_tenant: TenantId, plaintext: string) => {
        persistedCredentials.push(plaintext);
        return newCredentialRef;
      },
      delete: async (_tenant: TenantId, reference: string) => {
        expect(reference).toBe(newCredentialRef);
      },
    };
    let currentBot = bot;
    let updatedPatch: unknown;
    const handler = createBotManagementApiHandler(
      auth,
      { get: async () => currentBot, saveDraft: async () => {} },
      managementRepository({
        listOwned: async () => [currentBot],
        listVersions: async () => [],
        updateOwned: async (input) => {
          updatedPatch = input.patch;
          currentBot = { ...currentBot, ...input.patch, version: currentBot.version + 1 };
          return currentBot;
        },
        setDisabled: async () => {},
        deleteOwned: async () => {},
      }),
      approvals,
      secrets,
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const issued = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/credential-approval`, { method: "POST", headers }),
    );
    expect(issued?.status).toBe(201);
    const approvalBody = (await issued?.json()) as { approvalId: string };
    expect(approvalBody.approvalId).toMatch(/^credential_approval_[A-Za-z0-9_-]{43}$/);

    const credential = "provider-key-that-must-never-be-returned";
    const updated = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/credential`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ approvalId: approvalBody.approvalId, credential, expectedVersion: 1 }),
      }),
    );
    expect(updated?.status).toBe(200);
    const responseText = await updated?.text();
    expect(responseText).not.toContain(credential);
    expect(responseText).not.toContain(newCredentialRef);
    expect(responseText).toContain('"hasCredential":true');
    expect(updatedPatch).toEqual({ model: { ...bot.model, credentialRef: newCredentialRef } });
    expect(persistedCredentials).toEqual([credential]);

    const modelApprovalResponse = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/credential-approval`, { method: "POST", headers }),
    );
    const modelApproval = (await modelApprovalResponse?.json()) as { approvalId: string };
    const modelCredential = "new-provider-key-that-must-never-be-returned";
    const modelResponse = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/model`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          approvalId: modelApproval.approvalId,
          credential: modelCredential,
          expectedVersion: 2,
          model: {
            providerId: "custom-openai-compatible",
            model: "custom-chat-model",
            endpoint: "https://models.example.test/v1",
            parameters: { temperature: 0.4 },
          },
        }),
      }),
    );
    expect(modelResponse?.status).toBe(200);
    const modelResponseText = await modelResponse?.text();
    expect(modelResponseText).not.toContain(modelCredential);
    expect(modelResponseText).not.toContain(newCredentialRef);
    expect(modelResponseText).toContain('"providerId":"custom-openai-compatible"');
    expect(modelResponseText).toContain('"hasCredential":true');
    expect(updatedPatch).toEqual({
      model: {
        providerId: "custom-openai-compatible",
        model: "custom-chat-model",
        endpoint: "https://models.example.test/v1",
        parameters: { temperature: 0.4 },
        credentialRef: newCredentialRef,
      },
    });
    expect(persistedCredentials).toEqual([credential, modelCredential]);

    const reused = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/credential`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ approvalId: approvalBody.approvalId, credential: "second-key", expectedVersion: 3 }),
      }),
    );
    expect(reused?.status).toBe(403);
    expect(persistedCredentials).toEqual([credential, modelCredential]);

    const genericPatch = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          expectedVersion: 3,
          model: { ...bot.model, credentialRef: `secret_${"d".repeat(32)}` },
        }),
      }),
    );
    expect(genericPatch?.status).toBe(400);
  });

  test("saves and clears owner-scoped model retry overrides without rotating credentials", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token-retries", scopes: ["bots:write"] };
    const auth = new ApiTokenAuthenticator({
      findActive: async () => principal,
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });
    let currentBot = bot;
    let updateCount = 0;
    const handler = createBotManagementApiHandler(
      auth,
      { get: async () => currentBot, saveDraft: async () => {} },
      managementRepository({
        listOwned: async () => [currentBot],
        listVersions: async () => [],
        updateOwned: async (input) => {
          updateCount += 1;
          expect(input.patch.model?.credentialRef).toBe(bot.model.credentialRef);
          currentBot = { ...currentBot, ...input.patch, version: currentBot.version + 1 };
          return currentBot;
        },
        setDisabled: async () => {},
        deleteOwned: async () => {},
      }),
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const saved = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/model/retry-policy`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 1, retryPolicy: { maxAttempts: 3, backoffMs: 1250 } }),
      }),
    );
    expect(saved?.status).toBe(200);
    const savedText = await saved?.text();
    expect(savedText).toContain('"retryPolicy":{"maxAttempts":3,"backoffMs":1250}');
    expect(savedText).not.toContain(bot.model.credentialRef);
    expect(currentBot.model.credentialRef).toBe(bot.model.credentialRef);
    expect(updateCount).toBe(1);

    const invalid = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/model/retry-policy`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 2, retryPolicy: { maxAttempts: 4, backoffMs: 1250 } }),
      }),
    );
    expect(invalid?.status).toBe(400);
    expect(updateCount).toBe(1);

    const cleared = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/model/retry-policy`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ expectedVersion: 2, retryPolicy: null }),
      }),
    );
    expect(cleared?.status).toBe(200);
    expect(await cleared?.text()).not.toContain("retryPolicy");
    expect(currentBot.model.credentialRef).toBe(bot.model.credentialRef);
    expect(updateCount).toBe(2);
  });

  test("scopes lifecycle actions to the bot owner and bots:write", async () => {
    const token = await createApiTokenMaterial();
    let disabled: boolean | undefined;
    const handler = createBotManagementApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => ({ tenantId, ownerId, tokenId: "token-read-only", scopes: ["bots:read"] }),
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => ({ ...bot, ownerId: "other-owner" as UserId }), saveDraft: async () => {} },
      managementRepository({
        listOwned: async () => [],
        listVersions: async () => [],
        updateOwned: async () => bot,
        setDisabled: async (input) => {
          disabled = input.disabled;
        },
        deleteOwned: async () => {},
      }),
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const hidden = await handler(new Request(`https://factory.example.test/v1/bots/${botId}`, { headers }));
    expect(hidden?.status).toBe(404);
    const forbidden = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/disable`, { method: "POST", headers }),
    );
    expect(forbidden?.status).toBe(403);
    expect(disabled).toBeUndefined();
  });
});
