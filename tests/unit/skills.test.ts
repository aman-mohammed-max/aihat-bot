import { describe, expect, test } from "bun:test";
import {
  ApiTokenAuthenticator,
  createApiTokenMaterial,
  createGlobalSkillCatalogAdminHandler,
  createSkillsApiHandler,
} from "../../packages/core/src/index.js";
import { SkillEngine } from "../../packages/core/src/skill-engine.js";
import type {
  SecretStore,
  SecretWriter,
  SkillRateLimiter,
  SkillRepository,
  WorkflowExecutionRepository,
} from "../../packages/core/src/ports.js";
import type {
  BotDefinition,
  BotId,
  InstalledSkill,
  SkillDefinition,
  TelegramDeploymentId,
  TenantId,
  UserId,
  WorkflowExecution,
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
    listGlobalCatalog: async () => [],
    publishGlobalCatalogSkill: async () => {},
    setGlobalCatalogSkillEnabled: async () => {},
    publishCatalogSkill: async () => {},
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
  test("runs forward-only workflows with opaque checkpoints, child retries, and completed-call replay", async () => {
    const workflowDefinition: SkillDefinition = {
      ...definition,
      id: "weather.workflow",
      name: "Weather workflow",
      executionType: "workflow",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { forecast: { type: "string" }, detail: { type: "string" } },
        required: ["forecast", "detail"],
        additionalProperties: false,
      },
      configuration: {
        workflow: {
          steps: [
            {
              id: "lookup",
              type: "skill",
              skillId: "weather.lookup",
              input: { city: { $from: "input.city" } },
              retry: { maxAttempts: 2 },
            },
            {
              id: "branch",
              type: "condition",
              path: "steps.lookup.output.forecast",
              operator: "equals",
              value: "sunny",
              ifTrue: "details",
              ifFalse: "end",
            },
            {
              id: "details",
              type: "skill",
              skillId: "weather.details",
              input: {
                city: { $from: "input.city" },
                forecast: { $from: "steps.lookup.output.forecast" },
              },
            },
          ],
          output: {
            forecast: { $from: "steps.lookup.output.forecast" },
            detail: { $from: "steps.details.output.note" },
          },
        },
      },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [] },
    };
    const lookup = installation({
      definition: {
        ...definition,
        configuration: {
          http: {
            endpoint: "https://weather.example.test/lookup",
            method: "POST",
            idempotencyKeyHeader: "X-Idempotency-Key",
          },
        },
      },
    });
    const detailsDefinition: SkillDefinition = {
      ...definition,
      id: "weather.details",
      name: "Weather details",
      executionType: "native",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string" }, forecast: { type: "string" } },
        required: ["city", "forecast"],
        additionalProperties: false,
      },
      outputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotent: true, retryableStatusCodes: [] },
    };
    const installed = [
      installation({ definition: workflowDefinition }),
      lookup,
      installation({ definition: detailsDefinition }),
    ];
    const stateValues = new Map<string, string>();
    let secretSequence = 0;
    const secretWriter: SecretWriter & SecretStore = {
      resolve: async (_tenantId, reference) => {
        const value = stateValues.get(reference);
        if (!value) throw new Error("missing encrypted workflow state");
        return value;
      },
      put: async (_tenantId, plaintext) => {
        const reference = `secret_${String(++secretSequence).padStart(32, "0")}`;
        stateValues.set(reference, plaintext);
        return reference;
      },
      delete: async (_tenantId, reference) => {
        stateValues.delete(reference);
      },
    };
    let stored: WorkflowExecution | undefined;
    const workflowExecutions: WorkflowExecutionRepository = {
      acquire: async (input) => {
        if (stored?.status === "succeeded") return { state: "completed", execution: stored };
        if (stored && stored.leaseUntil > input.now) return { state: "busy" };
        if (stored) {
          stored = {
            ...stored,
            leaseToken: input.leaseToken,
            leaseUntil: input.leaseUntil,
            expiresAt: input.expiresAt,
            updatedAt: input.now,
            version: stored.version + 1,
          };
        } else {
          stored = {
            tenantId: input.tenantId,
            botId: input.botId,
            skillId: input.skillId,
            executionKey: input.executionKey,
            stateRef: input.initialStateRef,
            nextStep: 0,
            version: 1,
            status: "running",
            leaseToken: input.leaseToken,
            leaseUntil: input.leaseUntil,
            expiresAt: input.expiresAt,
            updatedAt: input.now,
          };
        }
        return { state: "acquired", execution: stored };
      },
      checkpoint: async (input) => {
        if (!stored || stored.version !== input.expectedVersion || stored.leaseToken !== input.leaseToken) return false;
        stored = {
          ...stored,
          stateRef: input.stateRef,
          nextStep: input.nextStep,
          version: stored.version + 1,
          leaseUntil: input.leaseUntil,
          expiresAt: input.expiresAt,
          updatedAt: input.now,
        };
        return true;
      },
      complete: async (input) => {
        if (!stored || stored.version !== input.expectedVersion || stored.leaseToken !== input.leaseToken) return false;
        const { leaseToken: _leaseToken, ...completed } = stored;
        stored = {
          ...completed,
          stateRef: input.stateRef,
          nextStep: input.nextStep,
          version: stored.version + 1,
          status: "succeeded",
          leaseUntil: input.now,
          expiresAt: input.expiresAt,
          updatedAt: input.now,
        };
        return true;
      },
      release: async (input) => {
        if (stored?.leaseToken === input.leaseToken) stored = { ...stored, leaseUntil: input.now };
      },
      purgeExpired: async () => [],
    };
    let lookupCalls = 0;
    const idempotencyKeys: string[] = [];
    let detailCalls = 0;
    const engine = new SkillEngine({
      skills: skillRepository(installed),
      rateLimiter: rateLimiter(),
      secrets: secretWriter,
      secretWriter,
      workflowExecutions,
      allowedHttpOrigins: new Set(["https://weather.example.test"]),
      fetch: async (_input, init) => {
        lookupCalls += 1;
        idempotencyKeys.push(new Headers(init?.headers).get("x-idempotency-key") ?? "");
        if (lookupCalls === 1) throw new Error("retryable provider interruption");
        return Response.json({ forecast: "sunny" });
      },
      nativeHandlers: new Map([
        [
          detailsDefinition.id,
          async (_toolContext, childInput) => {
            detailCalls += 1;
            expect(childInput).toEqual({ city: "Oslo", forecast: "sunny" });
            return { note: "Clear skies" };
          },
        ],
      ]),
    });
    const [workflowTool] = await engine.available(context);
    if (!workflowTool) throw new Error("Expected an available workflow tool.");
    const replayContext = { ...context, executionKey: "d".repeat(64) };
    const result = await engine.execute(replayContext, workflowTool.name, { city: "Oslo" });
    expect(result).toEqual({ forecast: "sunny", detail: "Clear skies" });
    expect(lookupCalls).toBe(2);
    expect(new Set(idempotencyKeys).size).toBe(1);
    expect(detailCalls).toBe(1);
    expect(stored?.status).toBe("succeeded");
    expect(JSON.stringify(stored)).not.toContain("Oslo");
    expect(JSON.stringify(stored)).not.toContain("sunny");
    await expect(engine.execute(replayContext, workflowTool.name, { city: "Oslo" })).resolves.toEqual(result);
    expect(lookupCalls).toBe(2);
    expect(detailCalls).toBe(1);
  });

  test("requires a per-user grant before exposing or executing a Telegram skill", async () => {
    let allowed = false;
    const permissionOutcomes: string[] = [];
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
      authorizationAudit: {
        recordPermissionDecision: async (input) => {
          permissionOutcomes.push(input.outcome);
        },
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
    expect(permissionOutcomes).toContain("denied");
    allowed = true;
    expect(await engine.available(telegramContext)).toEqual([apiTool]);
    await expect(engine.execute(telegramContext, apiTool.name, { city: "Oslo" })).resolves.toEqual({
      forecast: "sunny",
    });
    expect(permissionOutcomes).toContain("allowed");
    allowed = false;
    await expect(engine.execute(telegramContext, apiTool.name, { city: "Oslo" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(permissionOutcomes.at(-1)).toBe("denied");
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
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
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

  test("publishes validated skills only with the dedicated scope and binds them to the active tenant", async () => {
    const token = await createApiTokenMaterial();
    let scopes = ["bots:read"];
    const principal = {
      tenantId,
      ownerId,
      tokenId: "token_publish",
      get scopes() {
        return scopes;
      },
    };
    const published: unknown[] = [];
    const baseSkills = skillRepository([]);
    const handler = createSkillsApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => undefined, saveDraft: async () => {} },
      {
        ...baseSkills,
        listCatalog: async () => [],
        publishCatalogSkill: async (input) => {
          published.push(input);
        },
      },
      secrets,
    );
    const endpoint = "https://factory.example.test/v1/skills";
    const definition = {
      id: "workspace.instructions.v1",
      name: "Workspace instructions",
      version: "1.0.0",
      author: "Workspace team",
      category: "productivity",
      description: "Adds owner-authored instructions to a bot.",
      executionType: "prompt",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredPermissions: [],
      configuration: { instructions: "Keep answers concise." },
    };
    const headers = { authorization: `Bearer ${token.token}`, "content-type": "application/json" };
    const denied = await handler(new Request(endpoint, { method: "POST", headers, body: JSON.stringify(definition) }));
    expect(denied?.status).toBe(403);
    expect(published).toHaveLength(0);

    scopes = ["skills:publish"];
    const accepted = await handler(
      new Request(endpoint, { method: "POST", headers, body: JSON.stringify(definition) }),
    );
    expect(accepted?.status).toBe(201);
    expect(published).toMatchObject([{ tenantId, definition: { id: definition.id } }]);
    const acceptedBody = (await accepted?.json()) as { skill: Record<string, unknown> };
    expect(acceptedBody.skill).toMatchObject({ id: definition.id, enabled: true });
    expect(acceptedBody.skill).not.toHaveProperty("tenantId");

    const unsupported = await handler(
      new Request(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ ...definition, id: "workspace.native.v1", executionType: "native" }),
      }),
    );
    expect(unsupported?.status).toBe(400);
    expect(published).toHaveLength(1);
  });

  test("rejects workflow publishing when a child is missing or not idempotent", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token_workflow", scopes: ["skills:publish"] };
    const baseSkills = skillRepository([]);
    const handler = createSkillsApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => undefined, saveDraft: async () => {} },
      { ...baseSkills, listCatalog: async () => [], publishCatalogSkill: async () => {} },
      secrets,
    );
    const definition = {
      id: "workspace.workflow.v1",
      name: "Workspace workflow",
      version: "1.0.0",
      author: "Workspace team",
      category: "productivity",
      description: "Combines existing approved tools.",
      executionType: "workflow",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredPermissions: [],
      configuration: { workflow: { steps: [{ id: "first", type: "skill", skillId: "missing.child" }] } },
    };
    const response = await handler(
      new Request("https://factory.example.test/v1/skills", {
        method: "POST",
        headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
        body: JSON.stringify(definition),
      }),
    );
    expect(response?.status).toBe(400);
  });

  test("reports a globally disabled catalog skill as unavailable even when its bot installation remains enabled", async () => {
    const token = await createApiTokenMaterial();
    const principal = { tenantId, ownerId, tokenId: "token_global_disabled", scopes: ["bots:read"] };
    const disabledDefinition = { ...definition, enabled: false };
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
    const handler = createSkillsApiHandler(
      new ApiTokenAuthenticator({
        findActive: async () => principal,
        create: async () => {},
        revoke: async () => {},
        consumeApiRequest: async () => true,
        recordApiMutation: async () => {},
      }),
      { get: async () => bot, saveDraft: async () => {} },
      skillRepository([installation({ definition: disabledDefinition })]),
      secrets,
    );
    const response = await handler(
      new Request(`https://factory.example.test/v1/bots/${botId}/skills`, {
        headers: { authorization: `Bearer ${token.token}` },
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject([{ id: definition.id, enabled: false }]);
  });

  test("requires operator authorization to curate the global catalog and supports disabling entries", async () => {
    const token = "global-catalog-admin-token-".padEnd(48, "g");
    const definition = {
      id: "global.instructions.v1",
      name: "Global instructions",
      version: "1.0.0",
      author: "Platform team",
      category: "productivity",
      description: "Adds reusable platform-reviewed instructions.",
      executionType: "prompt",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: { type: "object", properties: {}, additionalProperties: false },
      requiredPermissions: [],
      configuration: { instructions: "Use the approved shared guidance." },
    };
    const baseSkills = skillRepository([]);
    let published: SkillDefinition | undefined;
    let enabled = true;
    const handler = createGlobalSkillCatalogAdminHandler({
      authorizationToken: token,
      skills: {
        ...baseSkills,
        listGlobalCatalog: async () => (published ? [{ ...published, enabled }] : []),
        publishGlobalCatalogSkill: async (input) => {
          published = { ...input.definition, tenantId: null, enabled: true };
        },
        setGlobalCatalogSkillEnabled: async (skillId, value) => {
          if (!published || published.id !== skillId) throw new Error("missing global skill");
          enabled = value;
        },
      },
    });
    const endpoint = "https://factory.example.test/_operator/skills";
    const denied = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${"x".repeat(48)}`, "content-type": "application/json" },
        body: JSON.stringify(definition),
      }),
    );
    expect(denied?.status).toBe(401);
    expect(published).toBeUndefined();

    const accepted = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(definition),
      }),
    );
    expect(accepted?.status).toBe(201);
    expect(published).toMatchObject({ id: definition.id, tenantId: null });

    const privateChildWorkflow = {
      ...definition,
      id: "global.workflow.v1",
      name: "Global workflow",
      executionType: "workflow",
      configuration: {
        workflow: { steps: [{ id: "private", type: "skill", skillId: "workspace.private.v1" }] },
      },
    };
    const privateChildRejected = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(privateChildWorkflow),
      }),
    );
    expect(privateChildRejected?.status).toBe(400);
    expect(published?.id).toBe(definition.id);

    const disabled = await handler(
      new Request(`${endpoint}/${definition.id}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
    );
    expect(disabled?.status).toBe(200);
    expect(await disabled?.json()).toEqual({ skillId: definition.id, enabled: false });

    const catalog = await handler(new Request(endpoint, { headers: { authorization: `Bearer ${token}` } }));
    expect(await catalog?.json()).toMatchObject([{ id: definition.id, enabled: false }]);
  });
});
