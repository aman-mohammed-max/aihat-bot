import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createBotAccessApiHandler,
} from "../../packages/core/src/index.js";
import type {
  AgentEngine,
  ApiConversationRepository,
  BotAccessRepository,
  BotRepository,
} from "../../packages/core/src/ports.js";
import type {
  AgentRequest,
  BotAccessGrant,
  BotDefinition,
  BotId,
  PublicBotListing,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant-access-test" as TenantId;
const ownerId = `usr_${"1".repeat(32)}` as UserId;
const sharedOwnerId = `usr_${"2".repeat(32)}` as UserId;
const publicBotId = "bot_123e4567-e89b-12d3-a456-426614174000" as BotId;
const sharedBotId = "bot_123e4567-e89b-12d3-a456-426614174001" as BotId;
const publicBot: BotDefinition = {
  id: publicBotId,
  tenantId,
  ownerId,
  name: "Public helper",
  description: "A safe public description.",
  systemPrompt: "PRIVATE INTERNAL PROMPT",
  model: { providerId: "test", model: "test-model", credentialRef: `secret_${"b".repeat(32)}` },
  visibility: "public",
  status: "published",
  interfaces: ["web_chat", "api"],
  version: 1,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const sharedBot: BotDefinition = { ...publicBot, id: sharedBotId, ownerId: sharedOwnerId, visibility: "invitation" };
const listing: PublicBotListing = {
  botId: publicBotId,
  slug: "public-helper",
  title: "Public helper",
  summary: "A safe public description.",
  listedAt: "2026-10-30T00:00:00.000Z",
  dailyUsageLimit: 100,
  rateLimitPerMinute: 10,
};

describe("bot access API", () => {
  test("allows direct grants on private bots without creating invitation links", async () => {
    const token = await createApiTokenMaterial();
    const privateBot = { ...sharedBot, ownerId, visibility: "private" as const };
    let createdGrantInput: Parameters<BotAccessRepository["createOwnedAccessGrant"]>[0] | undefined;
    const handler = createHandler({
      getBot: async () => privateBot,
      createGrant: async (grantInput) => {
        createdGrantInput = grantInput;
        return { ...baseGrant(), ...(grantInput.userId ? { userId: grantInput.userId } : {}) };
      },
    });
    const endpoint = `https://app.example.test/v1/bots/${sharedBotId}/access/grants`;
    const created = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ userId: "target_user" }),
      }),
    );
    expect(created?.status).toBe(201);
    expect(await created?.json()).toMatchObject({ grant: { userId: "target_user" } });
    expect(createdGrantInput).toMatchObject({ userId: "target_user" });
    expect(createdGrantInput?.invitationTokenHash).toBeUndefined();

    const invitation = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      }),
    );
    expect(invitation?.status).toBe(409);
  });

  test("serves safe public details and isolates owner memory for public runs", async () => {
    const token = await createApiTokenMaterial();
    let agentRequest: AgentRequest | undefined;
    const handler = createHandler({
      authenticate: async () => ({ tenantId, ownerId, tokenId: "token-test", scopes: ["agent:run", "bots:read"] }),
      respond: async (request) => {
        agentRequest = request;
        return {
          message: { role: "assistant", content: request.responseSchema ? '{"answer":"Welcome."}' : "Welcome." },
          ...(request.actorContext?.platform === "web_chat"
            ? { attachments: [{ kind: "image" as const, url: "https://images.example.test/public.png" }] }
            : {}),
          ...(request.responseSchema ? { structuredOutput: { answer: "Welcome." } } : {}),
        };
      },
    });

    const collection = await handler(new Request("https://app.example.test/v1/public/bots"));
    expect(collection?.status).toBe(200);
    expect(await collection?.json()).toEqual({ items: [listing] });

    const detail = await handler(new Request("https://app.example.test/v1/public/bots/public-helper"));
    expect(detail?.status).toBe(200);
    const detailBody = await detail?.text();
    expect(detailBody).toContain("A safe public description.");
    expect(detailBody).not.toContain("PRIVATE INTERNAL PROMPT");
    expect(detailBody).not.toContain("credentialRef");

    const webChatDetail = await handler(new Request("https://app.example.test/v1/public/bots/public-helper/web-chat"));
    expect(webChatDetail?.status).toBe(200);
    expect(await webChatDetail?.json()).toEqual({
      bot: {
        id: publicBotId,
        slug: "public-helper",
        name: "Public helper",
        description: "A safe public description.",
        visibility: "public",
      },
    });

    const response = await handler(
      new Request("https://app.example.test/v1/public/bots/public-helper/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Hi" }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ message: "Welcome." });
    expect(agentRequest).toMatchObject({
      actorId: ownerId,
      actorContext: { platform: "api", includeOwnerMemory: false },
      bot: { id: publicBotId },
    });

    const webChatResponse = await handler(
      new Request("https://app.example.test/v1/public/bots/public-helper/web-chat/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Hello from the web chat", conversationId: `conv_${"c".repeat(32)}` }),
      }),
    );
    expect(webChatResponse?.status).toBe(200);
    expect(await webChatResponse?.json()).toMatchObject({
      message: "Welcome.",
      attachments: [{ kind: "image", url: "https://images.example.test/public.png" }],
    });
    expect(agentRequest).toMatchObject({
      actorId: ownerId,
      actorContext: { platform: "web_chat", includeOwnerMemory: false },
      bot: { id: publicBotId },
    });

    const unavailableHandler = createHandler({
      getPublicBot: async () => ({ ...publicBot, interfaces: ["api"] }),
    });
    const unavailablePage = await unavailableHandler(
      new Request("https://app.example.test/v1/public/bots/public-helper/web-chat"),
    );
    expect(unavailablePage?.status).toBe(404);
    const unavailableMessage = await unavailableHandler(
      new Request("https://app.example.test/v1/public/bots/public-helper/web-chat/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "This interface is disabled" }),
      }),
    );
    expect(unavailableMessage?.status).toBe(404);

    const legacyPublicBot = { ...publicBot, interfaces: undefined } as unknown as BotDefinition;
    const legacyHandler = createHandler({ getPublicBot: async () => legacyPublicBot });
    const legacyApiMessage = await legacyHandler(
      new Request("https://app.example.test/v1/public/bots/public-helper/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Legacy public API bot" }),
      }),
    );
    expect(legacyApiMessage?.status).toBe(200);

    const responseSchema = {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
      additionalProperties: false,
    };
    const structuredResponse = await handler(
      new Request("https://app.example.test/v1/public/bots/public-helper/messages", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify({ message: "Reply as JSON", responseSchema }),
      }),
    );
    expect(structuredResponse?.status).toBe(200);
    expect(await structuredResponse?.json()).toMatchObject({ structuredOutput: { answer: "Welcome." } });
    expect(agentRequest?.responseSchema).toEqual(responseSchema);
  });

  test("shows invitation tokens once and accepts them for the signed-in user", async () => {
    const token = await createApiTokenMaterial();
    let storedHash: string | undefined;
    let acceptedHash: string | undefined;
    const createHandlerForOwner = createHandler({
      authenticate: async () => ({
        tenantId,
        ownerId: sharedOwnerId,
        tokenId: "token-test",
        scopes: ["bots:read", "bots:write"],
      }),
      createGrant: async (input) => {
        storedHash = input.invitationTokenHash;
        return {
          id: "grant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          botId: sharedBotId,
          invitationAvailable: true,
          accessLevel: "use",
          status: "active",
          createdAt: "2026-10-30T00:00:00.000Z",
        };
      },
    });
    const acceptHandlerForInvitee = createHandler({
      acceptInvitation: async ({ invitationTokenHash, userId }) => {
        acceptedHash = invitationTokenHash;
        return {
          id: "grant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          botId: sharedBotId,
          userId,
          invitationAvailable: false,
          accessLevel: "use",
          status: "active",
          createdAt: "2026-10-30T00:00:00.000Z",
        };
      },
    });
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const created = await createHandlerForOwner(
      new Request(`https://app.example.test/v1/bots/${sharedBotId}/access/grants`, {
        method: "POST",
        headers,
        body: JSON.stringify({ dailyUsageLimit: 25 }),
      }),
    );
    expect(created?.status).toBe(201);
    const createdBody = (await created?.json()) as { invitationToken: string };
    expect(createdBody.invitationToken).toMatch(/^ahf_inv_[A-Za-z0-9_-]{43}$/);
    expect(storedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(storedHash).not.toBe(createdBody.invitationToken);

    const accepted = await acceptHandlerForInvitee(
      new Request("https://app.example.test/v1/access/invitations/accept", {
        method: "POST",
        headers,
        body: JSON.stringify({ token: createdBody.invitationToken }),
      }),
    );
    expect(accepted?.status).toBe(201);
    expect(acceptedHash).toBe(storedHash);
  });
});

