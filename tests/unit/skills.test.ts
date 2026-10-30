import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createSkillsApiHandler,
} from "../../packages/core/src/index.js";
import { SkillEngine } from "../../packages/core/src/skill-engine.js";
import type { SecretStore, SkillRateLimiter, SkillRepository } from "../../packages/core/src/ports.js";
import type {
  BotDefinition,
  BotId,
  InstalledSkill,
  SkillDefinition,
  TelegramDeploymentId,
  TenantId,
  UserId,
} from "../../packages/core/src/types.js";

const tenantId = "tenant-skills" as TenantId;
const ownerId = "user-skills" as UserId;
const botId = "bot_123e4567-e89b-12d3-a456-426614174000" as BotId;
const context = { tenantId, botId, actorId: ownerId };

const definition: SkillDefinition = {
  id: "weather.lookup",
  tenantId: null,
  name: "Weather lookup",
  version: "1.0.0",
  author: "Aihat",
  category: "information",
  description: "Look up the weather for a city.",
  executionType: "http",
  inputSchema: {
    type: "object",
    properties: { city: { type: "string", minLength: 1 } },
    required: ["city"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: { forecast: { type: "string" } },
    required: ["forecast"],
    additionalProperties: false,
  },
  requiredPermissions: ["weather:read"],
  configuration: {
    http: { endpoint: "https://weather.example.test/lookup", method: "POST" },
  },
  timeoutMs: 1000,
  rateLimit: { maxRequests: 10, windowSeconds: 60 },
  retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [503] },
  enabled: true,
};

function installation(overrides: Partial<InstalledSkill> = {}): InstalledSkill {
  return {
    definition,
    enabled: true,
    installedBy: ownerId,
    configuration: {},
    grantedPermissions: ["weather:read"],
    ...overrides,
  };
}

function skillRepository(installed: readonly InstalledSkill[]): SkillRepository {
  return {
    listCatalog: async () => [definition],
    getCatalogSkill: async () => definition,
    listInstalled: async () => installed,
    install: async () => {},
    setEnabled: async () => {},
    uninstall: async () => {},
  };
}

function rateLimiter(consume: SkillRateLimiter["consume"] = async () => true): SkillRateLimiter {
  return { consume };
}

const secrets: SecretStore = { resolve: async () => "test-secret" };

