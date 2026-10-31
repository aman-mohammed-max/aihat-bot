import { describe, expect, test } from "bun:test";
import { ApiTokenAuthenticator, createApiTokenMaterial } from "../../packages/core/src/api-auth.js";
import { createBotOwnershipTransfersApiHandler } from "../../packages/core/src/bot-ownership-transfers-http-api.js";
import type { BotOwnershipTransferRepository } from "../../packages/core/src/ports.js";
import type { BotId, BotOwnershipTransfer, TenantId, UserId } from "../../packages/core/src/types.js";

const tenantId = "tenant-transfer-api" as TenantId;
const botId = "bot_123e4567-e89b-12d3-a456-426614174000" as BotId;
const fromOwnerId = "user-transfer-owner" as UserId;
const toOwnerId = "user-transfer-recipient" as UserId;

describe("bot ownership transfer HTTP API", () => {
  test("returns a one-time token, exposes only safe metadata, and binds acceptance to the recipient", async () => {
    const ownerToken = await createApiTokenMaterial();
    const recipientToken = await createApiTokenMaterial();
    const tokens = new Map([
      [
        ownerToken.tokenHash,
        { tenantId, ownerId: fromOwnerId, tokenId: "owner-token", scopes: ["bots:read", "bots:write"] },
      ],
      [recipientToken.tokenHash, { tenantId, ownerId: toOwnerId, tokenId: "recipient-token", scopes: ["bots:write"] }],
    ]);
    let current: BotOwnershipTransfer | undefined;
    let storedTokenHash = "";
    const transfers: BotOwnershipTransferRepository = {
      create: async (input) => {
        storedTokenHash = input.tokenHash;
        current = {
          id: input.transferId,
          botId: input.botId,
          fromOwnerId: input.fromOwnerId,
          toOwnerId: input.toOwnerId,
          status: "pending",
          createdAt: input.createdAt,
          expiresAt: input.expiresAt,
        };
        return current;
      },
      getPending: async () => current,
      revoke: async () => {
        throw new Error("not used");
      },
      accept: async (input) => {
        if (
          input.tenantId !== tenantId ||
          input.tokenHash !== storedTokenHash ||
          input.recipientId !== toOwnerId ||
          !current
        ) {
          throw new Error("recipient or token did not match");
        }
        current = { ...current, status: "accepted", acceptedAt: input.now };
        return current;
      },
    };
    const authenticator = new ApiTokenAuthenticator({
      findActive: async (tokenHash) => tokens.get(tokenHash),
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });
    const handler = createBotOwnershipTransfersApiHandler(
      authenticator,
      transfers,
      () => new Date("2026-10-31T12:00:00.000Z"),
    );
    const ownerHeaders = { authorization: `Bearer ${ownerToken.token}`, "content-type": "application/json" };
    const offered = await handler(
      new Request(`https://factory.test/v1/bots/${botId}/ownership-transfer`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ targetUserId: toOwnerId }),
      }),
    );
    expect(offered?.status).toBe(201);
    const offeredBody = (await offered?.json()) as { item: BotOwnershipTransfer; token: string };
    expect(offeredBody.item).toMatchObject({ fromOwnerId, toOwnerId, status: "pending" });
    expect(offeredBody.item.expiresAt).toBe("2026-11-01T12:00:00.000Z");
    expect(offeredBody.token).toMatch(/^ahf_transfer_[A-Za-z0-9_-]{43}$/);
    expect(storedTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedTokenHash).not.toBe(offeredBody.token);

    const pending = await handler(
      new Request(`https://factory.test/v1/bots/${botId}/ownership-transfer`, { headers: ownerHeaders }),
    );
    expect(pending?.headers.get("cache-control")).toBe("no-store");
    const pendingText = await pending?.text();
    expect(pendingText).not.toContain('"candidates"');
    expect(pendingText).not.toContain(offeredBody.token);
    expect(pendingText).not.toContain(storedTokenHash);

    const accepted = await handler(
      new Request("https://factory.test/v1/bot-transfers/accept", {
        method: "POST",
        headers: { authorization: `Bearer ${recipientToken.token}`, "content-type": "application/json" },
        body: JSON.stringify({ token: offeredBody.token }),
      }),
    );
    expect(accepted?.status).toBe(200);
    expect(await accepted?.json()).toMatchObject({ item: { status: "accepted", toOwnerId } });
  });

  test("rejects unsupported request fields and self transfer", async () => {
    const token = await createApiTokenMaterial();
    const authenticator = new ApiTokenAuthenticator({
      findActive: async () => ({ tenantId, ownerId: fromOwnerId, tokenId: "owner-token", scopes: ["bots:write"] }),
      create: async () => {},
      revoke: async () => {},
      consumeApiRequest: async () => true,
      recordApiMutation: async () => {},
    });
    const transfers: BotOwnershipTransferRepository = {
      create: async () => {
        throw new Error("must not be called");
      },
      getPending: async () => undefined,
      revoke: async () => {
        throw new Error("must not be called");
      },
      accept: async () => {
        throw new Error("must not be called");
      },
    };
    const handler = createBotOwnershipTransfersApiHandler(authenticator, transfers);
    const selfTransfer = await handler(
      new Request(`https://factory.test/v1/bots/${botId}/ownership-transfer`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: fromOwnerId }),
      }),
    );
    expect(selfTransfer?.status).toBe(400);
    const unsupported = await handler(
      new Request(`https://factory.test/v1/bots/${botId}/ownership-transfer`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ targetUserId: toOwnerId, token: "should-not-be-accepted" }),
      }),
    );
    expect(unsupported?.status).toBe(400);
  });
});
