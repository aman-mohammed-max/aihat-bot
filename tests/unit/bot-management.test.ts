import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
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

describe("bot management API", () => {
  test("lists owner bots, versions edits, and never returns credential references", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token-bots", scopes: ["bots:read", "bots:write"] };
    let update: unknown;
    const handler = createBotManagementApiHandler(
      new ApiTokenAuthenticator({ findActive: async () => principal, create: async () => {}, revoke: async () => {} }),
      { get: async () => bot, saveDraft: async () => {} } satisfies BotRepository,
      {
        listOwned: async () => [bot],
        updateOwned: async (input) => {
          update = input;
          return { ...bot, ...input.patch, version: 2 };
        },
        setDisabled: async () => {},
        deleteOwned: async () => {},
      } satisfies BotManagementRepository,
    );
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const listed = await handler(new Request("https://factory.example.test/v1/bots", { headers }));
    expect(listed?.status).toBe(200);
    const listBody = await listed?.json();
    expect(JSON.stringify(listBody)).not.toContain(bot.model.credentialRef);
    expect(listBody).toMatchObject([{ id: botId, version: 1, model: { hasCredential: true } }]);

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

  test("scopes lifecycle actions to the bot owner and bots:write", async () => {
    const token = await createApiTokenMaterial();
    let disabled: boolean | undefined;
    const handler = createBotManagementApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => ({ tenantId, ownerId, tokenId: "token-read-only", scopes: ["bots:read"] }),
        create: async () => {},
        revoke: async () => {},
      }),
      { get: async () => ({ ...bot, ownerId: "other-owner" as UserId }), saveDraft: async () => {} },
      {
        listOwned: async () => [],
        updateOwned: async () => bot,
        setDisabled: async (input) => {
          disabled = input.disabled;
        },
        deleteOwned: async () => {},
      },
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