function createHandler(
  overrides: {
    authenticate?: () => Promise<{ tenantId: TenantId; ownerId: UserId; tokenId: string; scopes: string[] }>;
    getBot?: BotRepository["get"];
    getPublicBot?: BotAccessRepository["getPublicBotBySlug"];
    respond?: AgentEngine["respond"];
    createGrant?: BotAccessRepository["createOwnedAccessGrant"];
    acceptInvitation?: BotAccessRepository["acceptBotInvitation"];
  } = {},
) {
  const principal = { tenantId, ownerId, tokenId: "token-test", scopes: ["agent:run", "bots:read", "bots:write"] };
  const authenticator = new ApiTokenAuthenticator({
    findActive: async () => (overrides.authenticate ? overrides.authenticate() : principal),
    create: async () => {},
    revoke: async () => {},
    consumeApiRequest: async () => true,
    recordApiMutation: async () => {},
  });
  const access = {
    listPublicBots: async () => [listing],
    getPublicBotBySlug:
      overrides.getPublicBot ?? (async (slug: string) => (slug === listing.slug ? publicBot : undefined)),
    getSharedBot: async () => sharedBot,
    listOwnedAccessGrants: async () => [],
    getOwnedPublicBotAccessPolicy: async () => listing,
    setPublicBotAccessPolicy: async () => listing,
    createOwnedAccessGrant: overrides.createGrant ?? (async () => baseGrant()),
    revokeOwnedAccessGrant: async () => true,
    acceptBotInvitation: overrides.acceptInvitation ?? (async () => baseGrant()),
    consumeBotUse: async () => "allowed" as const,
  } as unknown as BotAccessRepository;
  const bots = {
    get:
      overrides.getBot ??
      (async (_tenantId: TenantId, botId: BotId) => (botId === sharedBotId ? sharedBot : publicBot)),
    saveDraft: async () => {},
  } as BotRepository;
  const conversations = {
    getOrCreateApiConversation: async () =>
      "conv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as import("../../packages/core/src/types.js").ConversationId,
  } as ApiConversationRepository;
  const engine = {
    respond:
      overrides.respond ??
      (async (request) => ({
        message: { role: "assistant", content: "Welcome." },
        ...(request.actorContext?.platform === "web_chat"
          ? { attachments: [{ kind: "image" as const, url: "https://images.example.test/public.png" }] }
          : {}),
      })),
  } as AgentEngine;
  return createBotAccessApiHandler({
    authenticator,
    access,
    bots,
    conversations,
    engine,
    now: () => new Date("2026-10-30T12:00:00.000Z"),
  });
}

function baseGrant(): BotAccessGrant {
  return {
    id: "grant_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    botId: sharedBotId,
    invitationAvailable: false,
    accessLevel: "use",
    status: "active",
    createdAt: "2026-10-30T00:00:00.000Z",
  };
}