describe("skill engine", () => {
  test("requires a per-user grant before exposing or executing a Telegram skill", async () => {
    let allowed = false;
    const deploymentId = "dep_123e4567-e89b-12d3-a456-426614174000" as TelegramDeploymentId;
    const engine = new SkillEngine({
      skills: skillRepository([installation()]),
      rateLimiter: rateLimiter(),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
      telegramGrants: {
        isTelegramToolAllowed: async (input) =>
          allowed &&
          input.deploymentId === deploymentId &&
          input.telegramUserId === 789 &&
          input.toolRef === "skill:weather.lookup",
      },
      fetch: async () => Response.json({ forecast: "sunny" }),
    });
    const telegramContext = {
      ...context,
      platform: "telegram" as const,
      telegramDeploymentId: deploymentId,
      telegramUserId: 789,
    };
    const [apiTool] = await engine.available(context);
    if (!apiTool) throw new Error("Expected owner API access to the installed skill.");
    expect(await engine.available(telegramContext)).toEqual([]);
    await expect(engine.execute(telegramContext, apiTool.name, { city: "Oslo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    allowed = true;
    expect(await engine.available(telegramContext)).toEqual([apiTool]);
    await expect(engine.execute(telegramContext, apiTool.name, { city: "Oslo" })).resolves.toEqual({
      forecast: "sunny",
    });
    allowed = false;
    await expect(engine.execute(telegramContext, apiTool.name, { city: "Oslo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("advertises only enabled, fully granted skills on deployment-approved origins", async () => {
    const engine = new SkillEngine({
      skills: skillRepository([
        installation(),
        installation({ definition: { ...definition, id: "disabled", enabled: false } }),
        installation({ grantedPermissions: [] }),
        installation({
          definition: {
            ...definition,
            id: "external",
            configuration: { http: { endpoint: "https://blocked.example.test/lookup", method: "POST" } },
          },
        }),
        installation({
          definition: { ...definition, id: "instructions", executionType: "prompt" },
        }),
      ]),
      rateLimiter: rateLimiter(),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
    });

    const [advertised] = await engine.available(context);
    expect(advertised).toBeDefined();
    expect(await engine.promptInstructions(context)).toEqual([]);
    const unauthorized = new SkillEngine({
      skills: skillRepository([installation({ grantedPermissions: [] })]),
      rateLimiter: rateLimiter(),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
    });
    await expect(unauthorized.execute(context, advertised?.name ?? "", { city: "Oslo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  test("validates input/output, enforces rate limits, and calls the allowlisted endpoint", async () => {
    let call: { url: URL; init: RequestInit | undefined } | undefined;
    const engine = new SkillEngine({
      skills: skillRepository([installation()]),
      rateLimiter: rateLimiter(async () => true),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
      fetch: async (input, init) => {
        call = { url: new URL(input.toString()), init };
        return Response.json({ forecast: "sunny" });
      },
    });
    const [tool] = await engine.available(context);
    if (!tool) throw new Error("Expected an advertised skill.");
    expect(await engine.execute(context, tool.name, { city: "Oslo" })).toEqual({ forecast: "sunny" });
    expect(call?.url.origin).toBe("https://weather.example.test");
    expect(call?.init?.redirect).toBe("error");
    expect(call?.init?.body).toBe('{"city":"Oslo"}');
    await expect(engine.execute(context, tool.name, { city: 3 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const denied = new SkillEngine({
      skills: skillRepository([installation()]),
      rateLimiter: rateLimiter(async () => false),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
      fetch: async () => Response.json({ forecast: "sunny" }),
    });
    await expect(denied.execute(context, tool.name, { city: "Oslo" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  test("times out native handlers that ignore their abort signal", async () => {
    const nativeDefinition = { ...definition, id: "native.slow", executionType: "native" as const, timeoutMs: 10 };
    const engine = new SkillEngine({
      skills: skillRepository([installation({ definition: nativeDefinition })]),
      rateLimiter: rateLimiter(),
      secrets,
      allowedHttpOrigins: new Set(),
      nativeHandlers: new Map([[nativeDefinition.id, async () => new Promise<never>(() => {})]]),
    });
    const [tool] = await engine.available(context);
    if (!tool) throw new Error("Expected an advertised native skill.");
    await expect(engine.execute(context, tool.name, { city: "Oslo" })).rejects.toMatchObject({ status: 504 });
  });

  test("sends stored credentials only through declared authentication modes", async () => {
    const authenticatedDefinition: SkillDefinition = {
      ...definition,
      id: "weather.api-key",
      configuration: {
        http: {
          endpoint: "https://weather.example.test/lookup",
          method: "POST",
          authentication: { type: "header", header: "X-API-Key", required: true },
        },
      },
    };
    let sentCredential = "";
    const engine = new SkillEngine({
      skills: skillRepository([
        installation({
          definition: authenticatedDefinition,
          configuration: { credentialRef: `secret_${"c".repeat(32)}` },
        }),
      ]),
      rateLimiter: rateLimiter(),
      secrets: { resolve: async () => "encrypted-store-value" },
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
      fetch: async (_input, init) => {
        sentCredential = new Headers(init?.headers).get("x-api-key") ?? "";
        return Response.json({ forecast: "sunny" });
      },
    });
    const [tool] = await engine.available(context);
    if (!tool) throw new Error("Expected an advertised authenticated skill.");
    expect(await engine.execute(context, tool.name, { city: "Oslo" })).toEqual({ forecast: "sunny" });
    expect(sentCredential).toBe("encrypted-store-value");

    const invalidStaticSecret = new SkillEngine({
      skills: skillRepository([
        installation({
          definition: {
            ...authenticatedDefinition,
            id: "weather.static-key",
            configuration: {
              http: {
                endpoint: "https://weather.example.test/lookup",
                method: "POST",
                headers: { "X-API-Key": "plaintext" },
              },
            },
          },
        }),
      ]),
      rateLimiter: rateLimiter(),
      secrets,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
    });
    await expect(invalidStaticSecret.available(context)).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("skill management API", () => {
  test("requires explicit required-permission grants and stores only credential references", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token_test", scopes: ["bots:read", "bots:write"] };
    let saved: unknown;
    const bot: BotDefinition = {
      id: botId,
      tenantId,
      ownerId,
      name: "Bot",
      description: "Test bot",
      systemPrompt: "Help.",
      model: { providerId: "mock", model: "mock" },
      visibility: "private",
      status: "draft",
      version: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const skills = skillRepository([]);
    const handler = createSkillsApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
      }),
      { get: async () => bot, saveDraft: async () => {} },
      {
        ...skills,
        install: async (input) => {
          saved = input;
        },
      },
      {
        resolve: async (_tenantId, reference) =>
          reference === `secret_${"a".repeat(32)}` ? "secret" : Promise.reject(new Error("missing")),
      },
    );
    const auth = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const endpoint = `https://factory.example.test/v1/bots/${botId}/skills`;
    const denied = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ skillId: definition.id, grantedPermissions: [], configuration: {} }),
      }),
    );
    expect(denied?.status).toBe(400);

    const accepted = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          skillId: definition.id,
          grantedPermissions: ["weather:read"],
          configuration: { credentialRef: `secret_${"a".repeat(32)}` },
        }),
      }),
    );
    expect(accepted?.status).toBe(201);
    expect(saved).toMatchObject({ configuration: { credentialRef: `secret_${"a".repeat(32)}` } });
    expect(JSON.stringify(saved)).not.toContain('secret"');

    const plaintextRejected = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({
          skillId: definition.id,
          grantedPermissions: ["weather:read"],
          configuration: { apiKey: "plain-text-secret" },
        }),
      }),
    );
    expect(plaintextRejected?.status).toBe(400);
  });
});
